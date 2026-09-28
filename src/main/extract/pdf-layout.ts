/**
 * Text-PDF layout heuristics (04 §6.1 steps 2.2-2.6, step 3), pure functions over positioned text
 * items so they are testable without pdf.js. Coordinates are PDF user space (y grows upward).
 */
import { buildNestedList, cleanInline, matchBullet } from './text-util';
import type { ContentBlock } from './types';

export interface PItem {
  str: string;
  x: number;
  /** Baseline y (transform[5]). */
  y: number;
  w: number;
  /** Font height. */
  h: number;
}

export interface PLine {
  text: string;
  x: number;
  y: number;
  h: number;
  right: number;
  items: PItem[];
}

export interface PageGeom {
  x0: number;
  y0: number;
  width: number;
  height: number;
}

export function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Joins items left to right, inserting a space when the gap exceeds 0.15 × font height. */
export function makeLine(items: readonly PItem[]): PLine {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  let text = '';
  let prevRight = -Infinity;
  for (const it of sorted) {
    const h = it.h || 1;
    if (text && !/\s$/.test(text) && !/^\s/.test(it.str) && it.x - prevRight > 0.15 * h) text += ' ';
    text += it.str;
    prevRight = Math.max(prevRight, it.x + it.w);
  }
  const first = sorted[0]!;
  return {
    text: cleanInline(text),
    x: first.x,
    y: median(sorted.map((i) => i.y)),
    h: median(sorted.map((i) => i.h)),
    right: prevRight,
    items: sorted,
  };
}

/** Groups items by baseline with a tolerance of 0.5 × the median item height; top to bottom. */
export function assembleLines(items: readonly PItem[]): PLine[] {
  const usable = items.filter((i) => i.str.trim() !== '' || i.str === ' ');
  if (!usable.length) return [];
  const tol = 0.5 * (median(usable.map((i) => i.h)) || 1);
  const sorted = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: PItem[][] = [];
  let baseY = Infinity;
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(it.y - baseY) <= tol) g.push(it);
    else {
      groups.push([it]);
      baseY = it.y;
    }
  }
  return groups.map(makeLine).filter((l) => l.text !== '');
}

function overlaps(it: PItem, gs: number, ge: number): boolean {
  return it.x < ge && it.x + it.w > gs;
}

/**
 * Finds a vertical gutter wider than 5% of the page width that no item crosses on at least 60%
 * of lines, with text on both sides (04 §6.1 step 2.3).
 */
export function detectGutter(lines: readonly PLine[], g: PageGeom): { start: number; end: number } | null {
  if (lines.length < 4 || g.width <= 0) return null;
  const BINS = 200;
  const bw = g.width / BINS;
  const cover = new Array<number>(BINS).fill(0);
  for (const l of lines) {
    const hit = new Array<boolean>(BINS).fill(false);
    for (const it of l.items) {
      const a = Math.max(0, Math.floor((it.x - g.x0) / bw));
      const b = Math.min(BINS - 1, Math.floor((it.x + it.w - g.x0) / bw));
      for (let k = a; k <= b; k++) hit[k] = true;
    }
    hit.forEach((h, k) => {
      if (h) cover[k]!++;
    });
  }
  const n = lines.length;
  let best: { start: number; end: number } | null = null;
  let k = 0;
  while (k < BINS) {
    if (cover[k]! > 0.4 * n) {
      k++;
      continue;
    }
    let e = k;
    while (e + 1 < BINS && cover[e + 1]! <= 0.4 * n) e++;
    const start = g.x0 + k * bw;
    const end = g.x0 + (e + 1) * bw;
    if (end - start > 0.05 * g.width) {
      const mid = (start + end) / 2;
      const crossing = lines.filter((l) => l.items.some((it) => overlaps(it, mid - 0.5, mid + 0.5))).length;
      const left = lines.filter((l) => l.items.some((it) => it.x + it.w <= start + bw)).length;
      const right = lines.filter((l) => l.items.some((it) => it.x >= end - bw)).length;
      // The gutter holds (no item crosses it) on at least 60% of lines, with text on both sides.
      if (
        crossing <= 0.4 * n &&
        left >= 0.3 * n &&
        right >= 0.3 * n &&
        (!best || end - start > best.end - best.start)
      ) {
        best = { start, end };
      }
    }
    k = e + 1;
  }
  return best;
}

/**
 * Reading order: full-width lines in place, column regions left band then right band. A line is
 * full-width only when an item covers the gutter's midline; lines that merely reach into the
 * gutter (a long last word) stay in their column.
 */
export function orderLines(lines: readonly PLine[], g: PageGeom): PLine[] {
  const gutter = detectGutter(lines, g);
  if (!gutter) return [...lines];
  const mid = (gutter.start + gutter.end) / 2;
  const out: PLine[] = [];
  let left: PLine[] = [];
  let right: PLine[] = [];
  const flush = (): void => {
    out.push(...left, ...right);
    left = [];
    right = [];
  };
  for (const l of lines) {
    if (l.items.some((it) => overlaps(it, mid - 0.5, mid + 0.5))) {
      flush();
      out.push(l);
      continue;
    }
    const li = l.items.filter((it) => it.x + it.w / 2 < mid);
    const ri = l.items.filter((it) => it.x + it.w / 2 >= mid);
    if (li.length) left.push(makeLine(li));
    if (ri.length) right.push(makeLine(ri));
  }
  flush();
  return out.filter((l) => l.text !== '');
}

