import type { TabKind } from '../document';
import { cjkCount, estimateTokens, sectionText, wrapSource } from './budget';
import type { SectionAnswerDraft, SectionDraft } from './schemas/draft';

/**
 * Deep Ask context assembly (08 §6.9, 02 §8): fits every explanation tab and the document's kept
 * source text into one request, dropping tabs and then retrieving source excerpts (BM25 over
 * line-based chunks) when the material is too large. Pure and deterministic: the same input gives
 * byte-identical output. The strings built here are short labels and markers, never sentences; every
 * sentence the model reads lives in config/prompts.
 */

/** How much of the kept source text a deep answer saw (the answer box badge, 07 §6.5). */
export type DeepAskSourceMode = 'all' | 'excerpts' | 'none';

/** One tab of the document, in document order, without answer boxes or the references section. */
export interface DeepAskTab {
  key: string;
  kind: TabKind;
  label: string;
  sections: SectionDraft[];
}

/** One kept source (09 §4.4) or a `sourcesUsed` record with no kept text. */
export interface DeepAskSource {
  id: string;
  ref: string;
  label: string;
  /** ExtractedFormat; 'unknown' for a meta-only record. */
  format: string;
  /** null: an image, an omitted entry, or a sourcesUsed record with no kept text. */
  text: string | null;
  truncated: boolean;
}

export interface DeepAskPlan {
  sourceMode: DeepAskSourceMode;
  /** Keys of the tabs sent (In depth stays even when trimmed to zero sections). */
  tabsKept: string[];
  /** Keys of the tabs left out, in the order they were dropped. */
  tabsDropped: string[];
  /** In depth lost sections to make room for source excerpts (or, in mode 'none', to fit at all). */
  indepthTrimmed: boolean;
  /** Source excerpts sent (mode 'excerpts' only; 0 otherwise). */
  chunks: number;
  /** Estimated input tokens of the whole request. */
  inputTokens: number;
}

export interface DeepAskResult {
  draft: SectionAnswerDraft;
  plan: DeepAskPlan;
}

/** The deep context cannot fit the model's input budget (06 maps it to SECTION_TOO_LARGE). */
export class DeepContextTooLargeError extends Error {
  constructor(message = 'Deep ask context does not fit the input budget') {
    super(message);
    this.name = 'DeepContextTooLargeError';
  }
}

// 60k, not 150k: every Deep Ask pays its whole input (no caching of the user turn), and one request
// above a low API tier's input-tokens-per-minute limit fails with 429 on every retry. 60k estimated
// tokens is about 210k characters of material.
export const DEEP_ASK_INPUT_CAP_TOKENS = 60_000;
/** Must exceed DEEP_ASK_TOP_CHUNKS * tokens(CHUNK_MAX_CHARS) (~2.6k) so the best chunks always fit. */
export const DEEP_ASK_MIN_TOKENS = 4_000;
export const DEEP_ASK_TOP_CHUNKS = 3;
export const DEEP_ASK_MIN_SOURCE_SHARE = 0.5;
export const CHUNK_TARGET_CHARS = 1_500;
export const CHUNK_MAX_CHARS = 3_000;
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
/** Selection terms added to the query: the highest-IDF unique ones. */
export const DEEP_ASK_SELECTION_TERMS = 40;

// ---- tokens ----

const CJK_CLASS = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\u30fc';
const CJK_RUN_RE = new RegExp(`([${CJK_CLASS}]+)|([^${CJK_CLASS}]+)`, 'gu');
const SPLIT_RE = /[^\p{L}\p{N}\p{M}]+/u;
const DIGITS_RE = /^\p{N}+$/u;
const LATIN_RE = /^[a-z]+$/;

// prettier-ignore
const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and', 'any', 'are',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from',
  'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i',
  'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my', 'no', 'nor',
  'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'out', 'over', 'own',
  'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up',
  'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why',
  'will', 'with', 'would', 'you', 'your', 'yours',
]);

