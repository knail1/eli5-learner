/**
 * Shared XML parsing for OOXML parts (04 §5.1, §10.3). Any part with <!DOCTYPE or <!ENTITY is
 * refused as corrupt before parsing, so processEntities only ever sees the predefined entities and
 * character references. preserveOrder keeps a:r / a:br / a:fld and shape order.
 */
import { XMLParser } from 'fast-xml-parser';
import { ExtractError } from './skip';
import type { SafeZip } from './zip-safety';

/** A preserveOrder node: `{ 'a:p': [...children], ':@': { '@_lvl': '1' } }` or `{ '#text': '...' }`. */
export type XNode = Record<string, unknown>;

/**
 * The five XML entities only. fast-xml-parser v5 decodes numeric character references only when
 * `htmlEntities` is truthy, and an object value replaces its named-entity table, so this keeps
 * 04 §5.1's intent: predefined entities and numeric references, no HTML named entities.
 */
const XML_ENTITIES = { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' };

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: false,
  processEntities: true,
  htmlEntities: XML_ENTITIES as unknown as boolean,
  allowBooleanAttributes: true,
  // Not in the 04 §5.1 listing but required: keep a:t text literally (no trimming of " " runs,
  // no "007" -> 7 number coercion).
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

export function assertNoDtd(xml: string): void {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new ExtractError('corrupt', 'xml: DOCTYPE or ENTITY declaration');
  }
}

/**
 * Checks every .xml/.rels part before a library that parses the package itself (mammoth, SheetJS)
 * sees it (04 §10.3): no part may carry a DTD or entity declaration.
 */
export function assertNoDtdParts(zip: SafeZip): void {
  for (const e of zip.entries) {
    if (/\.(xml|rels)$/i.test(e.name)) assertNoDtd(zip.readText(e.name) ?? '');
  }
}

export function parseXml(xml: string): XNode[] {
  assertNoDtd(xml);
  try {
    return parser.parse(xml) as XNode[];
  } catch {
    throw new ExtractError('corrupt', 'xml: parse error');
  }
}

/** Element name of a node ('#text' for text nodes). */
export function tagOf(n: XNode): string | undefined {
  for (const k of Object.keys(n)) if (k !== ':@') return k;
  return undefined;
}

export function kids(n: XNode | undefined): XNode[] {
  if (!n) return [];
  const t = tagOf(n);
  if (!t || t === '#text') return [];
  const v = n[t];
  return Array.isArray(v) ? (v as XNode[]) : [];
}

export function attr(n: XNode | undefined, name: string): string | undefined {
  const a = n?.[':@'] as Record<string, unknown> | undefined;
  const v = a?.[`@_${name}`];
  if (v === undefined || v === null) return undefined;
  return String(v);
}

export function textValue(n: XNode): string {
  const v = n['#text'];
  return v === undefined || v === null ? '' : String(v);
}

/** First direct child with the tag. */
export function child(n: XNode | undefined, tag: string): XNode | undefined {
  return kids(n).find((c) => tagOf(c) === tag);
}

export function children(n: XNode | undefined, tag: string): XNode[] {
  return kids(n).filter((c) => tagOf(c) === tag);
}

/** Follows a path of direct-child tags. */
export function path(n: XNode | undefined, ...tags: string[]): XNode | undefined {
  let cur = n;
  for (const t of tags) {
    cur = child(cur, t);
    if (!cur) return undefined;
  }
  return cur;
}

/** First top-level element of a parsed document with the tag. */
export function rootEl(doc: XNode[], tag: string): XNode | undefined {
  return doc.find((n) => tagOf(n) === tag);
}

/** All descendants (depth-first, document order) with the tag. */
export function descendants(n: XNode | undefined, tag: string, out: XNode[] = []): XNode[] {
  for (const c of kids(n)) {
    if (tagOf(c) === tag) out.push(c);
    descendants(c, tag, out);
  }
  return out;
}

/** Concatenated text of all descendant elements with the given text tag (e.g. 'a:t'). */
export function allText(n: XNode | undefined, textTag: string): string {
  return descendants(n, textTag)
    .map((t) => kids(t).map(textValue).join(''))
    .join('');
}

/** Text content of a leaf element such as <a:t>. */
export function leafText(n: XNode | undefined): string {
  return kids(n).map(textValue).join('');
}

export interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

/** Parses a .rels part into a map by r:id. */
export function parseRels(xml: string | undefined): Map<string, Relationship> {
  const out = new Map<string, Relationship>();
  if (xml === undefined) return out;
  const root = rootEl(parseXml(xml), 'Relationships');
  for (const r of children(root, 'Relationship')) {
    const id = attr(r, 'Id');
    const target = attr(r, 'Target');
    if (!id || target === undefined) continue;
    out.set(id, {
      id,
      type: attr(r, 'Type') ?? '',
      target,
      external: attr(r, 'TargetMode') === 'External',
    });
  }
  return out;
}

/** dc:title from docProps/core.xml, if any. */
export function coreTitle(xml: string | undefined): string | undefined {
  if (xml === undefined) return undefined;
  const root = rootEl(parseXml(xml), 'cp:coreProperties');
  const t = leafText(child(root, 'dc:title')).trim();
  return t || undefined;
}
