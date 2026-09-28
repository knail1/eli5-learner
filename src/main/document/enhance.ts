// Deterministic enhancement marks for woven merges (07 §6.4, 09 §10.3). The model never marks
// spans: each revised block is diffed against the block it replaces, word by word over its plain
// text, and the inserted runs become EnhRanges. Earlier merges' ranges are carried through the
// words that did not change.
import { canonicalJson } from './canonical-json';
import { inlineText } from './inline-md';
import type { BlockEnhancement, DocBlock, EnhRange, SectionEnhancement } from './types';

interface Token {
  s: string;
  start: number;
  end: number;
}

/** Words (with inner apostrophes, hyphens, decimal points and thousands separators) and single symbols. */
const TOKEN_RE = /[\p{L}\p{N}]+(?:['’.,-][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;
/** Sentence punctuation trimmed from the edges of an inserted run (a moved comma is not an enhancement). */
const EDGE_PUNCT_RE = /^[,.;:!?…'"“”‘’()[\]—–-]$/u;
const WORDISH_RE = /[\p{L}\p{N}]/u;
/** DP cells above which the middle of a long rewrite is treated as wholly new. */
export const MAX_DIFF_CELLS = 250_000;
/** Minimum similarity for a written block (or list item) to count as a revision of an old one. */
export const MIN_BLOCK_SIMILARITY = 0.35;

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) out.push({ s: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

/** Index pairs [old, new] of a longest common subsequence; prefix and suffix are trimmed first. */
function lcsPairs(a: readonly string[], b: readonly string[]): [number, number][] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const pairs: [number, number][] = [];
  for (let i = 0; i < p; i++) pairs.push([i, i]);
  const n = a.length - p - q;
  const m = b.length - p - q;
  if (n > 0 && m > 0 && n * m <= MAX_DIFF_CELLS) {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * w + j] =
          a[p + i] === b[p + j]
            ? (dp[(i + 1) * w + j + 1] ?? 0) + 1
            : Math.max(dp[(i + 1) * w + j] ?? 0, dp[i * w + j + 1] ?? 0);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[p + i] === b[p + j]) {
        pairs.push([p + i, p + j]);
        i++;
        j++;
      } else if ((dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + j + 1] ?? 0)) i++;
      else j++;
    }
  }
  for (let k = 0; k < q; k++) pairs.push([a.length - q + k, b.length - q + k]);
  return pairs;
}

/** Share of words two texts have in common, in order (Dice coefficient over the LCS). */
function similarity(a: string, b: string): number {
  const ta = tokenize(a).map((t) => t.s.toLowerCase());
  const tb = tokenize(b).map((t) => t.s.toLowerCase());
  if (ta.length === 0 && tb.length === 0) return 1;
  if (ta.length === 0 || tb.length === 0) return 0;
  return (2 * lcsPairs(ta, tb).length) / (ta.length + tb.length);
}

/**
 * Inserted runs of `next` versus `prev` (both plain text) for merge `merge`, plus the ranges of
 * `prevRanges` (earlier merges) carried through the words that stayed. Runs of the current merge
 * are trimmed of edge punctuation and dropped when they hold no letter or digit.
 */
export function diffInline(
  prev: string,
  next: string,
  merge: string,
  prevRanges: readonly EnhRange[] = [],
): EnhRange[] {
  const b = tokenize(next);
  if (!b.some((t) => WORDISH_RE.test(t.s))) return [];
  const a = tokenize(prev);
  const pairs = lcsPairs(
    a.map((t) => t.s),
    b.map((t) => t.s),
  );
  if (pairs.length === 0) return [{ merge, start: 0, end: next.length }];
  const labels: (string | undefined)[] = b.map(() => merge);
  for (const [i, j] of pairs) {
    const t = a[i];
    labels[j] = t ? prevRanges.find((r) => t.start >= r.start && t.end <= r.end)?.merge : undefined;
  }
  const out: EnhRange[] = [];
  let k = 0;
  while (k < b.length) {
    const label = labels[k];
    if (label === undefined) {
      k++;
      continue;
    }
    let end = k;
    while (end + 1 < b.length && labels[end + 1] === label) end++;
    let from = k;
    let to = end;
    if (label === merge) {
      while (from <= to && EDGE_PUNCT_RE.test(b[from]?.s ?? '')) from++;
      while (to >= from && EDGE_PUNCT_RE.test(b[to]?.s ?? '')) to--;
    }
    const run = b.slice(from, to + 1);
    const first = run[0];
    const last = run[run.length - 1];
    if (first && last && run.some((t) => WORDISH_RE.test(t.s)))
      out.push({ merge: label, start: first.start, end: last.end });
    k = end + 1;
  }
  return out;
}

/**
 * Plain text of each inline string a block renders with marks (07 §6.4): paragraph, callout and
 * analogy (1), list (one per item), stepper (one per step body). Undefined for every other block.
 */
export function blockTextParts(b: DocBlock): string[] | undefined {
  switch (b.type) {
    case 'paragraph':
    case 'callout':
    case 'analogy':
      return [inlineText(b.md)];
    case 'list':
      return b.items.map(inlineText);
    case 'stepper':
      return b.steps.map((s) => inlineText(s.md));
    default:
      return undefined;
  }
}

