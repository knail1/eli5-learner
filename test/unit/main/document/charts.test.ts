import { describe, expect, it } from 'vitest';
import {
  chartSummary,
  formatValue,
  isHorizontal,
  normalizeChart,
  renderChartFigure,
  renderChartSvg,
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

  it('bars start at zero and nulls leave an empty slot', () => {
    const svg = renderChartSvg(base({ series: [{ name: 'S1', values: [5, null, 7] }] }), 'x');
    expect(marks(svg)).toHaveLength(2);
    expect(svg).toContain('>0</text>'); // zero tick present
    expect(svg).not.toContain('data-label="B"');
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
  const run = (c: ChartSpec): { chart: ChartSpec | null; warnings: string[] } => {
    const warnings: string[] = [];
    return { chart: normalizeChart(c, (w) => warnings.push(w)), warnings };
  };

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

  it('converts pies with negatives or > 6 slices to bars', () => {
    const neg = run(base({ kind: 'pie', series: [{ name: 's', values: [1, -1, 2] }] }));
    expect(neg.chart?.kind).toBe('bar');
    expect(neg.warnings).toContain('pie-converted');
    const many = run(
      base({ kind: 'pie', categories: '1234567'.split(''), series: [{ name: 's', values: [1, 1, 1, 1, 1, 1, 1] }] }),
    );
    expect(many.chart?.kind).toBe('bar');
  });

  it('keeps the first 6 series of line/area/scatter', () => {
    const { chart, warnings } = run(
      base({ kind: 'line', series: Array.from({ length: 8 }, (_, i) => ({ name: `s${i}`, values: [1, 2, 3] })) }),
    );
    expect(chart?.series).toHaveLength(6);
    expect(warnings).toContain('chart-series-capped');
  });
});
