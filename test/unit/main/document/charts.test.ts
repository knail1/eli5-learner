import { describe, expect, it } from 'vitest';
import {
  chartSummary,
  formatValue,
  isHorizontal,
  lineAxis,
  normalizeChart,
  renderChartFigure,
  renderChartSvg,
  stripEmphasis,
  unshout,
  type ChartAsTable,
} from '../../../../src/main/document/charts';
import type { ChartSpec } from '../../../../src/main/llm';

const base = (p: Partial<ChartSpec>): ChartSpec => ({
  kind: 'bar',
  title: 'Paid search returns the most per dollar',
  categories: ['A', 'B', 'C'],
  series: [{ name: 'S1', values: [3, 1, 2] }],
  ...p,
});

const KINDS: ChartSpec['kind'][] = ['bar', 'stacked-bar', 'line', 'area', 'pie', 'scatter'];

function marks(svg: string): string[] {
  return svg.match(/<(rect|circle|path)[^>]*data-value="[^"]*"[^>]*>/g) ?? [];
}

describe('chart rendering (07 §7.2)', () => {
  it.each(KINDS)('%s renders accessible, class-colored SVG with a data table', (kind) => {
    const chart = base({
      kind,
      series: [{ name: 'S1', values: [3, 1, 2] }, ...(kind === 'pie' ? [] : [{ name: 'S2', values: [1, 2, null] }])],
    });
    const html = renderChartFigure(chart, 'sec-indepth-00000000-b0');
    expect(html).toMatch(/^<figure class="chart" data-chart-kind="/);
    expect(html).toContain('role="img" aria-labelledby="sec-indepth-00000000-b0-t sec-indepth-00000000-b0-d"');
    expect(html).toContain('<title id="sec-indepth-00000000-b0-t">Paid search returns the most per dollar</title>');
    expect(html).toContain('<details class="chart-data"><summary>Show data</summary>');
    // Rule 11: color only through classes; never var() in attributes; no gradients or shadows.
    expect(html).not.toMatch(/="[^"]*var\(/);
    expect(html).not.toMatch(/\s(fill|stroke)="(?!none")/);
    expect(html).not.toMatch(/Gradient|filter=/);
    const ms = marks(html);
    expect(ms.length).toBeGreaterThan(0);
    for (const m of ms) {
      expect(m).toMatch(/class="viz-fill-(\d|accent|muted)/);
      expect(m).toContain('tabindex="0"');
      expect(m).toContain('data-label="');
    }
  });

  it('bars start at zero and nulls leave an empty slot marked "No data"', () => {
    const svg = renderChartSvg(base({ series: [{ name: 'S1', values: [5, null, 7] }] }), 'x');
    expect(marks(svg)).toHaveLength(2);
    expect(svg).toContain('>0</text>'); // zero tick present
    expect(svg).not.toMatch(/<rect[^>]*data-label="B"/);
    expect(svg).toContain('data-label="B" data-value="No data"');
  });

  it('switches to horizontal for long labels or > 8 categories and prints value labels when <= 12 bars', () => {
    expect(isHorizontal(base({ categories: ['A very long category name', 'B', 'C'] }))).toBe(true);
    expect(
      isHorizontal(
        base({ categories: 'ABCDEFGHI'.split(''), series: [{ name: 's', values: [1, 2, 3, 4, 5, 6, 7, 8, 9] }] }),
      ),
    ).toBe(true);
    expect(isHorizontal(base({}))).toBe(false);
    const h = renderChartFigure(base({ categories: ['A very long category name', 'B', 'C'] }), 'x');
    expect(h).toContain('data-orient="h"');
    expect(h).toMatch(/viewBox="0 0 640 \d+"/);
    expect(h).toContain('class="viz-ink viz-value"');
  });

  it('highlight gets the accent class, others muted, with a note', () => {
    const svg = renderChartSvg(base({ highlight: { category: 'B', note: 'Look here' } }), 'x');
    expect(svg).toMatch(/class="viz-fill-accent"[^>]*data-label="B"/);
    expect((svg.match(/viz-fill-muted/g) ?? []).length).toBe(2);
    expect(svg).toContain('Look here');
  });

  it.each(['line', 'area'] as const)('%s highlight: accent point, muted lines and points (rule 6)', (kind) => {
    const svg = renderChartSvg(
      base({
        kind,
        series: [
          { name: 'S1', values: [3, 1, 2] },
          { name: 'S2', values: [1, 2, 3] },
        ],
        highlight: { category: 'B', note: 'Look here' },
      }),
      'x',
    );
    const pts = marks(svg);
    expect(pts.filter((m) => m.includes('viz-fill-accent'))).toHaveLength(2);
    expect(pts.filter((m) => m.includes('viz-fill-accent')).every((m) => m.includes('data-label="B'))).toBe(true);
    expect(pts.filter((m) => m.includes('viz-fill-muted'))).toHaveLength(4);
    expect(svg).not.toMatch(/viz-(fill|stroke)-[1-8]/);
    expect(svg).toContain('viz-stroke-muted viz-line');
    expect(svg).toContain('Look here');
  });

  it('pie: largest first, percentages outside', () => {
    const svg = renderChartSvg(
      base({ kind: 'pie', categories: ['Small', 'Big'], series: [{ name: 's', values: [25, 75] }] }),
      'x',
    );
    expect(svg.indexOf('data-label="Big"')).toBeLessThan(svg.indexOf('data-label="Small"'));
    expect(svg).toContain('Big 75%');
    expect(svg).toContain('Small 25%');
  });

  it('lines use direct labels for <= 4 series and a legend above', () => {
    const two = renderChartSvg(
      base({
        kind: 'line',
        series: [
          { name: 'North', values: [1, 2, 3] },
          { name: 'South', values: [2, 1, 0] },
        ],
      }),
      'x',
    );
    expect(two).toContain('viz-direct');
    const five = renderChartSvg(
      base({ kind: 'line', series: [1, 2, 3, 4, 5].map((i) => ({ name: `S${i}`, values: [i, i + 1, i + 2] })) }),
      'x',
    );
    expect(five).not.toContain('viz-direct');
    expect(five).toContain('viz-legend-row');
  });

  it('summarizes for <desc>', () => {
    expect(chartSummary(base({ categories: ['Paid search', 'B'], series: [{ name: 's', values: [4.2, 1] }] }))).toBe(
      'Bar chart, 2 categories, highest: Paid search 4.2',
    );
  });

  it('formats with SI suffixes and units', () => {
    expect(formatValue(1_234_567)).toBe('1.23M');
    expect(formatValue(4.2)).toBe('4.2');
    expect(formatValue(2_500_000_000, '$')).toBe('$2.5B');
    expect(formatValue(-1500, '$')).toBe('−$1.5k');
    expect(formatValue(45, '%')).toBe('45%');
    expect(formatValue(null)).toBe('—');
  });
});

describe('normalizeChart (07 §5.2)', () => {
  const run = (c: ChartSpec): { chart: ChartSpec | null; table?: ChartAsTable['table']; warnings: string[] } => {
    const warnings: string[] = [];
    const r = normalizeChart(c, (w) => warnings.push(w));
    if (r !== null && 'table' in r) return { chart: null, table: r.table, warnings };
    return { chart: r, warnings };
  };
  const series = (k: number, n = 3, f = (i: number, j: number) => (i + 1) * (j + 1)): ChartSpec['series'] =>
    Array.from({ length: k }, (_, i) => ({ name: `s${i}`, values: Array.from({ length: n }, (_, j) => f(i, j)) }));

  it('drops charts whose series length differs from the categories', () => {
    expect(run(base({ series: [{ name: 's', values: [1, 2] }] })).chart).toBeNull();
  });

  it('keeps the top 29 categories by first series and folds the rest into Other', () => {
    const cats = Array.from({ length: 35 }, (_, i) => `c${i}`);
    const { chart, warnings } = run(base({ categories: cats, series: [{ name: 's', values: cats.map((_, i) => i) }] }));
    expect(chart?.categories).toHaveLength(30);
    expect(chart?.categories[29]).toBe('Other');
    expect(chart?.categories[0]).toBe('c6');
    expect(chart?.series[0]?.values[29]).toBe(0 + 1 + 2 + 3 + 4 + 5);
    expect(warnings).toContain('chart-categories-folded');
  });

  it('converts pies with negative values to bars', () => {
    const neg = run(base({ kind: 'pie', series: [{ name: 's', values: [1, -1, 2] }] }));
    expect(neg.chart?.kind).toBe('bar');
    expect(neg.warnings).toContain('pie-converted');
  });

  it('folds the smallest pie slices into Other, keeping at most five', () => {
    const { chart, warnings } = run(
      base({ kind: 'pie', categories: '1234567'.split(''), series: [{ name: 's', values: [7, 1, 6, 2, 5, 3, 4] }] }),
    );
    expect(chart?.kind).toBe('pie');
    expect(chart?.categories).toEqual(['1', '3', '5', '7', 'Other']);
    expect(chart?.series[0]?.values).toEqual([7, 6, 5, 4, 1 + 2 + 3]);
    expect(warnings).toContain('pie-slices-folded');
    expect(run(base({ kind: 'pie', categories: '12345'.split(''), series: series(1, 5) })).chart?.categories).toEqual(
      '12345'.split(''),
    );
  });

  it.each(['line', 'area', 'scatter'] as const)('%s keeps at most four series, the largest first', (kind) => {
    const { chart, warnings } = run(base({ kind, series: series(6) }));
    expect(chart?.series.map((x) => x.name)).toEqual(['s2', 's3', 's4', 's5']);
    expect(chart?.footnote).toBe('2 more series not shown.');
    expect(warnings).toContain('chart-series-capped');
  });

  it('a line series named by the highlight is kept even when small', () => {
    const { chart } = run(base({ kind: 'line', series: series(6), highlight: { category: 's0', note: 'n' } }));
    expect(chart?.series.map((x) => x.name)).toEqual(['s0', 's3', 's4', 's5']);
  });

  it('grouped bars keep the four largest series; stacked bars fold the rest into Other', () => {
    const grouped = run(base({ series: series(6) }));
    expect(grouped.chart?.series.map((x) => x.name)).toEqual(['s2', 's3', 's4', 's5']);
    expect(grouped.warnings).toContain('chart-series-capped');
    const stacked = run(base({ kind: 'stacked-bar', series: series(6) }));
    expect(stacked.chart?.series.map((x) => x.name)).toEqual(['s3', 's4', 's5', 'Other']);
    expect(stacked.chart?.series[3]?.values).toEqual([1 + 2 + 3, 2 + 4 + 6, 3 + 6 + 9]);
    expect(stacked.chart?.footnote).toBeUndefined();
  });

  it('drops a series missing more than 20 % of its values and says so', () => {
    const cats = '0123456789'.split('');
    const sparse = { name: 'Thin', values: [1, null, null, null, 5, 6, 7, 8, 9, 10] };
    const dense = { name: 'Full', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, null] };
    const { chart, warnings } = run(base({ kind: 'line', categories: cats, series: [sparse, dense] }));
    expect(chart?.series.map((x) => x.name)).toEqual(['Full']);
    expect(chart?.footnote).toBe('Thin not shown: too many values are missing. No data for 9.');
    expect(warnings).toContain('chart-series-sparse');
    // Two of ten missing is still charted.
    const two = { name: 'Two', values: [1, null, 3, null, 5, 6, 7, 8, 9, 10] };
    expect(run(base({ kind: 'line', categories: cats, series: [two] })).chart?.series).toHaveLength(1);
    // A single gap in a short series is a gap, not a reason to drop it.
    expect(run(base({ series: [{ name: 's', values: [5, null, 7] }] })).chart?.series).toHaveLength(1);
  });

  it('turns a chart whose every series is too sparse into a table titled by the chart', () => {
    const { chart, table, warnings } = run(
      base({
        unit: '$',
        categories: ['A', 'B', 'C', 'D'],
        series: [{ name: 'Sales', values: [1200, null, null, 4] }],
      }),
    );
    expect(chart).toBeNull();
    expect(table).toEqual({
      caption: 'Paid search returns the most per dollar',
      header: ['Category', 'Sales'],
      rows: [
        ['A', '$1.2k'],
        ['B', 'No data'],
        ['C', 'No data'],
        ['D', '$4'],
      ],
    });
    expect(warnings).toContain('chart-sparse-tabled');
  });

  it('names remaining gaps in the footnote, five at most', () => {
    const cats = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'.split('');
    const values = cats.map((_, i) => (i % 5 === 0 ? null : i));
    const { chart } = run(base({ footnote: 'Survey of 30 firms', categories: cats, series: [{ name: 's', values }] }));
    expect(chart?.footnote).toBe('Survey of 30 firms. No data for A, F, K, P, U and 1 more.');
    expect(run(base({ series: [{ name: 's', values: [1, null, 3] }] })).chart?.footnote).toBe('No data for B.');
  });

  it("order 'value' sorts bars largest first; given order and lines are untouched", () => {
    const c = base({ categories: ['A', 'B', 'C', 'D'], series: [{ name: 's', values: [2, null, 9, 4] }] });
    expect(run({ ...c, order: 'value' }).chart?.categories).toEqual(['C', 'D', 'A', 'B']);
    expect(run({ ...c, order: 'value' }).chart?.series[0]?.values).toEqual([9, 4, 2, null]);
    expect(run(c).chart?.categories).toEqual(['A', 'B', 'C', 'D']);
    expect(run({ ...c, kind: 'line', order: 'value' }).chart?.categories).toEqual(['A', 'B', 'C', 'D']);
    const stacked = run({
      ...c,
      kind: 'stacked-bar',
      order: 'value',
      series: [
        { name: 'x', values: [1, 5, 1, 1] },
        { name: 'y', values: [1, 5, 1, 9] },
      ],
    });
    expect(stacked.chart?.categories).toEqual(['B', 'D', 'A', 'C']);
  });

  it('keeps up to three annotations on known categories, text at most 80 characters', () => {
    const { chart, warnings } = run(
      base({
        annotations: [
          { category: 'A', text: 'x'.repeat(100) },
          { category: 'Nope', text: 'unknown category' },
          { category: 'A', text: 'second note on A' },
          { category: 'B', text: '**Peak**' },
          { category: 'C', text: '' },
          { category: 'C', text: 'third' },
        ],
      }),
    );
    expect(chart?.annotations).toEqual([
      { category: 'A', text: `${'x'.repeat(79)}…` },
      { category: 'B', text: 'Peak' },
      { category: 'C', text: 'third' },
    ]);
    expect(warnings).toContain('chart-annotations-dropped');
    expect(run(base({ annotations: [{ category: 'Z', text: 'gone' }] })).chart).not.toHaveProperty('annotations');
  });

  it('caps the model footnote at 200 characters', () => {
    expect(run(base({ footnote: 'n'.repeat(250) })).chart?.footnote).toHaveLength(200);
  });

  it('strips emphasis and shouting from every chart text, keeping categories and references in step', () => {
    const { chart } = run(
      base({
        title: 'REVENUE GREW FASTEST IN ASIA',
        subtitle: '**Quarterly** revenue, _USD_',
        xLabel: 'SALES REGION NAME',
        categories: ['NORTH AMERICA', 'Asia', 'EU'],
        series: [{ name: 'TOTAL REVENUE', values: [1, 2, 3] }],
        highlight: { category: 'NORTH AMERICA', note: '***Largest market***' },
        annotations: [{ category: 'NORTH AMERICA', text: 'Note' }],
      }),
    );
    expect(chart?.title).toBe('Revenue grew fastest in asia');
    expect(chart?.subtitle).toBe('Quarterly revenue, USD');
    expect(chart?.xLabel).toBe('Sales region name');
    expect(chart?.categories).toEqual(['North america', 'Asia', 'EU']);
    expect(chart?.series[0]?.name).toBe('Total revenue');
    expect(chart?.highlight).toEqual({ category: 'North america', note: 'Largest market' });
    expect(chart?.annotations).toEqual([{ category: 'North america', text: 'Note' }]);
  });
});

