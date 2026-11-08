// Line and area charts (07 §7.2 rules 2, 3, 4, 8, 10): nice y extent (area from 0), gaps at nulls,
// direct labels at line ends for <= 4 series, otherwise a compact legend.
import { scalePoint, scaleLinear } from 'd3-scale';
import { area, line } from 'd3-shape';
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
  type NiceScale,
  seriesClass,
  textWidth,
  truncate,
} from './common';
import { NOTE_ROW, annotationMark, noteAbove } from './annotate';

/** Lines start at zero when their values allow it (07 §7.2 rule 2): every value >= 0 and min <= half of max. */
export const LINE_ZERO_RATIO = 0.5;
export const AXIS_BREAK_NOTE = 'The vertical axis does not start at zero.';

/**
 * The y axis of a line or area chart (07 §7.2 rule 2). Areas always start at zero. A line
 * starts at zero when its values sit on one side of zero and the smaller magnitude is at most half
 * of the larger one; a line crossing zero uses the plain nice extent. Otherwise the domain is sized
 * so the data fills about two thirds of the plot height, and `broken` is true when that domain
 * leaves out zero (the renderer draws an axis break and adds AXIS_BREAK_NOTE).
 */
export function lineAxis(chart: ChartSpec): { nice: NiceScale; broken: boolean } {
  const vals = allValues(chart);
  const lo = minOf(vals) ?? 0;
  const hi = maxOf(vals) ?? 1;
  if (chart.kind === 'area') return { nice: niceScale(lo, hi, 6, true), broken: false };
  if (lo < 0 && hi > 0) return { nice: niceScale(lo, hi, 6), broken: false };
  const near = Math.min(Math.abs(lo), Math.abs(hi));
  const far = Math.max(Math.abs(lo), Math.abs(hi));
  if (near <= LINE_ZERO_RATIO * far || lo === hi) return { nice: niceScale(lo, hi, 6, true), broken: false };
  // The data span is two thirds of the domain: a sixth of padding above and below.
  const pad = (hi - lo) / 4 || far / 10;
  const a = lo - pad;
  const b = hi + pad;
  const nice = niceScale(lo >= 0 ? Math.max(0, a) : a, hi <= 0 ? Math.min(0, b) : b, 6);
  return { nice, broken: nice.domain[0] > 0 || nice.domain[1] < 0 };
}

/** Two short slanted strokes across the bottom of the y axis: the scale is cut (07 §7.2 rule 2). */
function axisBreak(x: number, y: number): string {
  const d = `M${r2(x - 5)},${r2(y + 2)}L${r2(x + 5)},${r2(y - 2)}M${r2(x - 5)},${r2(y + 6)}L${r2(x + 5)},${r2(y + 2)}`;
  return el('path', [
    ['d', d],
    ['fill', 'none'],
    ['class', 'viz-axis viz-axis-break'],
  ]);
}

export function renderLine(chart: ChartSpec, W: number = CHART_WIDTH): { body: string; height: number } {
  const isArea = chart.kind === 'area';
  const height = 320;
  const direct = chart.series.length > 1 && chart.series.length <= 4;
  const leg =
    chart.series.length > 4
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
  const right = direct
    ? Math.min(
        W < CHART_WIDTH ? 90 : 140,
        Math.max(...chart.series.map((s) => textWidth(truncate(s.name, W < CHART_WIDTH ? 12 : 18), 12))) + 14,
      )
    : 16;
  const { nice, broken } = lineAxis(chart);
  const y = scaleLinear()
    .domain(nice.domain)
    .range([height - bottom, top]);
  const x = scalePoint<number>()
    .domain(chart.categories.map((_, i) => i))
    .range([left + 8, W - right])
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
  for (const t of nice.ticks) {
    body += el('line', [
      ['x1', left],
      ['x2', W - right],
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
  if (broken) body += axisBreak(left, height - bottom - 6);
  // Thin out category labels so they do not collide; annotated categories are always labelled.
  const n = chart.categories.length;
  const label = (c: string): string => truncate(c, 12) + annotationMark(chart, c);
  const need = Math.max(...chart.categories.map((c) => textWidth(label(c), 12))) + 16;
  const every = Math.max(1, Math.ceil((n * need) / (W - right - left)));
  const forced = chart.categories.map((c, i) => (annotationMark(chart, c) ? i : -1)).filter((i) => i >= 0);
  const clear = (i: number): boolean => forced.every((f) => f === i || Math.abs(xp(f) - xp(i)) >= need);
  chart.categories.forEach((c, i) => {
    if (!forced.includes(i) && ((i % every !== 0 && i !== n - 1) || !clear(i))) return;
    body += el(
      'text',
      [
        ['x', r2(xp(i))],
        ['y', height - bottom + 16],
        ['text-anchor', i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'],
        ['class', 'viz-ink viz-cat'],
      ],
      escSvg(label(c)),
    );
  });

  // 07 §7.2 rule 6: with a highlight, the highlighted category's points take the accent and every
  // other mark is muted; direct labels fall back to ink so series stay identifiable.
  const hl = chart.highlight ? chart.categories.indexOf(chart.highlight.category) : -1;
  const hasHl = chart.highlight !== undefined;
  const lineClass = (kind: 'fill' | 'stroke', si: number): string =>
    hasHl ? `viz-${kind}-muted` : seriesClass(kind, si);
  const pointClass = (si: number, i: number): string =>
    hasHl ? (i === hl ? 'viz-fill-accent' : 'viz-fill-muted') : seriesClass('fill', si);

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
        ['class', `${lineClass('fill', si)} viz-area`],
      ]);
    }
    const l = line<Pt>()
      .defined(defined)
      .x((p) => r2(xp(p[0])))
      .y((p) => r2(y(p[1] ?? 0)));
    body += el('path', [
      ['d', l(pts) ?? ''],
      ['fill', 'none'],
      ['class', `${lineClass('stroke', si)} viz-line`],
    ]);
    s.values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) return;
      body += el('circle', [
        ['cx', r2(xp(i))],
        ['cy', r2(y(v))],
        ['r', n > 24 ? 2 : 3.5],
        ['class', pointClass(si, i)],
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
            ['class', `${hasHl ? 'viz-fill-ink' : seriesClass('fill', si)} viz-direct`],
          ],
          escSvg(truncate(s.name, W < CHART_WIDTH ? 12 : 18)),
        );
      }
    }
  });
  if (chart.highlight) {
    const ci = chart.categories.indexOf(chart.highlight.category);
    const v = ci >= 0 ? maxOf(chart.series.map((s) => s.values[ci] ?? null)) : undefined;
    if (ci >= 0 && v !== undefined) {
      // An area's fill runs from the zero line to each value, so its leader stops above both.
      const yt = y(isArea ? Math.max(0, v) : v);
      body += noteAbove(chart.highlight.note, xp(ci), noteTop, yt - 7, W);
    }
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