/** Where a block of a revised section came from (09 §10.3 plan blocks). */
export type BlockOrigin = { kind: 'keep'; index: number } | { kind: 'incoming' } | { kind: 'written' };

export interface EnhanceBlocksInput {
  oldBlocks: readonly DocBlock[];
  /** The section's marks before this merge. */
  oldEnh?: SectionEnhancement;
  newBlocks: readonly DocBlock[];
  /** One per new block. */
  origins: readonly BlockOrigin[];
  merge: string;
}

/** Ranges each old inline string already carries (a whole-block mark covers every string). */
function oldPartRanges(enh: BlockEnhancement | undefined, parts: readonly string[]): EnhRange[][] {
  if (!enh) return parts.map(() => []);
  if (enh.kind === 'text') return parts.map((_, i) => enh.parts[i] ?? []);
  return parts.map((p) => [{ merge: enh.merge, start: 0, end: p.length }]);
}

/** Pairs each new string with the most similar unused old one (at least MIN_BLOCK_SIMILARITY). */
function alignStrings(oldParts: readonly string[], newParts: readonly string[]): (number | undefined)[] {
  const used = new Set<number>();
  return newParts.map((np) => {
    let best: number | undefined;
    let bestScore = MIN_BLOCK_SIMILARITY;
    oldParts.forEach((op, i) => {
      if (used.has(i)) return;
      const score = op === np ? 2 : similarity(op, np);
      if (score >= bestScore) {
        best = i;
        bestScore = score;
      }
    });
    if (best !== undefined) used.add(best);
    return best;
  });
}

/** Marks for a written text block that revises `old`; undefined when nothing was inserted. */
function textMarks(
  old: DocBlock,
  oldMark: BlockEnhancement | undefined,
  next: DocBlock,
  block: number,
  merge: string,
): BlockEnhancement | undefined {
  const oldParts = blockTextParts(old) ?? [];
  const newParts = blockTextParts(next) ?? [];
  const oldRanges = oldPartRanges(oldMark, oldParts);
  const pairs = oldParts.length === 1 && newParts.length === 1 ? [0] : alignStrings(oldParts, newParts);
  const parts = newParts.map((np, i) => {
    const o = pairs[i];
    return o === undefined ? diffInline('', np, merge) : diffInline(oldParts[o] ?? '', np, merge, oldRanges[o]);
  });
  return parts.some((p) => p.length > 0) ? { block, kind: 'text', parts } : undefined;
}

/**
 * The marks of a revised section's blocks (07 §6.4): kept blocks keep their earlier marks, incoming
 * and unmatched written blocks are 'new', a written block that revises an old one is diffed ('text'
 * for text blocks, 'updated' for a changed visual).
 */
export function enhanceBlocks(input: EnhanceBlocksInput): BlockEnhancement[] {
  const { oldBlocks, newBlocks, origins, merge } = input;
  const oldMarks = new Map((input.oldEnh?.blocks ?? []).map((e) => [e.block, e]));
  const carry = (from: number, to: number): BlockEnhancement | undefined => {
    const e = oldMarks.get(from);
    return e ? { ...e, block: to } : undefined;
  };
  const kept = new Set(origins.flatMap((o) => (o.kind === 'keep' ? [o.index] : [])));
  const free = new Set(oldBlocks.map((_, i) => i).filter((i) => !kept.has(i)));
  const out: BlockEnhancement[] = [];
  newBlocks.forEach((nb, k) => {
    const origin = origins[k] ?? { kind: 'written' };
    if (origin.kind === 'keep') {
      const e = carry(origin.index, k);
      if (e) out.push(e);
      return;
    }
    if (origin.kind === 'incoming') {
      out.push({ block: k, kind: 'new', merge });
      return;
    }
    const nbJson = canonicalJson(nb);
    const same = [...free].find((i) => canonicalJson(oldBlocks[i]) === nbJson);
    if (same !== undefined) {
      free.delete(same);
      const e = carry(same, k);
      if (e) out.push(e);
      return;
    }
    const parts = blockTextParts(nb);
    if (parts) {
      const text = parts.join('\n');
      let best: number | undefined;
      let bestScore = MIN_BLOCK_SIMILARITY;
      for (const i of free) {
        const op = blockTextParts(oldBlocks[i] as DocBlock);
        if (!op) continue;
        const score = similarity(op.join('\n'), text);
        if (score >= bestScore) {
          best = i;
          bestScore = score;
        }
      }
      if (best === undefined) {
        out.push({ block: k, kind: 'new', merge });
        return;
      }
      free.delete(best);
      const e = textMarks(oldBlocks[best] as DocBlock, oldMarks.get(best), nb, k, merge);
      if (e) out.push(e);
      return;
    }
    const sameType = [...free].find((i) => oldBlocks[i]?.type === nb.type);
    if (sameType === undefined) {
      out.push({ block: k, kind: 'new', merge });
      return;
    }
    free.delete(sameType);
    out.push({ block: k, kind: 'updated', merge });
  });
  return out;
}
