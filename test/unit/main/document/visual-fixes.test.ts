// Renderer rules added after the visual review (13 §7.4): nice chart axes, the compact chart layout,
// "No data" marks, annotation marker layout, and reference labels.
import { describe, expect, it } from 'vitest';
import { chartSummary, niceScale, renderChartFigure, renderChartSvg } from '../../../../src/main/document/charts';
import { layoutMarkers } from '../../../../src/main/document/render/blocks';
import { readableUrl, renderReferencesBody } from '../../../../src/main/document/render/references';
import type { ChartSpec } from '../../../../src/main/llm';

describe('niceScale (07 §7.2 rule 2)', () => {
  it.each([
    // lo, hi, count, zero -> domain, step
    [0, 4.2, 6, true, [0, 5], 1],
    [2.8, 4.5, 6, false, [2.5, 4.5], 0.5],
    [5, 25, 6, false, [5, 25], 5],
    [120_000, 230_000, 6, true, [0, 250_000], 50_000],
    [5000, 19_000, 6, false, [5000, 20_000], 2500],
    [-3.2, 7.9, 5, true, [-5, 10], 5],
    [0.12, 0.47, 5, false, [0.1, 0.5], 0.1],
  ] as const)('%s..%s -> nice domain containing the data', (lo, hi, count, zero, domain, step) => {
    const s = niceScale(lo, hi, count, zero);
    expect(s.domain).toEqual(domain);
    expect(s.step).toBe(step);
  });

  it('always contains the data (and 0 when asked), ticks at whole steps from end to end', () => {
    const cases: [number, number][] = [
      [0.001, 0.0093],
      [-17, -2],
      [1e6, 1.23e7],
      [99, 101],
      [3.3, 3.31],
      [-0.4, 0.4],
    ];
    for (const [lo, hi] of cases) {
      for (const zero of [false, true]) {
        const s = niceScale(lo, hi, 6, zero);
        const [a, b] = s.domain;
        expect(a, `${lo}..${hi}`).toBeLessThanOrEqual(lo);
        expect(b, `${lo}..${hi}`).toBeGreaterThanOrEqual(hi);
        if (zero) expect(a <= 0 && b >= 0).toBe(true);
        expect(s.ticks[0]).toBe(a);
        expect(s.ticks.at(-1)).toBe(b);
        expect(s.ticks.length - 1).toBeLessThanOrEqual(7);
        for (let i = 1; i < s.ticks.length; i++) {
          expect((s.ticks[i] ?? 0) - (s.ticks[i - 1] ?? 0)).toBeCloseTo(s.step, 9);
        }
        expect([1, 2, 2.5, 5, 10]).toContain(Number((s.step / 10 ** Math.floor(Math.log10(s.step))).toFixed(6)));
      }
    }
  });

  it('handles a flat series', () => {
    expect(niceScale(4, 4, 6, true).domain).toEqual([0, 4]);
    expect(niceScale(0, 0, 6).domain).toEqual([-1, 1]);
    const s = niceScale(50, 50, 6);
    expect(s.domain[0]).toBeLessThan(50);
    expect(s.domain[1]).toBeGreaterThan(50);
  });
});

const bar = (p: Partial<ChartSpec> = {}): ChartSpec => ({
  kind: 'bar',
  title: 'Paid search returns the most per dollar',
  categories: ['Paid search', 'Social', 'Email', 'Display', 'Affiliate'],
  series: [{ name: 'ROAS', values: [4.2, 1.8, 3.1, 0.9, null] }],
  ...p,
});

const ticks = (svg: string): string[] => [...svg.matchAll(/class="viz-ink viz-tick">([^<]*)</g)].map((m) => m[1] ?? '');

describe('chart axes and missing values (07 §7.2 rules 2, 8)', () => {
  it('the top gridline sits at or above the tallest bar', () => {
    expect(ticks(renderChartSvg(bar(), 'x'))).toEqual(['0', '1', '2', '3', '4', '5']);
  });

  it('a missing bar says "No data", focusable with tooltip data, and the summary names it', () => {
    const svg = renderChartSvg(bar(), 'x');
    expect(svg).toMatch(
      /<text [^>]*class="viz-ink viz-nodata" data-label="Affiliate" data-value="No data" tabindex="0">No data<\/text>/,
    );
    expect(chartSummary(bar())).toBe('Bar chart, 5 categories, highest: Paid search 4.2, no data: Affiliate');
    expect(renderChartFigure(bar(), 'x')).toContain('<td class="num nodata">No data</td>');
    const multi = bar({
      categories: ['A', 'B'],
      series: [
        { name: 'S1', values: [1, null] },
        { name: 'S2', values: [2, 3] },
      ],
    });
    expect(chartSummary(multi)).toContain('no data: B · S1');
    expect(renderChartSvg(multi, 'x')).toContain('data-label="B · S1" data-value="No data"');
  });

  it('a stacked category is "No data" only when every series is missing', () => {
    const svg = renderChartSvg(
      bar({
        kind: 'stacked-bar',
        categories: ['A', 'B', 'C'],
        series: [
          { name: 'S1', values: [1, null, null] },
          { name: 'S2', values: [2, 3, null] },
        ],
      }),
      'x',
    );
    expect(svg.match(/viz-nodata/g)).toHaveLength(1);
    expect(svg).toContain('data-label="C" data-value="No data"');
  });
});

