// Shared chart helpers (07 §7.2): number formatting, SVG element builder, legend and text metrics.
import { format } from 'd3-format';
import type { ChartSpec } from '../../llm';
import { attrs, esc, type AttrValue } from '../html';

/** viewBox width; the SVG scales to 100% of the text column (07 §7.2 rule 10). */
export const CHART_WIDTH = 640;
/**
 * viewBox width of the compact layout shown when the chart is narrower than COMPACT_BELOW px
 * (07 §7.2 rule 12): 12-unit labels stay >= 10.5 px from 368 px (a 400 px phone) up.
 */
export const COMPACT_WIDTH = 380;
export const COMPACT_BELOW = 560;
export const MAX_SERIES_CLASSES = 8;

const bigFmt = format('.3~s');
const smallFmt = format(',.3~r');

/** SI-suffixed number (1.2M, 4.2), `unit` prefixing currency symbols or suffixing % (07 §7.2 rule 9). */
export function formatValue(v: number | null, unit?: string): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const u = unit?.trim() ?? '';
  const abs = Math.abs(v);
  let s = abs >= 1000 ? bigFmt(abs).replace(/G$/, 'B') : abs === 0 ? '0' : smallFmt(abs);
  if (/^[$€£¥]$/.test(u)) s = u + s;
  else if (u === '%') s += '%';
  return (v < 0 ? '−' : '') + s;
}

/** Rounds coordinates so output is short and stable (07 §5.5). */
export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Series color class `viz-{fill|stroke}-N`, N = 1..8 (07 §7.2 rule 11). */
export function seriesClass(kind: 'fill' | 'stroke', i: number): string {
  return `viz-${kind}-${(i % MAX_SERIES_CLASSES) + 1}`;
}

export function el(name: string, list: readonly (readonly [string, AttrValue])[], inner?: string): string {
  return inner === undefined ? `<${name}${attrs(list)}/>` : `<${name}${attrs(list)}>${inner}</${name}>`;
}

/** Rough label width at the chart font size, for layout only. */
export function textWidth(s: string, size = 12): number {
  return s.length * size * 0.56;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

export function markLabel(chart: ChartSpec, category: string, seriesIndex: number): string {
  const name = chart.series[seriesIndex]?.name ?? '';
  return chart.series.length > 1 ? `${category} · ${name}` : category;
}

/** A focusable mark carrying tooltip data (07 §7.2 accessibility). */
export function markAttrs(label: string, value: string): [string, AttrValue][] {
  return [
    ['data-label', label],
    ['data-value', value],
    ['tabindex', 0],
  ];
}

/** Label, tooltip and table text for a missing value (rule 8). */
export const NO_DATA = 'No data';

/**
 * The explicit "No data" mark for a bar slot without a value (rule 8): muted text in the slot,
 * focusable with the same tooltip data as a bar, so it is announced and hoverable like one.
 */
export function noDataMark(label: string, x: number, y: number, anchor: 'start' | 'middle', text = NO_DATA): string {
  return el(
    'text',
    [
      ['x', r2(x)],
      ['y', r2(y)],
      ['text-anchor', anchor],
      ['class', 'viz-ink viz-nodata'],
      ...markAttrs(label, NO_DATA),
    ],
    escSvg(text),
  );
}

/** Compact legend above the plot (07 §7.2 rule 4). Returns markup and its height. */
export function legend(
  names: readonly string[],
  y: number,
  x0: number,
  W: number = CHART_WIDTH,
): { svg: string; height: number } {
  if (names.length === 0) return { svg: '', height: 0 };
  let x = x0;
  let row = 0;
  let out = '';
  names.forEach((name, i) => {
    const w = 18 + textWidth(name, 12) + 14;
    if (x + w > W - 8 && x > x0) {
      x = x0;
      row++;
    }
    const yy = y + row * 18;
    out += el('rect', [
      ['x', r2(x)],
      ['y', yy],
      ['width', 10],
      ['height', 10],
      ['class', seriesClass('fill', i)],
    ]);
    out += el(
      'text',
      [
        ['x', r2(x + 14)],
        ['y', yy + 9],
        ['class', 'viz-ink viz-legend'],
      ],
      escSvg(name),
    );
    x += w;
  });
  return { svg: el('g', [['class', 'viz-legend-row']], out), height: (row + 1) * 18 + 6 };
}

/** SVG text content escape (same rules as HTML text). */
export function escSvg(s: string): string {
  return esc(s);
}

export interface NiceScale {
  domain: [number, number];
  ticks: number[];
  step: number;
}

/** Tick steps are 1, 2, 2.5 or 5 times a power of ten. */
const STEPS = [1, 2, 2.5, 5, 10];

/**
 * "Nice" linear axis (07 §7.2 rule 2): a round step giving at most `count` intervals, and a domain
 * of whole steps that always contains `lo` and `hi` (and 0 when `zero`), so the first and last
 * ticks sit at or beyond the data and every mark lies inside the gridlines.
 */
export function niceScale(lo: number, hi: number, count = 5, zero = false): NiceScale {
  let a = Math.min(lo, hi);
  let b = Math.max(lo, hi);
  if (zero) {
    a = Math.min(0, a);
    b = Math.max(0, b);
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) [a, b] = [0, 1];
  if (a === b) {
    const pad = a === 0 ? 1 : Math.abs(a) / 10;
    a = zero && a >= 0 ? a : a - pad;
    b = zero && b <= 0 ? b : b + pad;
    if (a === b) b = a + 1;
  }
  const n = Math.max(1, Math.round(count));
  const raw = (b - a) / n;
  const pow = 10 ** Math.floor(Math.log10(raw));
  // Floating error guard: 0.30000000000000004 / 0.1 must count as 3 steps.
  const eps = 1e-9;
  let step = pow * 10;
  let lo0 = a;
  let hi0 = b;
  for (const m of STEPS) {
    const st = pow * m;
    const s0 = Math.floor(a / st + eps) * st;
    const s1 = Math.ceil(b / st - eps) * st;
    if (Math.round((s1 - s0) / st) <= n) {
      step = st;
      lo0 = s0;
      hi0 = s1;
      break;
    }
  }
  if (step === pow * 10) {
    lo0 = Math.floor(a / step + eps) * step;
    hi0 = Math.ceil(b / step - eps) * step;
  }
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + (step / pow === 2.5 ? 1 : 0));
  const fix = (v: number): number => {
    const r = Number(v.toFixed(decimals));
    return Object.is(r, -0) ? 0 : r;
  };
  const ticks: number[] = [];
  const k = Math.round((hi0 - lo0) / step);
  for (let i = 0; i <= k; i++) ticks.push(fix(lo0 + i * step));
  return { domain: [fix(lo0), fix(hi0)], ticks, step };
}

export function maxOf(values: readonly (number | null)[]): number | undefined {
  let m: number | undefined;
  for (const v of values) if (v !== null && Number.isFinite(v) && (m === undefined || v > m)) m = v;
  return m;
}

export function minOf(values: readonly (number | null)[]): number | undefined {
  let m: number | undefined;
  for (const v of values) if (v !== null && Number.isFinite(v) && (m === undefined || v < m)) m = v;
  return m;
}

export function allValues(chart: ChartSpec): (number | null)[] {
  return chart.series.flatMap((s) => s.values);
}
