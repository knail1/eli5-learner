// parse5 helpers with source offsets, shared by parse.ts and validity.ts (07 §8, 13 §7.1).
import { parse, type DefaultTreeAdapterMap, type ParserError } from 'parse5';

export type P5Node = DefaultTreeAdapterMap['node'];
export type P5Element = DefaultTreeAdapterMap['element'];
export type P5Document = DefaultTreeAdapterMap['document'];

export interface ParsedTree {
  doc: P5Document;
  errors: ParserError[];
}

export function parseTree(html: string): ParsedTree {
  const errors: ParserError[] = [];
  const doc = parse(html, { sourceCodeLocationInfo: true, onParseError: (e) => errors.push(e) });
  return { doc, errors };
}

export function isElement(n: P5Node): n is P5Element {
  return 'tagName' in n;
}

export function attr(el: P5Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function childrenOf(n: P5Node): P5Node[] {
  if ('content' in n && n.nodeName === 'template') return n.content.childNodes;
  return 'childNodes' in n ? n.childNodes : [];
}

/** Depth-first walk over elements (document order). Return false from `visit` to skip children. */
export function walk(
  n: P5Node,
  visit: (el: P5Element, ancestors: readonly P5Element[]) => boolean | void,
  ancestors: P5Element[] = [],
): void {
  for (const c of childrenOf(n)) {
    if (!isElement(c)) continue;
    if (visit(c, ancestors) === false) continue;
    ancestors.push(c);
    walk(c, visit, ancestors);
    ancestors.pop();
  }
}

export function findAll(n: P5Node, pred: (el: P5Element) => boolean): P5Element[] {
  const out: P5Element[] = [];
  walk(n, (el) => {
    if (pred(el)) out.push(el);
  });
  return out;
}

export function findById(n: P5Node, id: string): P5Element | undefined {
  let hit: P5Element | undefined;
  walk(n, (el) => {
    if (hit) return false;
    if (attr(el, 'id') === id) hit = el;
  });
  return hit;
}

/** Concatenated text of an element's descendants. */
export function textOf(n: P5Node): string {
  if (n.nodeName === '#text' && 'value' in n) return n.value;
  return childrenOf(n)
    .map((c) => textOf(c))
    .join('');
}

export interface Span {
  start: number;
  end: number;
}

/** Offsets of the whole element, start tag through end tag. */
export function outerSpan(el: P5Element): Span | undefined {
  const loc = el.sourceCodeLocation;
  if (!loc) return undefined;
  return { start: loc.startOffset, end: loc.endOffset };
}

/** Offsets of the element's content, between its start and end tags. */
export function innerSpan(el: P5Element): Span | undefined {
  const loc = el.sourceCodeLocation;
  if (!loc?.startTag || !loc.endTag) return undefined;
  return { start: loc.startTag.endOffset, end: loc.endTag.startOffset };
}

/** Raw source text of an element's content (exact bytes, no entity decoding). */
export function rawInner(html: string, el: P5Element): string {
  const s = innerSpan(el);
  return s ? html.slice(s.start, s.end) : '';
}