function stem(t: string): string {
  if (!LATIN_RE.test(t)) return t;
  let s = t;
  if (s.endsWith('ies') && s.length > 4) s = s.slice(0, -3) + 'y';
  else if (s.endsWith('s') && !s.endsWith('ss') && s.length > 3) s = s.slice(0, -1);
  if (s.endsWith('ing') && s.length > 5) s = s.slice(0, -3);
  else if (s.endsWith('ed') && s.length > 5) s = s.slice(0, -2);
  return s;
}

/**
 * Retrieval tokens: lowercase, compatibility-normalized, split on non-letters/digits. Latin text
 * loses combining marks, stopwords and short tokens, and is lightly stemmed; a run of Han, kana or
 * Hangul becomes its overlapping character bigrams (a single character stays one token), since those
 * scripts have no word boundaries.
 */
export function lexTokens(text: string): string[] {
  const out: string[] = [];
  for (const word of text.normalize('NFKC').toLowerCase().split(SPLIT_RE)) {
    if (word === '') continue;
    for (const m of word.matchAll(CJK_RUN_RE)) {
      if (m[1] !== undefined) {
        const chars = [...m[1]];
        if (chars.length === 1) out.push(chars[0] ?? '');
        for (let i = 0; i + 1 < chars.length; i++) out.push((chars[i] ?? '') + (chars[i + 1] ?? ''));
        continue;
      }
      const t = (m[2] ?? '').normalize('NFKD').replace(/\p{M}+/gu, '');
      if (t === '' || (t.length < 2 && !DIGITS_RE.test(t)) || STOPWORDS.has(t)) continue;
      out.push(stem(t));
    }
  }
  return out;
}

// ---- BM25 ----

function idfOf(docs: readonly string[][]): (term: string) => number {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  return (term) => {
    const f = df.get(term) ?? 0;
    return Math.log(1 + (n - f + 0.5) / (f + 0.5));
  };
}

/** BM25 (k1 1.2, b 0.75) of every doc against the query; repeated query terms count again. */
export function bm25Scores(docs: readonly string[][], query: readonly string[]): number[] {
  if (docs.length === 0) return [];
  const idf = idfOf(docs);
  const avgdl = docs.reduce((n, d) => n + d.length, 0) / docs.length;
  const weights = query.map((t) => [t, idf(t)] as const);
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    const norm = avgdl > 0 ? d.length / avgdl : 1;
    let score = 0;
    for (const [t, w] of weights) {
      const f = tf.get(t) ?? 0;
      if (f > 0) score += (w * f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * norm));
    }
    return score;
  });
}

/** The question's tokens twice, then up to 40 selection terms by descending IDF over `corpus`. */
function buildQuery(question: string, selection: string, corpus: readonly string[][]): string[] {
  const q = lexTokens(question);
  const idf = idfOf(corpus);
  const sel = [...new Set(lexTokens(selection))]
    .map((t, i) => ({ t, i, w: idf(t) }))
    .sort((a, b) => b.w - a.w || a.i - b.i)
    .slice(0, DEEP_ASK_SELECTION_TERMS)
    .map((x) => x.t);
  return [...q, ...q, ...sel];
}

// ---- chunking ----

export interface SourceChunk {
  sourceIndex: number;
  /** Position of the chunk within its source (0-based). */
  index: number;
  /** Character offsets into the source text; `text === source.slice(start, end)`. */
  start: number;
  end: number;
  /** The last heading, page or slide line seen at the chunk's start, as a short label. */
  heading?: string;
  text: string;
}

