// Bar and stacked-bar charts (07 §7.2 rules 2, 3, 5, 6, 8, 10).
import { scaleBand, scaleLinear } from 'd3-scale';
import type { ChartSpec } from '../../llm';
import {
  CHART_WIDTH,
  NO_DATA,
  el,
  escSvg,
  formatValue,
  legend,
  markAttrs,
  markLabel,
  maxOf,
  minOf,
  niceScale,
  noDataMark,
  r2,
  seriesClass,
  textWidth,
  truncate,
} from './common';
import { NOTE_BELOW, NOTE_ROW, noteAbove, noteBelow } from './annotate';

/** Left margin of a vertical bar chart (tick labels). */
const V_LEFT = 44;

/**
 * Horizontal when any category label exceeds 14 characters or there are more than 8 (rule 5); in a
 * narrower layout (rule 12) also when a category label would not fit under its bar.
 */
export function isHorizontal(chart: ChartSpec, W: number = CHART_WIDTH): boolean {
  if (chart.categories.length > 8 || chart.categories.some((c) => c.length > 14)) return true;
  if (W >= CHART_WIDTH) return false;
  const slot = (W - 8 - V_LEFT) / Math.max(1, chart.categories.length);
  return chart.categories.some((c) => textWidth(c, 12) > slot - 4);
}

/** Categories and series with no value (rule 8), in category order. */
function missing(chart: ChartSpec, stacked: boolean): { ci: number; si: number }[] {
  const out: { ci: number; si: number }[] = [];
  const isNull = (v: number | null | undefined): boolean => v === null || v === undefined || !Number.isFinite(v);
  chart.categories.forEach((_, ci) => {
    if (stacked) {
      if (chart.series.every((s) => isNull(s.values[ci]))) out.push({ ci, si: -1 });
      return;
    }
    chart.series.forEach((s, si) => {
      if (isNull(s.values[ci])) out.push({ ci, si });
    });
  });
  return out;
}

interface BarMark {
  ci: number;
  si: number;
  v0: number;
  v1: number;
  value: number;
}

function marks(chart: ChartSpec, stacked: boolean): BarMark[] {
  const out: BarMark[] = [];
  chart.categories.forEach((_, ci) => {
    let pos = 0;
    let neg = 0;
    chart.series.forEach((s, si) => {
      const v = s.values[ci];
      if (v === null || v === undefined || !Number.isFinite(v)) return; // null leaves an empty slot (rule 8)
      if (!stacked) out.push({ ci, si, v0: 0, v1: v, value: v });
      else if (v >= 0) out.push({ ci, si, v0: pos, v1: (pos += v), value: v });
      else out.push({ ci, si, v0: neg, v1: (neg += v), value: v });
    });
  });
  return out;
}

function markClass(chart: ChartSpec, m: BarMark): string {
  if (chart.highlight) {
    return chart.categories[m.ci] === chart.highlight.category ? 'viz-fill-accent' : 'viz-fill-muted';
  }
  return seriesClass('fill', m.si);
}

