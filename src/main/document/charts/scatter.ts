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
  niceScale,
  r2,
  seriesClass,
  truncate,
} from './common';
import { NOTE_ROW, noteAbove } from './annotate';

export function renderScatter(chart: ChartSpec, W: number = CHART_WIDTH): { body: string; height: number } {
  const height = 320;
  const leg =
    chart.series.length > 1
      ? legend(
          chart.series.map((s) => s.name),
          4,
          0,
          W,
        )
      : { svg: '', height: 0 };
  // Rule 6: a band above the plot is reserved for the highlight note.
  const noteTop = leg.height + (chart.yLabel ? 30 : 12);
  const top = noteTop + (chart.highlight ? NOTE_ROW : 0);
  const bottom = chart.xLabel ? 46 : 28;
  const left = 44;
  const right = 16;
  const numeric =
    chart.categories.length > 0 && chart.categories.every((c) => c.trim() !== '' && Number.isFinite(Number(c)));
  // Rule 2: nice extents that contain every point on both axes.
  const ny = niceScale(minOf(allValues(chart)) ?? 0, maxOf(allValues(chart)) ?? 1, 6);
  const y = scaleLinear()
    .domain(ny.domain)
    .range([height - bottom, top]);
  let xp: (i: number) => number;
  let body = leg.svg;
  if (numeric) {
    const xs = chart.categories.map(Number);
    const nx = niceScale(Math.min(...xs), Math.max(...xs), W < CHART_WIDTH ? 4 : 6);
    const x = scaleLinear()
      .domain(nx.domain)
      .range([left + 8, W - right]);
    xp = (i) => x(xs[i] ?? 0);
    for (const t of nx.ticks) {
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
      .range([left + 8, W - right])
      .padding(0.5);
    xp = (i) => x(i) ?? left;
    const every = Math.max(1, Math.ceil((chart.categories.length * 64) / (W - left - right)));
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
  for (const t of ny.ticks) {
    body += el('line', [
      ['x1', left],
      ['x2', W - right],
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
  const dots: { cx: number; cy: number; r: number; hl: boolean }[] = [];
  chart.series.forEach((s, si) => {
    s.values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) return;
      const hl = chart.highlight?.category === chart.categories[i];
      dots.push({ cx: xp(i), cy: y(v), r: hl ? 6 : 4.5, hl });
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
  if (chart.highlight && hl >= 0 && dots.some((d) => d.hl)) {
    // The leader drops straight down at the highlighted x to the topmost dot in its path. When that
    // dot is not a highlighted one (dense or duplicate x), a leader would cross it: the accent
    // alone marks the point and the note stands without a leader.
    const lx = xp(hl);
    const inPath = dots.filter((d) => Math.abs(d.cx - lx) < d.r + 1);
    const topDot = inPath.reduce<(typeof dots)[number] | undefined>(
      (a, d) => (a && a.cy - a.r <= d.cy - d.r ? a : d),
      undefined,
    );
    const targetY = topDot?.hl ? topDot.cy - topDot.r - 3 : -Infinity;
    body += noteAbove(chart.highlight.note, lx, noteTop, targetY, W);
  }
  if (chart.xLabel) {
    body += el(
      'text',
      [
        ['x', r2((left + W - right) / 2)],
        ['y', height - 8],
        ['text-anchor', 'middle'],
        ['class', 'viz-ink viz-axis-title'],
      ],
      escSvg(chart.xLabel),
    );
  }
  return { body, height };
}
