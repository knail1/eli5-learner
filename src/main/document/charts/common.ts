// Shared chart helpers (07 §7.2): number formatting, SVG element builder, legend and text metrics.
import { format } from 'd3-format';
import type { ChartSpec } from '../../llm';
import { attrs, esc, type AttrValue } from '../html';

/** viewBox width; the SVG scales to 100% of the text column (07 §7.2 rule 10). */
export const CHART_WIDTH = 640;
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

/** Compact legend above the plot (07 §7.2 rule 4). Returns markup and its height. */
export function legend(names: readonly string[], y: number, x0: number): { svg: string; height: number } {
  if (names.length === 0) return { svg: '', height: 0 };
  let x = x0;
  let row = 0;
  let out = '';
  names.forEach((name, i) => {
    const w = 18 + textWidth(name, 12) + 14;
    if (x + w > CHART_WIDTH - 8 && x > x0) {
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
