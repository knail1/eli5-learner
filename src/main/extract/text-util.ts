/** Text normalization shared by all extractors (04 §2 invariant 4, §6.1 bullet patterns). */
import type { ContentBlock, ExtractedContent, ExtractStats, ListItem } from './types';

// Control characters other than \t and \n (plus DEL and C1 controls).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** NFC, control characters removed, whitespace runs collapsed to one space, trimmed. */
export function cleanInline(s: string): string {
  return s.normalize('NFC').replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(/\s+/g, ' ').trim();
}

/** Like cleanInline but keeps line breaks (notes, code): collapses spaces within each line. */
export function cleanMultiline(s: string, opts: { keepIndent?: boolean } = {}): string {
  const lines = s
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .split('\n')
    .map((l) => (opts.keepIndent ? l.replace(/\s+$/, '') : l.replace(/[^\S\n]+/g, ' ').trim()));
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** True when the text still has characters invariant 4 forbids. */
export function hasForbiddenChars(s: string): boolean {
  CONTROL.lastIndex = 0;
  return CONTROL.test(s) || s.normalize('NFC') !== s;
}

/** 04 §6.1 list markers: • ◦ ▪ – - * and "1." "1)" "a." "a)". */
export const BULLET_RE = /^(\s*)([•◦▪–\-*]|\d{1,3}[.)]|[a-z][.)])\s+(\S.*)$/;

export interface BulletMatch {
  indent: number;
  ordered: boolean;
  text: string;
}

export function matchBullet(line: string): BulletMatch | null {
  const m = BULLET_RE.exec(line);
  if (!m) return null;
  const marker = m[2] ?? '';
  return {
    indent: (m[1] ?? '').replace(/\t/g, '    ').length,
    ordered: /^[\da-z]/.test(marker),
    text: m[3] ?? '',
  };
}

/**
 * Builds a nested list from (level, text) pairs. A deeper item becomes a child of the most recent
 * shallower item; a jump of several levels attaches to the nearest shallower item (04 §5.1 step 4).
 */
export function buildNestedList(entries: ReadonlyArray<{ level: number; text: string }>): ListItem[] {
  const root: ListItem[] = [];
  const stack: Array<{ level: number; item: ListItem }> = [];
  for (const e of entries) {
    const item: ListItem = { text: e.text };
    while (stack.length && stack[stack.length - 1]!.level >= e.level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) (parent.item.children ??= []).push(item);
    else root.push(item);
    stack.push({ level: e.level, item });
  }
  return root;
}

function listChars(items: readonly ListItem[]): number {
  let n = 0;
  for (const it of items) n += it.text.length + (it.children ? listChars(it.children) : 0);
  return n;
}

/** Total text characters across blocks (ExtractStats.chars). */
export function countChars(blocks: readonly ContentBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    switch (b.kind) {
      case 'heading':
      case 'paragraph':
      case 'notes':
        n += b.text.length;
        break;
      case 'list':
        n += listChars(b.items);
        break;
      case 'table':
        n += (b.caption?.length ?? 0) + (b.header ?? []).reduce((a, c) => a + c.length, 0);
        for (const r of b.rows) for (const c of r) n += c.length;
        break;
      case 'slide':
        n += (b.title?.length ?? 0) + countChars(b.blocks) + (b.notes?.text.length ?? 0);
        break;
      case 'page':
        n += countChars(b.blocks);
        break;
      case 'image':
        break;
    }
  }
  return n;
}

export function emptyStats(): ExtractStats {
  return { chars: 0, approxTokens: 0, imagesKept: 0, imagesDropped: 0, elapsedMs: 0 };
}

/** Skeleton ExtractedContent for a source; extractSource fills chars, tokens and elapsed time. */
export function newContent(
  source: { id: string; ref: string; format: ExtractedContent['format'] },
  init: Partial<Omit<ExtractedContent, 'sourceId' | 'sourceRef'>> = {},
): ExtractedContent {
  return {
    sourceId: source.id,
    sourceRef: source.ref,
    format: init.format ?? source.format,
    ...(init.title !== undefined ? { title: init.title } : {}),
    blocks: init.blocks ?? [],
    images: init.images ?? [],
    stats: init.stats ?? emptyStats(),
    warnings: init.warnings ?? [],
    truncated: init.truncated ?? false,
  };
}

/** "1 slide" / "3 slides". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
