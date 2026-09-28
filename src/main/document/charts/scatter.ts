// Scatter charts (07 §7.2). ChartSpec has no numeric x field, so x is the category parsed as a
// number when every category is numeric, otherwise the category position.
import { scaleLinear, scalePoint } from 'd3-scale';
import type { ChartSpec } from '../../llm';
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
  truncate,
} from './common';
import { NOTE_ROW, noteAbove } from './annotate';

export function renderScatter(chart: ChartSpec): { body: string; height: number } {
  const height = 320;
  const leg =
    chart.series.length > 1
      ? legend(
          chart.series.map((s) => s.name),
          4,
          0,
        )
      : { svg: '', height: 0 };
  // Rule 6: a band above the plot is reserved for the highlight note.
  const noteTop = leg.height + (chart.yLabel ? 22 : 12);
  const top = noteTop + (chart.highlight ? NOTE_ROW : 0);
  const bottom = chart.xLabel ? 46 : 28;
  const left = 44;
  const right = 16;
  const numeric =
    chart.categories.length > 0 && chart.categories.every((c) => c.trim() !== '' && Number.isFinite(Number(c)));
  let lo = minOf(allValues(chart)) ?? 0;
  let hi = maxOf(allValues(chart)) ?? 1;
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const y = scaleLinear()
    .domain([lo, hi])
    .nice()
    .range([height - bottom, top]);
  let xp: (i: number) => number;
  let body = leg.svg;
  if (numeric) {
    const xs = chart.categories.map(Number);
    let xlo = Math.min(...xs);
    let xhi = Math.max(...xs);
    if (xlo === xhi) {
      xlo -= 1;
      xhi += 1;
    }
    const x = scaleLinear()
      .domain([xlo, xhi])
      .nice()
      .range([left + 8, CHART_WIDTH - right]);
    xp = (i) => x(xs[i] ?? 0);
    for (const t of x.ticks(6)) {
      body += el(
        'text',
        [
          ['x', r2(x(t))],
          ['y', height - bottom + 16],
          ['text-anchor', 'middle'],
          ['class', 'viz-ink viz-cat'],
        ],
        escSvg(formatValue(t)),
      );
    }
  } else {
    const x = scalePoint<number>()
      .domain(chart.categories.map((_, i) => i))
      .range([left + 8, CHART_WIDTH - right])
      .padding(0.5);
    xp = (i) => x(i) ?? left;
    const every = Math.max(1, Math.ceil((chart.categories.length * 64) / (CHART_WIDTH - left - right)));
    chart.categories.forEach((c, i) => {
      if (i % every !== 0) return;
      body += el(
        'text',
        [
          ['x', r2(xp(i))],
          ['y', height - bottom + 16],
          ['text-anchor', 'middle'],
          ['class', 'viz-ink viz-cat'],
        ],
        escSvg(truncate(c, 12)),
      );
    });
  }
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
      ['class', 'viz-grid'],
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
  chart.series.forEach((s, si) => {
    s.values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) return;
      const hl = chart.highlight?.category === chart.categories[i];
      body += el('circle', [
        ['cx', r2(xp(i))],
        ['cy', r2(y(v))],
        ['r', hl ? 6 : 4.5],
        ['class', `${hl ? 'viz-fill-accent' : seriesClass('fill', si)} viz-dot`],
        ...markAttrs(markLabel(chart, chart.categories[i] ?? '', si), formatValue(v, chart.unit)),
      ]);
    });
  });
  const hl = chart.highlight ? chart.categories.indexOf(chart.highlight.category) : -1;
  const hv = hl >= 0 ? maxOf(chart.series.map((s) => s.values[hl] ?? null)) : undefined;
  if (chart.highlight && hv !== undefined) {
    // The leader stops above the highest highlighted point (radius 6).
    body += noteAbove(chart.highlight.note, xp(hl), noteTop, y(hv) - 9);
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
