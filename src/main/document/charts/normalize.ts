// Chart normalization at build time (07 §5.2): the Wong rules the renderer enforces on a model
// ChartSpec. Validation (02 §10.1) only checks structure; everything here is a quiet fix plus a
// build warning, never a repair call or a drop (repeated categories merge, a blank title is derived).
import type { ChartSpec } from '../../llm';
import { formatValue, NO_DATA } from './common';

export const MAX_CATEGORIES = 30;
/** Lines, areas and scatter groups: at most four (Wong: three or four lines). */
export const MAX_LINE_SERIES = 4;
/** Grouped and stacked bars: at most four series. */
export const MAX_BAR_SERIES = 4;
/** Pies: at most five slices, the smallest folded into "Other". */
export const MAX_PIE_SLICES = 5;
/** A series missing more than this share of its values (and more than one value) is not charted. */
export const MAX_NULL_SHARE = 0.2;
export const MAX_FOOTNOTE = 200;
export const MAX_ANNOTATIONS = 3;
export const MAX_ANNOTATION_TEXT = 80;
/** Names listed in the "No data for ..." footnote before "and N more". */
const MAX_GAP_NAMES = 5;
export const OTHER = 'Other';
/** Title of a chart with no title, heading, y-axis label or series name to derive one from. */
export const FALLBACK_TITLE = 'Chart';

/** What the chart's surroundings offer for fixes (07 §5.2). */
export interface ChartContext {
  /** The section heading, for a blank title. */
  heading?: string;
}

/** A chart whose every series was too sparse to plot: shown as a table instead (07 §5.2). */
export interface ChartAsTable {
  table: { caption: string; header: string[]; rows: string[][] };
}

// ---- text ----

const EMPHASIS_STAR = /(\*{1,3})(?=\S)(.+?)(?<=\S)\1/g;
const EMPHASIS_UNDERSCORE = /(^|[^\p{L}\p{N}_])(_{1,3})(?=\S)(.+?)(?<=\S)\2(?![\p{L}\p{N}_])/gu;

/**
 * Chart text never mixes bold and italic, and SVG text cannot show either from Markdown, so inline
 * emphasis markers are removed (07 §7.2 rule 13): `**a**`, `*a*`, `***a***`, `__a__`, `_a_`.
 */
