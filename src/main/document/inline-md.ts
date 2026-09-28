// Inline markdown subset -> escaped HTML (07 §5.2): **bold**, *italic*, `code`, [text](url).
// Everything else is escaped text. Glossary anchors (07 §9.2) are wrapped in <dfn> here.
import { attrs, esc } from './html';
import type { EnhRange } from './types';

export type InlineNode =
  | { t: 'text'; s: string }
  | { t: 'strong'; c: InlineNode[] }
  | { t: 'em'; c: InlineNode[] }
  | { t: 'code'; s: string }
  | { t: 'link'; href: string; s: string };

const LINK_RE = /^\[([^\]\n]+)\]\(([^()\s]+)\)/;

function pushText(out: InlineNode[], s: string): void {
  if (s === '') return;
  const last = out[out.length - 1];
  if (last && last.t === 'text') last.s += s;
  else out.push({ t: 'text', s });
}

/** Parses the inline subset. Unclosed markers stay literal text. */
export function parseInline(md: string, inStrong = false, inEm = false): InlineNode[] {
  const out: InlineNode[] = [];
  let i = 0;
  while (i < md.length) {
    const ch = md[i];
    const rest = md.slice(i);
    if (ch === '\\' && i + 1 < md.length && /[\\`*[\]()_]/.test(md[i + 1] ?? '')) {
      pushText(out, md[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = md.indexOf('`', i + 1);
      if (end > i + 1) {
        out.push({ t: 'code', s: md.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const m = LINK_RE.exec(rest);
      if (m) {
        out.push({ t: 'link', href: m[2] ?? '', s: m[1] ?? '' });
        i += m[0].length;
        continue;
      }
    }
    if (!inStrong && rest.startsWith('**')) {
      const end = md.indexOf('**', i + 2);
      if (end > i + 2) {
        out.push({ t: 'strong', c: parseInline(md.slice(i + 2, end), true, inEm) });
        i = end + 2;
        continue;
      }
    }
    if (!inEm && ch === '*' && md[i + 1] !== '*' && md[i + 1] !== ' ') {
      let end = i + 1;
      // closing single '*' that is not part of '**'
      while ((end = md.indexOf('*', end)) !== -1 && md[end + 1] === '*') end += 2;
      if (end > i + 1 && md[end - 1] !== ' ') {
        out.push({ t: 'em', c: parseInline(md.slice(i + 1, end), inStrong, true) });
        i = end + 1;
        continue;
      }
    }
    pushText(out, ch ?? '');
    i++;
  }
  return out;
}

/** Allowed link schemes (07 §5.2). Returns the href to emit, or undefined to render text only. */
export function safeHref(href: string): string | undefined {
  try {
    const u = new URL(href);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') return u.href;
  } catch {
    // relative or malformed: text only
  }
  return undefined;
}

/** Text runs that may hold a glossary anchor: text nodes, including inside bold/italic (07 §9.1 step 3). */
export function textRuns(nodes: InlineNode[]): { s: string }[] {
  const runs: { s: string }[] = [];
  const walk = (ns: InlineNode[]): void => {
    for (const n of ns) {
      if (n.t === 'text') runs.push(n);
      else if (n.t === 'strong' || n.t === 'em') walk(n.c);
    }
  };
  walk(nodes);
  return runs;
}

/** Plain text of an inline string (for summaries, labels and matching). */
export function inlineText(md: string): string {
  const walk = (ns: InlineNode[]): string =>
    ns.map((n) => (n.t === 'strong' || n.t === 'em' ? walk(n.c) : n.s)).join('');
  return walk(parseInline(md));
}

export interface DfnAnchor {
  text: string;
  noteId: string;
}

interface Split {
  run: { s: string };
  start: number;
  end: number;
  noteId: string;
}

/**
 * Finds the first exact, non-overlapping occurrence of each anchor in the text runs. Returns the
 * anchors that were not placed.
 */
function placeAnchors(runs: { s: string }[], anchors: readonly DfnAnchor[], splits: Split[]): DfnAnchor[] {
  const missing: DfnAnchor[] = [];
  for (const a of anchors) {
    let placed = false;
    for (const run of runs) {
      let from = 0;
      for (;;) {
        const at = run.s.indexOf(a.text, from);
        if (at < 0 || a.text === '') break;
        const end = at + a.text.length;
        if (!splits.some((sp) => sp.run === run && at < sp.end && end > sp.start)) {
          splits.push({ run, start: at, end, noteId: a.noteId });
          placed = true;
          break;
        }
        from = at + 1;
      }
      if (placed) break;
    }
    if (!placed) missing.push(a);
  }
  return missing;
}

/**
 * Enhancement marks for one inline string (07 §6.4): ranges over its plain text and the opening
 * `<ins>` tag for a merge id.
 */
export interface InlineMarks {
  ranges: readonly EnhRange[];
  open(merge: string): string;
}

/** Walk state: plain-text offset of the next node and the string's marks. */
interface Cursor {
  pos: number;
  marks?: InlineMarks | undefined;
}

/** `text` (at plain-text offset `at`) with the marked parts wrapped in `<ins>`. */
function markText(text: string, at: number, marks: InlineMarks | undefined): string {
  if (!marks || marks.ranges.length === 0) return esc(text);
  let out = '';
  let pos = 0;
  const end = at + text.length;
  for (const r of [...marks.ranges].sort((a, b) => a.start - b.start)) {
    const from = Math.max(r.start, at) - at;
    const to = Math.min(r.end, end) - at;
    if (to <= from || from < pos) continue;
    out += esc(text.slice(pos, from)) + marks.open(r.merge) + esc(text.slice(from, to)) + '</ins>';
    pos = to;
  }
  return out + esc(text.slice(pos));
}

/** The merge whose range overlaps [start, end), for atomic nodes (code, links). */
function markOf(start: number, end: number, marks: InlineMarks | undefined): string | undefined {
  return marks?.ranges.find((r) => r.start < end && r.end > start)?.merge;
}

function renderRun(run: { s: string }, splits: Split[], cur: Cursor): string {
  const at = cur.pos;
  cur.pos += run.s.length;
  const mine = splits.filter((s) => s.run === run).sort((a, b) => a.start - b.start);
  if (mine.length === 0) return markText(run.s, at, cur.marks);
  let out = '';
  let pos = 0;
  for (const sp of mine) {
    out += markText(run.s.slice(pos, sp.start), at + pos, cur.marks);
    out += `<dfn${attrs([
      ['class', 'gl-term'],
      ['id', `${sp.noteId}-ref`],
      ['aria-describedby', sp.noteId],
    ])}>${markText(run.s.slice(sp.start, sp.end), at + sp.start, cur.marks)}</dfn>`;
    pos = sp.end;
  }
  return out + markText(run.s.slice(pos), at + pos, cur.marks);
}

/** Wraps an atomic node's HTML in `<ins>` when a mark overlaps it; advances the cursor. */
function atomic(html: string, length: number, cur: Cursor): string {
  const merge = markOf(cur.pos, cur.pos + length, cur.marks);
  cur.pos += length;
  return merge && cur.marks ? `${cur.marks.open(merge)}${html}</ins>` : html;
}

function renderNodes(nodes: InlineNode[], splits: Split[], cur: Cursor = { pos: 0 }): string {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
        out += renderRun(n, splits, cur);
        break;
      case 'strong':
        out += `<strong>${renderNodes(n.c, splits, cur)}</strong>`;
        break;
      case 'em':
        out += `<em>${renderNodes(n.c, splits, cur)}</em>`;
        break;
      case 'code':
        out += atomic(`<code>${esc(n.s)}</code>`, n.s.length, cur);
        break;
      case 'link': {
        const href = safeHref(n.href);
        out += atomic(
          href
            ? `<a${attrs([
                ['href', href],
                ['target', '_blank'],
                ['rel', 'noopener noreferrer'],
              ])}>${esc(n.s)}</a>`
            : esc(n.s),
          n.s.length,
          cur,
        );
        break;
      }
    }
  }
  return out;
}

/**
 * Renders a list of inline strings (one per paragraph or list item), wrapping each anchor's first
 * occurrence (in string order) in a <dfn>. Returns the HTML per string and the unplaced anchors.
 */
export function renderInlineMany(
  mds: readonly string[],
  anchors: readonly DfnAnchor[] = [],
  marks: readonly (InlineMarks | undefined)[] = [],
): { html: string[]; missing: DfnAnchor[] } {
  const parsed = mds.map((md) => parseInline(md));
  const splits: Split[] = [];
  let pending: DfnAnchor[] = [...anchors];
  for (const nodes of parsed) {
    if (pending.length === 0) break;
    pending = placeAnchors(textRuns(nodes), pending, splits);
  }
  return { html: parsed.map((nodes, i) => renderNodes(nodes, splits, { pos: 0, marks: marks[i] })), missing: pending };
}

/** Renders one inline string. */
export function renderInline(md: string, anchors: readonly DfnAnchor[] = [], marks?: InlineMarks): string {
  return renderInlineMany([md], anchors, [marks]).html[0] ?? '';
}