describe('compact chart layout (07 §7.2 rule 12)', () => {
  it('every chart figure carries a regular and a compact SVG with their own ids', () => {
    const html = renderChartFigure(bar(), 'b0');
    expect(html.match(/<svg /g)).toHaveLength(2);
    expect(html).toContain('viewBox="0 0 640 ');
    expect(html).toContain('viewBox="0 0 380 ');
    expect(html).toContain('class="viz viz--compact"');
    expect(html).toContain('aria-labelledby="b0-c-t b0-c-d"');
    expect(html).toContain('aria-labelledby="b0-t b0-d"');
  });

  it('compact bars go horizontal when a category label would not fit under its bar', () => {
    const compact = renderChartSvg(bar(), 'x', 380);
    // Horizontal: labels right-aligned in a left column, no y tick labels.
    expect(compact).toMatch(/text-anchor="end" class="viz-ink viz-cat">Paid search</);
    expect(ticks(compact)).toEqual([]);
    const short = renderChartSvg(
      bar({ categories: ['A', 'B', 'C'], series: [{ name: 's', values: [1, 2, 3] }] }),
      'x',
      380,
    );
    expect(short).toMatch(/text-anchor="middle" class="viz-ink viz-cat">A</);
  });

  it('keeps every mark inside the compact viewBox', () => {
    for (const kind of ['bar', 'line', 'area', 'scatter', 'pie', 'stacked-bar'] as const) {
      const svg = renderChartSvg(bar({ kind, series: [{ name: 'ROAS', values: [4.2, 1.8, 3.1, 0.9, 2] }] }), 'x', 380);
      for (const m of svg.matchAll(/<(?:rect|circle)[^>]*?(?:x|cx)="([\d.-]+)"/g)) {
        expect(Number(m[1])).toBeLessThanOrEqual(380);
        expect(Number(m[1])).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('annotation markers (07 §7.1 figure)', () => {
  it('scales with the image and keeps a legible minimum', () => {
    expect(layoutMarkers([{ x: 0.5, y: 0.5 }], 1200, 800).size).toBe(24);
    expect(layoutMarkers([{ x: 0.5, y: 0.5 }], 64, 40).size).toBe(18);
    expect(layoutMarkers([{ x: 0.5, y: 0.5 }], 20, 10).size).toBe(18);
  });

  it('keeps centers inside the image', () => {
    const { points } = layoutMarkers([{ x: 0, y: 0 }], 64, 40);
    expect(points[0]).toEqual({ left: 14.06, top: 22.5 }); // 9 px in from each edge
  });

  it('pushes overlapping markers apart, deterministically and in order', () => {
    const anns = [
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.52, y: 0.5 },
    ];
    const a = layoutMarkers(anns, 400, 300);
    expect(layoutMarkers(anns, 400, 300)).toEqual(a);
    const px = a.points.map((p) => ({ x: (p.left / 100) * 400, y: (p.top / 100) * 300 }));
    expect(px[0]).toEqual({ x: 200, y: 150 }); // the first marker never moves
    for (let i = 0; i < px.length; i++) {
      for (let j = i + 1; j < px.length; j++) {
        const d = Math.hypot((px[i]?.x ?? 0) - (px[j]?.x ?? 0), (px[i]?.y ?? 0) - (px[j]?.y ?? 0));
        expect(d, `${i}-${j}`).toBeGreaterThanOrEqual(a.size + 1.9);
      }
    }
    // Far-apart markers stay where the model put them.
    expect(
      layoutMarkers(
        [
          { x: 0.2, y: 0.3 },
          { x: 0.7, y: 0.6 },
        ],
        400,
        300,
      ).points,
    ).toEqual([
      { left: 20, top: 30 },
      { left: 70, top: 60 },
    ]);
  });
});

describe('reference labels (07 §10)', () => {
  it('reads a URL as host and path', () => {
    expect(readableUrl('https://www.example.com/widgets/pricing?x=1#top')).toBe('www.example.com/widgets/pricing');
    expect(readableUrl('https://portal.example.com/')).toBe('portal.example.com');
  });

  it('shows an address-only label once, readable, with the full URL as its title', () => {
    const html = renderReferencesBody([
      {
        status: 'skipped',
        kind: 'url',
        label: 'portal.example.com/login',
        href: 'https://portal.example.com/login',
        reason: 'Page required login.',
      },
      { status: 'used', kind: 'url', label: 'https://www.example.com/a/', href: 'https://www.example.com/a/' },
    ]);
    expect(html).not.toContain('ref-url');
    expect(html.match(/portal\.example\.com\/login</g)).toHaveLength(1);
    expect(html).toContain(
      '<a class="ref-label" href="https://portal.example.com/login" title="https://portal.example.com/login" target="_blank" rel="noopener noreferrer">portal.example.com/login</a>',
    );
    expect(html).toContain('>www.example.com/a/</a>');
  });

  it('a titled source links its title and names the address once, subtly', () => {
    const html = renderReferencesBody([
      {
        status: 'used',
        kind: 'url',
        label: 'Example Widgets Inc. pricing',
        href: 'https://www.example.com/widgets/pricing',
        detail: 'Fetched page',
      },
    ]);
    expect(html).toContain(
      '>Example Widgets Inc. pricing</a> <span class="ref-url">www.example.com/widgets/pricing</span>',
    );
    expect(html).toContain('title="https://www.example.com/widgets/pricing"');
  });
});