export function runningKey(text: string): string {
  return text.replace(/\d+/g, '#').trim().toLowerCase();
}

/**
 * Removes lines in the top or bottom 8% of the page that repeat (digits normalized to #) on more
 * than 50% of pages and on at least 3 pages (04 §6.1 step 3). Returns the number removed.
 */
export function removeRunningLines(pages: Array<{ lines: PLine[]; geom: PageGeom }>): number {
  const inZone = (l: PLine, g: PageGeom): boolean => l.y >= g.y0 + 0.92 * g.height || l.y <= g.y0 + 0.08 * g.height;
  const counts = new Map<string, number>();
  for (const p of pages) {
    const keys = new Set(p.lines.filter((l) => inZone(l, p.geom)).map((l) => runningKey(l.text)));
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const drop = new Set([...counts].filter(([, c]) => c >= 3 && c > 0.5 * pages.length).map(([k]) => k));
  let removed = 0;
  for (const p of pages) {
    const before = p.lines.length;
    p.lines = p.lines.filter((l) => !(inZone(l, p.geom) && drop.has(runningKey(l.text))));
    removed += before - p.lines.length;
  }
  return removed;
}

/** Size classes for headings: the largest is level 1, everything else level 2 (04 §6.1 step 2.5). */
export function headingLevels(lineHeights: readonly number[], bodyH: number): Map<number, 1 | 2> {
  const classes = [...new Set(lineHeights.filter((h) => h >= 1.3 * bodyH).map((h) => Math.round(h * 2) / 2))].sort(
    (a, b) => b - a,
  );
  return new Map(classes.map((c, i) => [c, i === 0 ? 1 : 2] as [number, 1 | 2]));
}

function joinLines(a: string, b: string): string {
  // De-hyphenation: "-" at line end followed by a lowercase letter (04 §6.1 step 2.4).
  if (/[A-Za-zÀ-ɏ]-$/.test(a) && /^[a-zß-ÿ]/.test(b)) return a.slice(0, -1) + b;
  return `${a} ${b}`;
}

/** Paragraphs, headings and lists from ordered lines (04 §6.1 steps 2.4-2.6). */
export function linesToBlocks(
  lines: readonly PLine[],
  bodyH: number,
  levels: ReadonlyMap<number, 1 | 2>,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let para: { text: string; x: number } | null = null;
  let list: { ordered: boolean; items: Array<{ level: number; text: string; x: number }>; xs: number[] } | null = null;
  let prev: PLine | null = null;
  const flushPara = (): void => {
    if (para?.text) blocks.push({ kind: 'paragraph', text: cleanInline(para.text) });
    para = null;
  };
  const flushList = (): void => {
    if (list?.items.length) blocks.push({ kind: 'list', ordered: list.ordered, items: buildNestedList(list.items) });
    list = null;
  };
  for (const l of lines) {
    const h = l.h || bodyH || 1;
    const gap = prev ? prev.y - l.y : 0;
    const columnJump = prev !== null && gap < -h;
    const bigGap = prev !== null && gap > 1.5 * Math.max(h, prev.h) * 1.2;
    const level = levels.get(Math.round(l.h * 2) / 2);
    if (level && l.text.length <= 120) {
      flushPara();
      flushList();
      blocks.push({ kind: 'heading', level, text: l.text });
      prev = l;
      continue;
    }
    const bullet = matchBullet(l.text);
    if (bullet) {
      flushPara();
      if (!list || bigGap) {
        flushList();
        list = { ordered: bullet.ordered, items: [], xs: [l.x] };
      }
      while (list.xs.length > 1 && l.x < list.xs[list.xs.length - 1]! - 0.5 * h) list.xs.pop();
      if (l.x > list.xs[list.xs.length - 1]! + 0.5 * h) list.xs.push(l.x);
      list.items.push({ level: list.xs.length - 1, text: cleanInline(bullet.text), x: l.x });
      prev = l;
      continue;
    }
    if (list && !bigGap && !columnJump) {
      const last = list.items[list.items.length - 1]!;
      if (l.x > last.x + 0.3 * h) {
        last.text = joinLines(last.text, l.text);
        prev = l;
        continue;
      }
    }
    flushList();
    const indentIn = para !== null && l.x > para.x + 0.8 * h && !columnJump;
    const sentenceEnd = para !== null && /[.!?:]$/.test(para.text);
    if (!para || bigGap || indentIn || (columnJump && sentenceEnd)) {
      flushPara();
      para = { text: l.text, x: l.x };
    } else {
      para.text = joinLines(para.text, l.text);
      if (!columnJump) para.x = Math.min(para.x, l.x);
      else para.x = l.x;
    }
    prev = l;
  }
  flushPara();
  flushList();
  return blocks;
}
