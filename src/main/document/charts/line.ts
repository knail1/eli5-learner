// Line and area charts (07 §7.2 rules 2, 3, 4, 8, 10): nice y extent (area from 0), gaps at nulls,
// direct labels at line ends for <= 4 series, otherwise a compact legend.
import { scalePoint, scaleLinear } from 'd3-scale';
import { area, line } from 'd3-shape';
import type { ChartSpec } from '../../llm';
import { annotation } from './bar';
import {
  CHART_WIDTH,
  allValues,
  el,
  escSvg,
  formatValue,
  legend,
  markAttrs,
  markLabel,
  maxOf,
  minOf,
  r2,
  seriesClass,
  textWidth,
  truncate,
} from './common';

export function renderLine(chart: ChartSpec): { body: string; height: number } {
  const isArea = chart.kind === 'area';
  const height = 320;
  const direct = chart.series.length > 1 && chart.series.length <= 4;
  const leg =
    chart.series.length > 4
      ? legend(
          chart.series.map((s) => s.name),
          4,
          0,
        )
      : { svg: '', height: 0 };
  const top = leg.height + (chart.yLabel ? 22 : 12);
  const bottom = chart.xLabel ? 46 : 28;
  const left = 44;
  const right = direct
    ? Math.min(140, Math.max(...chart.series.map((s) => textWidth(truncate(s.name, 18), 12))) + 14)
    : 16;
  const vals = allValues(chart);
  let lo = minOf(vals) ?? 0;
  let hi = maxOf(vals) ?? 1;
  if (isArea) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  if (lo === hi) hi = lo + 1;
  const y = scaleLinear()
    .domain([lo, hi])
    .nice()
    .range([height - bottom, top]);
  const x = scalePoint<number>()
    .domain(chart.categories.map((_, i) => i))
    .range([left + 8, CHART_WIDTH - right])
    .padding(0);
  const xp = (i: number): number => x(i) ?? left;

  let body = leg.svg;
  if (chart.yLabel) {
    body += el(
      'text',
      [
        ['x', 0],
        ['y', leg.height + 12],
        ['class', 'viz-ink viz-axis-title'],
      ],
      escSvg(chart.yLabel),
    );
  }
  for (const t of y.ticks(5)) {
    body += el('line', [
      ['x1', left],
      ['x2', CHART_WIDTH - right],
      ['y1', r2(y(t))],
      ['y2', r2(y(t))],
      ['class', t === 0 ? 'viz-axis' : 'viz-grid'],
    ]);
    body += el(
      'text',
      [
        ['x', left - 6],
        ['y', r2(y(t) + 4)],
        ['text-anchor', 'end'],
        ['class', 'viz-ink viz-tick'],
      ],
      escSvg(formatValue(t, chart.unit)),
    );
  }
  // Thin out category labels so they do not collide.
  const n = chart.categories.length;
  const every = Math.max(1, Math.ceil((n * 64) / (CHART_WIDTH - right - left)));
  chart.categories.forEach((c, i) => {
    if (i % every !== 0 && i !== n - 1) return;
    body += el(
      'text',
      [
        ['x', r2(xp(i))],
        ['y', height - bottom + 16],
        ['text-anchor', i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'],
        ['class', 'viz-ink viz-cat'],
      ],
      escSvg(truncate(c, 12)),
    );
  });

  type Pt = [number, number | null];
  chart.series.forEach((s, si) => {
    const pts: Pt[] = s.values.map((v, i) => [i, v]);
    const defined = (p: Pt): boolean => p[1] !== null && Number.isFinite(p[1]);
    if (isArea) {
      const a = area<Pt>()
        .defined(defined)
        .x((p) => r2(xp(p[0])))
        .y0(r2(y(0)))
        .y1((p) => r2(y(p[1] ?? 0)));
      body += el('path', [
        ['d', a(pts) ?? ''],
        ['class', `${seriesClass('fill', si)} viz-area`],
      ]);
    }
    const l = line<Pt>()
      .defined(defined)
      .x((p) => r2(xp(p[0])))
      .y((p) => r2(y(p[1] ?? 0)));
    body += el('path', [
      ['d', l(pts) ?? ''],
      ['fill', 'none'],
      ['class', `${seriesClass('stroke', si)} viz-line`],
    ]);
    s.values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) return;
      body += el('circle', [
        ['cx', r2(xp(i))],
        ['cy', r2(y(v))],
        ['r', n > 24 ? 2 : 3.5],
        ['class', seriesClass('fill', si)],
        ...markAttrs(markLabel(chart, chart.categories[i] ?? '', si), formatValue(v, chart.unit)),
      ]);
    });
    if (direct) {
      let last = -1;
      s.values.forEach((v, i) => {
        if (v !== null && Number.isFinite(v)) last = i;
      });
      const lv = last >= 0 ? s.values[last] : null;
      if (lv !== null && lv !== undefined) {
        body += el(
          'text',
          [
            ['x', r2(xp(last) + 6)],
            ['y', r2(y(lv) + 4)],
            ['class', `${seriesClass('fill', si)} viz-direct`],
          ],
          escSvg(truncate(s.name, 18)),
        );
      }
    }
  });
  if (chart.highlight) {
    const ci = chart.categories.indexOf(chart.highlight.category);
    const v = ci >= 0 ? maxOf(chart.series.map((s) => s.values[ci] ?? null)) : undefined;
    if (ci >= 0 && v !== undefined) body += annotation(xp(ci), y(v) - 6, chart.highlight.note, 'v', top);
  }
  if (chart.xLabel) {
    body += el(
      'text',
      [
        ['x', r2((left + CHART_WIDTH - right) / 2)],
        ['y', height - 8],
        ['text-anchor', 'middle'],
        ['class', 'viz-ink viz-axis-title'],
      ],
      escSvg(chart.xLabel),
    );
  }
  return { body, height };
}