describe('chart text rules (07 §7.2 rule 13)', () => {
  it.each([
    ['REVENUE GREW 40% IN 2024', 'Revenue grew 40% in 2024'],
    ['GDP GROWTH SLOWED IN THE EU', 'GDP growth slowed in the EU'],
    ['WHY MCMC MIXING MATTERS', 'Why MCMC mixing matters'],
    ['Why GDP MATTERS FOR EVERYONE', 'Why GDP matters for everyone'],
    ['NASA and ESA budgets', 'NASA and ESA budgets'],
    ['Paid search returns the most', 'Paid search returns the most'],
    ['ONE SHOUTED', 'ONE SHOUTED'],
    ['Q3 SALES ROSE', 'Q3 sales rose'],
  ])('%s -> %s', (input, out) => {
    expect(unshout(input)).toBe(out);
  });

  it.each([
    ['**Bold** and *italic*', 'Bold and italic'],
    ['***both*** at once', 'both at once'],
    ['__strong__ and _em_', 'strong and em'],
    ['snake_case_name stays', 'snake_case_name stays'],
    ['2 * 3 * 4 = 24', '2 * 3 * 4 = 24'],
  ])('%s -> %s', (input, out) => {
    expect(stripEmphasis(input)).toBe(out);
  });
});

describe('Wong layout rules (07 §7.2)', () => {
  const rects = (svg: string): { x: number; w: number }[] =>
    [...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"[^>]*data-value/g)].map((m) => ({
      x: Number(m[1]),
      w: Number(m[2]),
    }));

  it('bars are about twice as wide as the gaps between them', () => {
    const r = rects(renderChartSvg(base({ categories: ['A', 'B', 'C', 'D'], series: [series4()] }), 'x'));
    expect(r).toHaveLength(4);
    const gap = (r[1]?.x ?? 0) - ((r[0]?.x ?? 0) + (r[0]?.w ?? 0));
    expect((r[0]?.w ?? 0) / gap).toBeCloseTo(2, 1);
  });

  it.each(KINDS)('%s labels are horizontal: no rotate( in chart SVG', (kind) => {
    const cats = Array.from({ length: 24 }, (_, i) => `Category number ${i}`);
    const html = renderChartFigure(
      base({ kind, categories: cats, series: [{ name: 's', values: cats.map((_, i) => i + 1) }] }),
      'x',
    );
    expect(html).not.toContain('rotate(');
  });

  const line = (values: (number | null)[], kind: ChartSpec['kind'] = 'line'): ChartSpec =>
    base({ kind, categories: values.map((_, i) => `${2020 + i}`), series: [{ name: 's', values }] });

  it('a line starts at zero when min <= half of max, with no axis break', () => {
    const c = line([40, 55, 90]);
    expect(lineAxis(c)).toMatchObject({ broken: false, nice: { domain: [0, 100] } });
    const html = renderChartFigure(c, 'x');
    expect(html).not.toContain('viz-axis-break');
    expect(html).not.toContain('does not start at zero');
  });

  it('a line far from zero fills about two thirds of the plot, with a break mark and a footnote', () => {
    const c = line([96, 99, 101, 104]);
    const { nice, broken } = lineAxis(c);
    expect(broken).toBe(true);
    expect(nice.domain[0]).toBeGreaterThan(0);
    const fill = (104 - 96) / (nice.domain[1] - nice.domain[0]);
    expect(fill).toBeGreaterThanOrEqual(0.5);
    expect(fill).toBeLessThanOrEqual(0.85);
    const html = renderChartFigure({ ...c, footnote: 'Index, 2020 = 100.' }, 'x');
    expect(html.match(/viz-axis-break/g)).toHaveLength(2); // regular and compact SVG
    expect(html).toContain(
      '<p class="chart-foot">Note: Index, 2020 = 100. The vertical axis does not start at zero.</p>',
    );
    // The model's own text is never rewritten for this.
    expect(html).toContain('<h3 class="chart-title">Paid search returns the most per dollar</h3>');
  });

  it('areas and bars always start at zero; a line crossing zero has no break', () => {
    expect(lineAxis(line([96, 99, 104], 'area')).nice.domain[0]).toBe(0);
    expect(renderChartSvg(base({ series: [{ name: 's', values: [96, 99, 104] }] }), 'x')).toContain('>0</text>');
    expect(lineAxis(line([-5, 3, 8])).broken).toBe(false);
    expect(lineAxis(line([-96, -99, -104])).broken).toBe(true);
    expect(lineAxis(line([5, 5, 5])).broken).toBe(false);
  });

  it('annotations mark their category label and print under the plot', () => {
    const c = base({
      annotations: [
        { category: 'A', text: 'Launch month' },
        { category: 'C', text: 'Price cut' },
      ],
    });
    const html = renderChartFigure(c, 'x');
    expect(html).toContain('>A ¹</text>');
    expect(html).toContain('>C ²</text>');
    expect(html).toContain(
      '<p class="chart-foot chart-ann"><span class="chart-ann-mark" aria-hidden="true">¹</span> A: Launch month</p>',
    );
    expect(html.indexOf('chart-ann')).toBeLessThan(html.indexOf('chart-data'));
    const many = Array.from({ length: 20 }, (_, i) => `${2000 + i}`);
    const lineHtml = renderChartSvg(
      base({
        kind: 'line',
        categories: many,
        series: [{ name: 's', values: many.map((_, i) => i) }],
        annotations: [{ category: '2007', text: 'Crisis' }],
      }),
      'x',
    );
    // A thinned-out axis still labels the annotated year.
    expect(lineHtml).toContain('>2007 ¹</text>');
  });

  it('a single series uses the first palette colour', () => {
    expect(renderChartSvg(base({}), 'x')).toMatch(/<rect[^>]*class="viz-fill-1"/);
  });
});

function series4(): ChartSpec['series'][number] {
  return { name: 's', values: [4, 3, 2, 1] };
}