const HEADING_RE = /^#{1,6}\s+\S/;
const PAGE_RE = /^--- Page \d+ ---\s*$/;
const FENCE_RE = /^\s*```/;
const TABLE_RE = /^\s*\|/;
const SENTENCE_END_RE = /[.!?。！？](?=\s|$)/g;

function headingLabel(line: string): string {
  return oneLine(
    line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^---\s*/, '')
      .replace(/\s*---\s*$/, ''),
  ).slice(0, 80);
}

/** [start, end) spans of a line longer than CHUNK_MAX_CHARS: sentence ends, else hard cuts. */
function splitLong(start: number, end: number, text: string): [number, number][] {
  const out: [number, number][] = [];
  let a = start;
  while (end - a > CHUNK_MAX_CHARS) {
    const window = text.slice(a, a + CHUNK_MAX_CHARS);
    let cut = -1;
    for (const m of window.matchAll(SENTENCE_END_RE)) {
      const at = (m.index ?? 0) + m[0].length;
      if (at >= CHUNK_TARGET_CHARS / 2) cut = at;
    }
    const b = a + (cut > 0 ? cut : CHUNK_MAX_CHARS);
    out.push([a, b]);
    a = b;
  }
  if (end > a) out.push([a, end]);
  return out;
}

interface Unit {
  start: number;
  end: number;
  /** A heading, page or slide line: a hard chunk boundary before it. */
  boundary: boolean;
}

/**
 * Line-based chunks of one kept source (`toPromptText` output: blocks on single `\n` lines, pages
 * `--- Page N ---`, slides `## Slide N`, code in ``` fences, tables as `|` lines). Hard boundaries
 * before headings, pages and slides; lines pack up to CHUNK_TARGET_CHARS; a fence or table run stays
 * whole unless it alone exceeds CHUNK_MAX_CHARS; a longer line is split at sentence ends. No chunk
 * exceeds CHUNK_MAX_CHARS.
 */
export function chunkSourceText(text: string, sourceIndex: number): SourceChunk[] {
  // Lines as [start, end) offsets (end excludes the newline).
  const lines: [number, number][] = [];
  for (let a = 0; a <= text.length;) {
    const nl = text.indexOf('\n', a);
    const b = nl < 0 ? text.length : nl;
    lines.push([a, b]);
    a = b + 1;
  }
  const lineText = (l: [number, number]): string => text.slice(l[0], l[1]);

  // Units: a whole fence, a whole table run, or one line.
  const units: Unit[] = [];
  const pushSpan = (a: number, b: number, boundary: boolean): void => {
    if (b - a <= CHUNK_MAX_CHARS) units.push({ start: a, end: b, boundary });
    else splitLong(a, b, text).forEach(([x, y], i) => units.push({ start: x, end: y, boundary: boundary && i === 0 }));
  };
  for (let i = 0; i < lines.length;) {
    const l = lines[i] as [number, number];
    const t = lineText(l);
    let j = i + 1;
    if (FENCE_RE.test(t)) {
      while (j < lines.length && !FENCE_RE.test(lineText(lines[j] as [number, number]))) j++;
      j = Math.min(j + 1, lines.length);
    } else if (TABLE_RE.test(t)) {
      while (j < lines.length && TABLE_RE.test(lineText(lines[j] as [number, number]))) j++;
    }
    const last = lines[j - 1] as [number, number];
    if (j - i > 1 && last[1] - l[0] > CHUNK_MAX_CHARS) {
      // An oversized fence or table: split it like ordinary lines.
      for (let k = i; k < j; k++) {
        const lk = lines[k] as [number, number];
        pushSpan(lk[0], lk[1], false);
      }
    } else {
      pushSpan(l[0], last[1], j - i === 1 && (HEADING_RE.test(t) || PAGE_RE.test(t)));
    }
    i = j;
  }

  const chunks: SourceChunk[] = [];
  let heading: string | undefined;
  let cur: { start: number; end: number; heading: string | undefined } | null = null;
  const flush = (): void => {
    if (cur && text.slice(cur.start, cur.end).trim() !== '') {
      chunks.push({
        sourceIndex,
        index: chunks.length,
        start: cur.start,
        end: cur.end,
        ...(cur.heading ? { heading: cur.heading } : {}),
        text: text.slice(cur.start, cur.end),
      });
    }
    cur = null;
  };
  for (const u of units) {
    if (u.boundary) {
      flush();
      heading = headingLabel(text.slice(u.start, u.end)) || heading;
    }
    if (cur !== null && u.end - (cur as { start: number }).start > CHUNK_TARGET_CHARS) flush();
    if (cur === null) cur = { start: u.start, end: u.end, heading };
    else (cur as { end: number }).end = u.end;
  }
  flush();
  return chunks;
}

// ---- rendering ----

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const label200 = (s: string): string => oneLine(s).slice(0, 200) || 'source';

function renderSection(s: SectionDraft): string {
  return `### ${sectionText(s)}`;
}