export function renderBar(chart: ChartSpec, W: number = CHART_WIDTH): { body: string; height: number } {
  const stacked = chart.kind === 'stacked-bar';
  const ms = marks(chart, stacked);
  const gaps = missing(chart, stacked);
  const lo = Math.min(0, minOf(ms.map((m) => Math.min(m.v0, m.v1))) ?? 0);
  const hi = Math.max(0, maxOf(ms.map((m) => Math.max(m.v0, m.v1))) ?? 0);
  const multi = chart.series.length > 1;
  const gapLabel = (ci: number, si: number): string =>
    si < 0 ? (chart.categories[ci] ?? '') : markLabel(chart, chart.categories[ci] ?? '', si);
  const showValues = ms.length <= 12 && !stacked; // rule 5
  const leg =
    multi && !chart.highlight
      ? legend(
          chart.series.map((s) => s.name),
          4,
          0,
          W,
        )
      : { svg: '', height: 0 };
  const top = leg.height + (chart.yLabel ? 30 : 10);
  const yLabel = chart.yLabel
    ? el(
        'text',
        [
          ['x', 0],
          ['y', leg.height + 12],
          ['class', 'viz-ink viz-axis-title'],
        ],
        escSvg(chart.yLabel),
      )
    : '';

  if (isHorizontal(chart, W)) {
    const maxChars = W < CHART_WIDTH ? 18 : 34;
    const labelW = Math.min(
      W < CHART_WIDTH ? 130 : 220,
      Math.max(...chart.categories.map((c) => textWidth(truncate(c, maxChars), 12))) + 10,
    );
    const rowH = 28;
    // Rule 6: the note gets its own space under the highlighted row, so it never meets a bar or a
    // value label; rows after it move down by that space.
    const hi0 = chart.highlight ? chart.categories.indexOf(chart.highlight.category) : -1;
    const hlRow = hi0 >= 0 && ms.some((m) => m.ci === hi0) ? hi0 : -1;
    const extra = hlRow >= 0 ? NOTE_BELOW : 0;
    const bandH = rowH * chart.categories.length;
    const plotH = bandH + extra;
    const height = top + plotH + (chart.xLabel ? 30 : 12);
    const nice = niceScale(lo, hi, W < CHART_WIDTH ? 3 : 5, true);
    const x = scaleLinear()
      .domain(nice.domain)
      .range([labelW, W - 56]);
    const band = scaleBand<number>()
      .domain(chart.categories.map((_, i) => i))
      .range([top, top + bandH])
      .paddingInner(0.25)
      .paddingOuter(0.1);
    const rowY = (ci: number): number => (band(ci) ?? 0) + (hlRow >= 0 && ci > hlRow ? extra : 0);
    const sub = scaleBand<number>()
      .domain(chart.series.map((_, i) => i))
      .range([0, band.bandwidth()])
      .padding(0.08);
    let body = leg.svg + yLabel;
    chart.categories.forEach((c, ci) => {
      body += el(
        'text',
        [
          ['x', r2(labelW - 8)],
          ['y', r2(rowY(ci) + band.bandwidth() / 2 + 4)],
          ['text-anchor', 'end'],
          ['class', 'viz-ink viz-cat'],
        ],
        escSvg(truncate(c, maxChars)),
      );
    });
    // Rule 8: a category without a value says so where its bar would start.
    for (const g of gaps) {
      const y0 = rowY(g.ci) + (stacked || !multi || g.si < 0 ? 0 : (sub(g.si) ?? 0));
      const h = stacked || !multi || g.si < 0 ? band.bandwidth() : sub.bandwidth();
      body += noDataMark(gapLabel(g.ci, g.si), x(0) + 4, y0 + h / 2 + 4, 'start', h >= 10 ? NO_DATA : 'n/a');
    }
    for (const m of ms) {
      const y0 = rowY(m.ci) + (stacked || !multi ? 0 : (sub(m.si) ?? 0));
      const h = stacked || !multi ? band.bandwidth() : sub.bandwidth();
      const xa = x(Math.min(m.v0, m.v1));
      const xb = x(Math.max(m.v0, m.v1));
      const cat = chart.categories[m.ci] ?? '';
      const val = formatValue(m.value, chart.unit);
      body += el('rect', [
        ['x', r2(xa)],
        ['y', r2(y0)],
        ['width', r2(Math.max(0.5, xb - xa))],
        ['height', r2(h)],
        ['class', markClass(chart, m)],
        ...markAttrs(markLabel(chart, cat, m.si), val),
      ]);
      if (showValues) {
        body += el(
          'text',
          [
            ['x', r2(m.value >= 0 ? xb + 4 : xa - 4)],
            ['y', r2(y0 + h / 2 + 4)],
            ['text-anchor', m.value >= 0 ? 'start' : 'end'],
            ['class', 'viz-ink viz-value'],
          ],
          escSvg(val),
        );
      }
    }
    // The leader drops from the left end of the highlighted row's bars; the zero axis breaks
    // around the note's row where the text crosses it.
    const x0 = x(0);
    const axisSpans: [number, number][] = [[top, top + plotH]];
    if (chart.highlight && hlRow >= 0) {
      const rowBottom = rowY(hlRow) + band.bandwidth();
      const start = Math.min(x0, ...ms.filter((m) => m.ci === hlRow).map((m) => x(Math.min(m.v0, m.v1))));
      const note = noteBelow(chart.highlight.note, start, rowBottom, labelW, W);
      body += note.svg;
      if (note.x0 - 2 < x0 && x0 < note.x1 + 2) {
        axisSpans.splice(0, 1, [top, rowBottom + 4], [rowBottom + NOTE_BELOW - 2, top + plotH]);
      }
    }
    for (const [ya, yb] of axisSpans) {
      body += el('line', [
        ['x1', r2(x0)],
        ['x2', r2(x0)],
        ['y1', r2(ya)],
        ['y2', r2(yb)],
        ['class', 'viz-axis'],
      ]);
    }
    if (chart.xLabel) {
      body += el(
        'text',
        [
          ['x', r2((labelW + W - 56) / 2)],
          ['y', height - 8],
          ['text-anchor', 'middle'],
          ['class', 'viz-ink viz-axis-title'],
        ],
        escSvg(chart.xLabel),
      );
    }
    return { body, height };
  }

  const height = 320;
  const bottom = chart.xLabel ? 46 : 28;
  const left = V_LEFT;
  // Rule 6: a band above the plot is reserved for the highlight note.
  const vTop = top + (chart.highlight ? NOTE_ROW : 0);
  const nice = niceScale(lo, hi, 6, true);
  const y = scaleLinear()
    .domain(nice.domain)
    .range([height - bottom, vTop]);
  const band = scaleBand<number>()
    .domain(chart.categories.map((_, i) => i))
    .range([left, W - 8])
    .paddingInner(0.25)
    .paddingOuter(0.1);
  const sub = scaleBand<number>()
    .domain(chart.series.map((_, i) => i))
    .range([0, band.bandwidth()])
    .padding(0.08);
  let body = leg.svg + yLabel;
  for (const t of nice.ticks) {
    body += el('line', [
      ['x1', left],
      ['x2', W - 8],
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
  chart.categories.forEach((c, ci) => {
    body += el(
      'text',
      [
        ['x', r2((band(ci) ?? 0) + band.bandwidth() / 2)],
        ['y', height - bottom + 16],
        ['text-anchor', 'middle'],
        ['class', 'viz-ink viz-cat'],
      ],
      escSvg(c),
    );
  });
  for (const m of ms) {
    const x0 = (band(m.ci) ?? 0) + (stacked || !multi ? 0 : (sub(m.si) ?? 0));
    const w = stacked || !multi ? band.bandwidth() : sub.bandwidth();
    const ya = y(Math.max(m.v0, m.v1));
    const yb = y(Math.min(m.v0, m.v1));
    const cat = chart.categories[m.ci] ?? '';
    const val = formatValue(m.value, chart.unit);
    body += el('rect', [
      ['x', r2(x0)],
      ['y', r2(ya)],
      ['width', r2(w)],
      ['height', r2(Math.max(0.5, yb - ya))],
      ['class', markClass(chart, m)],
      ...markAttrs(markLabel(chart, cat, m.si), val),
    ]);
    if (showValues) {
      body += el(
        'text',
        [
          ['x', r2(x0 + w / 2)],
          ['y', r2(m.value >= 0 ? ya - 5 : yb + 13)],
          ['text-anchor', 'middle'],
          ['class', 'viz-ink viz-value'],
        ],
        escSvg(val),
      );
    }
  }
  // Rule 8: a category without a value says so just above the zero line of its slot.
  for (const g of gaps) {
    const x0 = (band(g.ci) ?? 0) + (stacked || !multi || g.si < 0 ? 0 : (sub(g.si) ?? 0));
    const w = stacked || !multi || g.si < 0 ? band.bandwidth() : sub.bandwidth();
    const label = textWidth(NO_DATA, 11) <= w ? NO_DATA : 'n/a';
    body += noDataMark(gapLabel(g.ci, g.si), x0 + w / 2, y(0) - 6, 'middle', label);
  }
  if (chart.highlight) {
    const ci = chart.categories.indexOf(chart.highlight.category);
    const ms2 = ms.filter((m) => m.ci === ci);
    if (ci >= 0 && ms2.length > 0) {
      // The leader stops above the category's highest mark and its value label.
      const yt = y(Math.max(0, ...ms2.map((m) => Math.max(m.v0, m.v1))));
      const xc = (band(ci) ?? 0) + band.bandwidth() / 2;
      body += noteAbove(chart.highlight.note, xc, top, yt - (showValues ? 18 : 4), W);
    }
  }
  if (chart.xLabel) {
    body += el(
      'text',
      [
        ['x', r2((left + W) / 2)],
        ['y', height - 8],
        ['text-anchor', 'middle'],
        ['class', 'viz-ink viz-axis-title'],
      ],
      escSvg(chart.xLabel),
    );
  }
  return { body, height };
}