export function stripEmphasis(s: string): string {
  let out = s;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(EMPHASIS_STAR, '$2').replace(EMPHASIS_UNDERSCORE, '$1$3');
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Short function words that are never acronyms, even when shouted. */
const SHORT_WORDS = new Set(
  (
    'A AN AND ARE AS AT BE BUT BY CAN DID DO FOR FROM HAS HAD HE HER HIS HOW IF IN IS IT ITS ' +
    'MAY NO NOT NOW OF ON ONE OR OUR OUT PER SHE SO THE TO TWO UP VS WAS WE WHO WHY YET YOU'
  ).split(' '),
);
const TOKEN = /[\p{L}\p{N}]+/gu;
const isCapsWord = (t: string): boolean =>
  /\p{Lu}/u.test(t) && !/\p{Ll}/u.test(t) && t.replace(/\P{L}/gu, '').length >= 2;

/**
 * No ALL CAPS (07 §7.2 rule 13): a string with two or more all-caps words of four or more letters
 * goes to sentence case. Acronyms survive: common short words (FOR, THE, WHY) never count as
 * acronyms; otherwise in mixed-case text every all-caps token of up to five characters is kept, and
 * in fully shouted text (no lowercase at all) tokens of up to three characters and tokens of up to
 * five characters with a digit or no vowel (GDP, MCMC, Q3) are kept.
 */
export function unshout(s: string): string {
  const tokens = s.match(TOKEN) ?? [];
  if (tokens.filter((t) => isCapsWord(t) && t.replace(/\P{L}/gu, '').length >= 4).length < 2) return s;
  const shouted = !/\p{Ll}/u.test(s);
  const keep = (t: string): boolean => {
    if (t.length > 5 || SHORT_WORDS.has(t)) return false;
    if (!shouted) return true;
    if (/\p{N}/u.test(t) || !/[AEIOU]/.test(t)) return true;
    return t.length <= 3;
  };
  let first = true;
  return s.replace(TOKEN, (t) => {
    let out = t;
    if (isCapsWord(t) && !keep(t)) out = t.toLowerCase();
    if (first) {
      first = false;
      out = out.charAt(0).toUpperCase() + out.slice(1);
    }
    return out;
  });
}

/** Emphasis stripped, then ALL CAPS normalized, whitespace collapsed. */
export function chartText(s: string): string {
  return unshout(stripEmphasis(s)).replace(/\s+/g, ' ').trim();
}

function capped(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

function normalizeText(c: ChartSpec): ChartSpec {
  const opt = (s: string | undefined): string | undefined => {
    if (s === undefined) return undefined;
    const t = chartText(s);
    return t === '' ? undefined : t;
  };
  const out: ChartSpec = {
    ...c,
    title: chartText(c.title),
    categories: c.categories.map(chartText),
    series: c.series.map((s) => ({ ...s, name: chartText(s.name) })),
  };
  for (const k of ['subtitle', 'source', 'xLabel', 'yLabel', 'unit'] as const) {
    const v = opt(c[k]);
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  // The renderer prints "Note: " itself.
  const foot = opt(c.footnote?.replace(/^\s*notes?\s*:\s*/i, ''));
  if (foot === undefined) delete out.footnote;
  else out.footnote = capped(foot, MAX_FOOTNOTE);
  if (c.highlight) {
    out.highlight = { category: chartText(c.highlight.category), note: chartText(c.highlight.note) };
  }
  return out;
}

// ---- helpers ----

const isNum = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

function sumOf(values: readonly (number | null)[]): number | null {
  const nums = values.filter(isNum);
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

function meanAbs(values: readonly (number | null)[]): number {
  const nums = values.filter(isNum);
  return nums.length ? nums.reduce((a, b) => a + Math.abs(b), 0) / nums.length : 0;
}

function addFootnote(c: ChartSpec, note: string): ChartSpec {
  if (c.footnote?.includes(note)) return c;
  const prev = c.footnote?.trim();
  if (!prev) return { ...c, footnote: note };
  return { ...c, footnote: `${/[.!?…]$/.test(prev) ? prev : `${prev}.`} ${note}` };
}

/** "A, B and C" with at most five names, then "and N more". */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, MAX_GAP_NAMES);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  return shown.length <= 1 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** Keeps `keep` (indices into series) in their original order. */
function keepSeries(c: ChartSpec, keep: ReadonlySet<number>): ChartSpec {
  return { ...c, series: c.series.filter((_, i) => keep.has(i)) };
}

function chartAsTable(c: ChartSpec): ChartAsTable {
  return {
    table: {
      caption: c.title,
      header: [c.xLabel ?? 'Category', ...c.series.map((s) => s.name)],
      rows: c.categories.map((cat, i) => [
        cat,
        ...c.series.map((s) => {
          const v = s.values[i];
          return isNum(v) ? formatValue(v, c.unit) : NO_DATA;
        }),
      ]),
    },
  };
}

// ---- steps ----

/** Longest derived title: the section heading's own cap (07 §5.2). */
export const MAX_DERIVED_TITLE = 120;

/**
 * Repeated categories (scatter x values may repeat) merge into the first occurrence: bars, stacked
 * bars and pies sum each series (an all-null group stays null); lines and areas keep the first
 * reading that has a value, since summing two readings of one point in time would invent a value.
 * The footnote tells the reader which categories were combined.
 */
function mergeDuplicateCategories(chart: ChartSpec, warn: (w: string) => void): ChartSpec {
  if (chart.kind === 'scatter' || new Set(chart.categories).size === chart.categories.length) return chart;
  const groups = new Map<string, number[]>();
  chart.categories.forEach((cat, i) => {
    const g = groups.get(cat);
    if (g) g.push(i);
    else groups.set(cat, [i]);
  });
  const keepFirst = chart.kind === 'line' || chart.kind === 'area';
  const firstValue = (s: ChartSpec['series'][number], idx: readonly number[]): number | null =>
    idx.map((i) => s.values[i]).find(isNum) ?? null;
  const repeated = [...groups].filter(([, idx]) => idx.length > 1).map(([cat]) => cat);
  warn('chart-categories-merged');
  const merged: ChartSpec = {
    ...chart,
    categories: [...groups.keys()],
    series: chart.series.map((s) => ({
      ...s,
      values: [...groups.values()].map((idx) =>
        keepFirst ? firstValue(s, idx) : sumOf(idx.map((i) => s.values[i] ?? null)),
      ),
    })),
  };
  const how = keepFirst ? 'first value shown' : 'values added';
  return addFootnote(merged, `Repeated ${nameList(repeated)} combined (${how}).`);
}

/** A blank title is derived from the section heading, else the y-axis label, else the first series. */
function deriveTitle(chart: ChartSpec, ctx: ChartContext, warn: (w: string) => void): ChartSpec {
  if (chart.title !== '') return chart;
  const title =
    [ctx.heading === undefined ? '' : chartText(ctx.heading), chart.yLabel ?? '', chart.series[0]?.name ?? ''].find(
      (t) => t !== '',
    ) ?? FALLBACK_TITLE;
  warn('chart-title-derived');
  return { ...chart, title: capped(title, MAX_DERIVED_TITLE) };
}

function foldCategories(chart: ChartSpec, warn: (w: string) => void): ChartSpec {
  const n = chart.categories.length;
  if (n <= MAX_CATEGORIES) return chart;
  const first = chart.series[0]?.values ?? [];
  const keep = new Set(
    chart.categories
      .map((_, i) => i)
      .sort((a, b) => (first[b] ?? -Infinity) - (first[a] ?? -Infinity) || a - b)
      .slice(0, MAX_CATEGORIES - 1),
  );
  const idx = chart.categories.map((_, i) => i).filter((i) => keep.has(i));
  const rest = chart.categories.map((_, i) => i).filter((i) => !keep.has(i));
  warn('chart-categories-folded');
  return {
    ...chart,
    categories: [...idx.map((i) => chart.categories[i] ?? ''), OTHER],
    series: chart.series.map((s) => ({
      ...s,
      values: [...idx.map((i) => s.values[i] ?? null), sumOf(rest.map((i) => s.values[i] ?? null))],
    })),
  };
}

/**
 * Wong's missing-data rule: a series missing more than 20 % of its values (and more than one) is
 * not charted; when no series is left the chart becomes a table. Scatter groups are exempt (each
 * group has values only at its own x positions).
 */
function dropSparse(chart: ChartSpec, warn: (w: string) => void): ChartSpec | ChartAsTable {
  if (chart.kind === 'scatter') return chart;
  const n = chart.categories.length;
  const sparse = (s: ChartSpec['series'][number]): boolean => {
    const nulls = s.values.filter((v) => !isNum(v)).length;
    return nulls > 1 && nulls / n > MAX_NULL_SHARE;
  };
  const dropped = chart.series.filter(sparse);
  if (dropped.length === 0) return chart;
  if (dropped.length === chart.series.length) {
    warn('chart-sparse-tabled');
    return chartAsTable(chart);
  }
  warn('chart-series-sparse');
  const kept = { ...chart, series: chart.series.filter((s) => !sparse(s)) };
  const names = nameList(dropped.map((s) => s.name));
  return addFootnote(kept, `${names} not shown: too many values are missing.`);
}

/** Pies: no negatives (else a bar chart), one series, at most five slices with "Other". */
function normalizePie(chart: ChartSpec, warn: (w: string) => void): ChartSpec {
  if (chart.kind !== 'pie') return chart;
  const vals = chart.series[0]?.values ?? [];
  if (vals.some((v) => isNum(v) && v < 0)) {
    warn('pie-converted');
    return { ...chart, kind: 'bar', series: chart.series.slice(0, 1) };
  }
  let c: ChartSpec = { ...chart, series: chart.series.slice(0, 1) };
  if (c.categories.length <= MAX_PIE_SLICES) return c;
  const s0 = c.series[0] ?? { name: '', values: [] };
  const order = c.categories
    .map((_, i) => i)
    .filter((i) => c.categories[i] !== OTHER && isNum(s0.values[i]))
    .sort((a, b) => (s0.values[b] ?? 0) - (s0.values[a] ?? 0) || a - b);
  const keep = new Set(order.slice(0, MAX_PIE_SLICES - 1));
  const idx = c.categories.map((_, i) => i).filter((i) => keep.has(i));
  const rest = c.categories.map((_, i) => i).filter((i) => !keep.has(i));
  c = {
    ...c,
    categories: [...idx.map((i) => c.categories[i] ?? ''), OTHER],
    series: [
      { ...s0, values: [...idx.map((i) => s0.values[i] ?? null), sumOf(rest.map((i) => s0.values[i] ?? null))] },
    ],
  };
  warn('pie-slices-folded');
  return c;
}

/**
 * Series caps: lines/areas/scatter keep the four largest by mean |value| (a highlight names a
 * category, so it never picks a series); grouped bars keep the four largest totals; stacked bars fold the
 * rest into an "Other" series. The number of dropped series is given in the footnote.
 */
function capSeries(chart: ChartSpec, warn: (w: string) => void): ChartSpec {
  const isLine = chart.kind === 'line' || chart.kind === 'area' || chart.kind === 'scatter';
  const isBar = chart.kind === 'bar' || chart.kind === 'stacked-bar';
  const max = isLine ? MAX_LINE_SERIES : isBar ? MAX_BAR_SERIES : Infinity;
  if (chart.series.length <= max) return chart;
  warn('chart-series-capped');
  if (chart.kind === 'stacked-bar') {
    const ranked = chart.series
      .map((s, i) => ({ i, total: meanAbs(s.values) }))
      .sort((a, b) => b.total - a.total || a.i - b.i);
    const keep = new Set(ranked.slice(0, max - 1).map((r) => r.i));
    const rest = chart.series.filter((_, i) => !keep.has(i));
    const other = {
      name: OTHER,
      values: chart.categories.map((_, ci) => sumOf(rest.map((s) => s.values[ci] ?? null))),
    };
    return { ...keepSeries(chart, keep), series: [...keepSeries(chart, keep).series, other] };
  }
  // 07 §5.2: grouped bars rank by total (missing values count as nothing), lines by mean |value|.
  const score = (values: readonly (number | null)[]): number =>
    chart.kind === 'bar' ? (sumOf(values) ?? -Infinity) : meanAbs(values);
  const ranked = chart.series
    .map((s, i) => ({ i, score: score(s.values) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const keep = new Set(ranked.slice(0, max).map((r) => r.i));
  const more = chart.series.length - keep.size;
  return addFootnote(keepSeries(chart, keep), `${more} more series not shown.`);
}

/** order 'value': bar categories sorted largest first (stacked: by total); nulls last. */
function orderByValue(chart: ChartSpec): ChartSpec {
  if (chart.order !== 'value' || (chart.kind !== 'bar' && chart.kind !== 'stacked-bar')) return chart;
  const key = (i: number): number =>
    (chart.kind === 'stacked-bar'
      ? sumOf(chart.series.map((s) => s.values[i] ?? null))
      : (chart.series[0]?.values[i] ?? null)) ?? -Infinity;
  const idx = chart.categories.map((_, i) => i).sort((a, b) => key(b) - key(a) || a - b);
  return {
    ...chart,
    categories: idx.map((i) => chart.categories[i] ?? ''),
    series: chart.series.map((s) => ({ ...s, values: idx.map((i) => s.values[i] ?? null) })),
  };
}

/** Annotations: on known categories only, one per category, at most three, text at most 80. */
function normalizeAnnotations(chart: ChartSpec, warn: (w: string) => void): ChartSpec {
  if (chart.annotations === undefined) return chart;
  const known = new Set(chart.categories);
  const seen = new Set<string>();
  const kept: NonNullable<ChartSpec['annotations']> = [];
  for (const a of chart.annotations) {
    const category = chartText(a.category);
    const text = capped(chartText(a.text), MAX_ANNOTATION_TEXT);
    if (!known.has(category) || text === '' || seen.has(category) || kept.length >= MAX_ANNOTATIONS) continue;
    seen.add(category);
    kept.push({ category, text });
  }
  if (kept.length < chart.annotations.length) warn('chart-annotations-dropped');
  const { annotations: _drop, ...rest } = chart;
  return kept.length ? { ...rest, annotations: kept } : rest;
}

/** Remaining gaps are named in the footnote: "No data for A, B." */
function noteGaps(chart: ChartSpec): ChartSpec {
  if (chart.kind === 'scatter') return chart;
  const stacked = chart.kind === 'stacked-bar';
  const names = chart.categories.filter((_, i) =>
    stacked ? chart.series.every((s) => !isNum(s.values[i])) : chart.series.some((s) => !isNum(s.values[i])),
  );
  return names.length ? addFootnote(chart, `No data for ${nameList(names)}.`) : chart;
}

/**
 * 07 §5.2 chart normalization. Returns null (drop) when the chart is empty or a series length
 * differs from the category count, a table when every series is too sparse, else the chart with
 * the Wong rules applied (text, repeated categories, blank title, categories, pie, sparse and
 * capped series, order, annotations, footnotes).
 */
export function normalizeChart(
  input: ChartSpec,
  warn: (w: string) => void,
  ctx: ChartContext = {},
): ChartSpec | ChartAsTable | null {
  const n = input.categories.length;
  if (n === 0 || input.series.length === 0) return null;
  if (input.series.some((s) => s.values.length !== n)) {
    warn('chart-series-length');
    return null;
  }
  let chart: ChartSpec = normalizeText({
    ...input,
    series: input.series.map((s) => ({ ...s, values: [...s.values] })),
  });
  chart = mergeDuplicateCategories(chart, warn);
  chart = deriveTitle(chart, ctx, warn);
  chart = foldCategories(chart, warn);
  const dense = dropSparse(chart, warn);
  if ('table' in dense) return dense;
  chart = normalizePie(dense, warn);
  chart = capSeries(chart, warn);
  chart = orderByValue(chart);
  chart = normalizeAnnotations(chart, warn);
  return noteGaps(chart);
}