function renderTab(t: DeepAskTab, sections: readonly SectionDraft[]): string {
  return wrapSource(`tab: ${label200(t.label)} (${t.kind})`, sections.map(renderSection).join('\n\n'));
}

function renderTabs(tabs: readonly DeepAskTab[]): string {
  return tabs.map((t) => renderTab(t, t.sections)).join('\n\n');
}

function sourceAttrs(s: DeepAskSource): [string, string][] {
  return [
    ['format', oneLine(s.format).slice(0, 40)],
    ['truncated', String(s.truncated)],
  ];
}

function renderFullSource(s: DeepAskSource): string {
  return wrapSource(`original source: ${label200(s.label)}`, s.text ?? '', undefined, sourceAttrs(s));
}

function renderUnavailable(list: readonly DeepAskSource[]): string {
  if (list.length === 0) return '';
  return wrapSource(
    'sources not available as text',
    list.map((s) => `- ${label200(s.label)} (${oneLine(s.format).slice(0, 40) || 'unknown'})`).join('\n'),
  );
}

const joinParts = (parts: readonly string[]): string => parts.filter((p) => p !== '').join('\n\n');

function marker(c: SourceChunk, total: number): string {
  return `[excerpt ${c.index + 1} of ${total}, characters ${c.start + 1}-${c.end}${c.heading ? `; under: ${c.heading}` : ''}]`;
}

const GAP = '[…]';

/** One source's excerpts in position order, with `[…]` for every gap (before, between, after). */
function renderExcerptSource(s: DeepAskSource, all: readonly SourceChunk[], chosen: ReadonlySet<number>): string {
  const lines: string[] = [];
  let prev = -1;
  for (const c of all) {
    if (!chosen.has(c.index)) continue;
    if (c.index !== prev + 1) lines.push(GAP);
    lines.push(marker(c, all.length), c.text);
    prev = c.index;
  }
  if (prev < all.length - 1) lines.push(GAP);
  return wrapSource(`original source: ${label200(s.label)}`, lines.join('\n'), undefined, sourceAttrs(s));
}

// ---- planning ----

export interface DeepContextInput {
  tabs: DeepAskTab[];
  sources: DeepAskSource[] | null;
  selection: string;
  question: string;
}

export interface DeepContext {
  explanation: string;
  sources: string;
  plan: Omit<DeepAskPlan, 'inputTokens'>;
}

/**
 * Tabs that may be dropped, in drop order: Deadpan (never meant to reach this planner: 08 §6.9 leaves
 * it out of the material; dropped first as a defence, since jokes must not ground answers), then
 * section-ELI5 (last first), then STE, then ELI5.
 */
function dropOrder(tabs: readonly DeepAskTab[]): DeepAskTab[] {
  const rev = [...tabs].reverse();
  return [
    ...rev.filter((t) => t.kind === 'deadpan'),
    ...rev.filter((t) => t.kind === 'section-eli5'),
    ...rev.filter((t) => t.kind === 'ste'),
    ...rev.filter((t) => t.kind === 'eli5'),
  ];
}

const tok = estimateTokens;

/**
 * Keeps whole In depth sections by BM25 score against the query until the rendered tabs fit `room`
 * (zero sections allowed; a tab with no section left is not rendered). Document order is kept.
 */
function trimIndepth(indepth: readonly DeepAskTab[], query: readonly string[], room: number): string {
  const all = indepth.flatMap((t, ti) => t.sections.map((s, si) => ({ ti, si, s })));
  const scores = bm25Scores(
    all.map((x) => lexTokens(sectionText(x.s))),
    query,
  );
  const order = all.map((x, i) => ({ ...x, i, score: scores[i] ?? 0 })).sort((a, b) => b.score - a.score || a.i - b.i);
  const kept = new Set<number>();
  const render = (): string =>
    indepth
      .map((t, ti) => {
        const secs = all.filter((x, i) => x.ti === ti && kept.has(i)).map((x) => x.s);
        return secs.length ? renderTab(t, secs) : '';
      })
      .filter((x) => x !== '')
      .join('\n\n');
  for (const x of order) {
    kept.add(x.i);
    if (tok(render()) > room) kept.delete(x.i);
  }
  return render();
}

/**
 * Plans the deep context for `availTokens` (02 §8, 08 §6.9): everything when it fits; else drop tabs
 * (section-ELI5, STE, ELI5; never In depth); else keep only In depth and send source excerpts chosen
 * by BM25, trimming In depth to leave the sources at least half the room. With no kept text, mode
 * 'none' fits the tabs alone. Invariant: tokens(explanation) + tokens(sources) <= availTokens.
 */
export function planDeepContext(m: DeepContextInput, availTokens: number): DeepContext {
  if (!(availTokens >= DEEP_ASK_MIN_TOKENS)) throw new DeepContextTooLargeError();
  const avail = Math.floor(availTokens);
  const withText = (m.sources ?? []).filter((s) => s.text !== null && s.text.trim() !== '');
  const unavailable = (m.sources ?? []).filter((s) => !(s.text !== null && s.text.trim() !== ''));
  const indepth = m.tabs.filter((t) => t.kind === 'indepth');
  const droppable = dropOrder(m.tabs);
  const keys = (tabs: readonly DeepAskTab[]): string[] => tabs.map((t) => t.key);
  const result = (explanation: string, sources: string, plan: Omit<DeepAskPlan, 'inputTokens'>): DeepContext => {
    if (tok(explanation) + tok(sources) > avail) throw new DeepContextTooLargeError();
    return { explanation, sources, plan };
  };

  /** Drops tabs in order until the explanation fits `room`; null when In depth alone does not fit. */
  const fitTabs = (room: number): { kept: DeepAskTab[]; dropped: DeepAskTab[]; text: string } | null => {
    const dropped: DeepAskTab[] = [];
    for (let i = 0; ; i++) {
      const kept = m.tabs.filter((t) => !dropped.includes(t));
      const text = renderTabs(kept);
      if (tok(text) <= room) return { kept, dropped, text };
      const next = droppable[i];
      if (!next) return null;
      dropped.push(next);
    }
  };

  // ---- mode 'none': no kept text ----
  if (withText.length === 0) {
    let sources = renderUnavailable(unavailable);
    if (tok(sources) > avail) sources = '';
    const room = avail - tok(sources);
    const fit = fitTabs(room);
    if (fit) {
      return result(fit.text, sources, {
        sourceMode: 'none',
        tabsKept: keys(fit.kept),
        tabsDropped: keys(fit.dropped),
        indepthTrimmed: false,
        chunks: 0,
      });
    }
    const corpus = indepth.flatMap((t) => t.sections.map((s) => lexTokens(sectionText(s))));
    const explanation = trimIndepth(indepth, buildQuery(m.question, m.selection, corpus), room);
    return result(explanation, sources, {
      sourceMode: 'none',
      tabsKept: keys(indepth),
      tabsDropped: keys(droppable),
      indepthTrimmed: true,
      chunks: 0,
    });
  }

  // ---- mode 'all': every source whole, tabs dropped as needed ----
  const unavailableText = renderUnavailable(unavailable);
  const fullSources = joinParts([...withText.map(renderFullSource), unavailableText]);
  if (tok(fullSources) < avail) {
    const fit = fitTabs(avail - tok(fullSources));
    if (fit) {
      return result(fit.text, fullSources, {
        sourceMode: 'all',
        tabsKept: keys(fit.kept),
        tabsDropped: keys(fit.dropped),
        indepthTrimmed: false,
        chunks: 0,
      });
    }
  }

  // ---- mode 'excerpts': In depth (maybe trimmed) plus the best-matching source chunks ----
  const perSource = withText.map((s, i) => chunkSourceText(s.text ?? '', i));
  const chunks = perSource.flat();
  const chunkTokens = chunks.map((c) => lexTokens(c.text));
  const query = buildQuery(m.question, m.selection, chunkTokens);
  const scores = bm25Scores(chunkTokens, query);
  const keyOf = (c: SourceChunk): string => `${c.sourceIndex}:${c.index}`;
  const ranked = chunks
    .map((c, i) => ({ c, i, score: scores[i] ?? 0 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.c);

  // Priority: top 3, their neighbours, each source's first chunk, every other match by score. With no
  // match at all: first chunks in source order, then the rest in order.
  const priority: SourceChunk[] = [];
  const seen = new Set<string>();
  const add = (c: SourceChunk | undefined): void => {
    if (c && !seen.has(keyOf(c))) {
      seen.add(keyOf(c));
      priority.push(c);
    }
  };
  const top = ranked.slice(0, DEEP_ASK_TOP_CHUNKS);
  top.forEach(add);
  for (const c of top) {
    const list = perSource[c.sourceIndex] ?? [];
    add(list[c.index - 1]);
    add(list[c.index + 1]);
  }
  perSource.forEach((list) => add(list[0]));
  ranked.forEach(add);
  if (ranked.length === 0) chunks.forEach(add);

  const chosen = perSource.map(() => new Set<number>());
  const renderSources = (withUnavailable: boolean): string =>
    joinParts([
      ...withText.map((s, i) =>
        (chosen[i] as Set<number>).size ? renderExcerptSource(s, perSource[i] ?? [], chosen[i] as Set<number>) : '',
      ),
      withUnavailable ? unavailableText : '',
    ]);
  const choose = (c: SourceChunk): void => void (chosen[c.sourceIndex] as Set<number>).add(c.index);
  const unchoose = (c: SourceChunk): void => void (chosen[c.sourceIndex] as Set<number>).delete(c.index);

  // The room the top chunks need, rendered with their markers and wrappers.
  top.forEach(choose);
  const topTokens = tok(renderSources(true));
  top.forEach(unchoose);
  const sourceBudget = Math.min(avail, Math.max(Math.floor(avail * DEEP_ASK_MIN_SOURCE_SHARE), topTokens));

  let explanation = renderTabs(indepth);
  let indepthTrimmed = false;
  if (tok(explanation) > avail - sourceBudget) {
    explanation = trimIndepth(indepth, query, avail - sourceBudget);
    indepthTrimmed = true;
  }
  const cap = avail - tok(explanation);

  // Greedy by priority on an incremental estimate (length and CJK count), then an exact check that
  // removes the latest additions until the rendered text fits. A chunk that does not fit is skipped.
  let withUnavailable = tok(unavailableText) <= cap;
  const base = renderSources(withUnavailable);
  let len = base.length;
  let cjk = cjkCount(base);
  const wrapperLen = withText.map(
    (s) => wrapSource(`original source: ${label200(s.label)}`, '', undefined, sourceAttrs(s)).length,
  );
  const started = new Set<number>();
  const added: SourceChunk[] = [];
  const total = (n: number): number => (perSource[n] ?? []).length;
  for (const c of priority) {
    const piece = marker(c, total(c.sourceIndex)) + '\n' + c.text;
    const extra =
      piece.length +
      2 * (GAP.length + 1) +
      1 +
      (started.has(c.sourceIndex) ? 0 : (wrapperLen[c.sourceIndex] ?? 0) + 2) +
      countSourceTags(c.text);
    const nextLen = len + extra;
    const nextCjk = cjk + cjkCount(piece);
    if (approxTokens(nextLen, nextCjk) > cap) continue;
    choose(c);
    started.add(c.sourceIndex);
    added.push(c);
    len = nextLen;
    cjk = nextCjk;
  }
  let sources = renderSources(withUnavailable);
  while (tok(sources) > cap && added.length > 0) {
    unchoose(added.pop() as SourceChunk);
    sources = renderSources(withUnavailable);
  }
  if (tok(sources) > cap && withUnavailable) {
    withUnavailable = false;
    sources = renderSources(false);
  }
  return result(explanation, sources, {
    sourceMode: 'excerpts',
    tabsKept: keys(indepth),
    tabsDropped: keys(droppable),
    indepthTrimmed,
    chunks: added.length,
  });
}

function countSourceTags(s: string): number {
  return s.match(/<\/?source/gi)?.length ?? 0;
}

/** estimateTokens from a length and a CJK count (same formula as budget.ts). */
function approxTokens(len: number, cjk: number): number {
  if (len === 0) return 0;
  return Math.ceil(len / (cjk / len > 0.3 ? 1.5 : 3.5));
}
