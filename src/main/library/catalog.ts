/** Pure catalog helpers: entries from meta, ordering, comparison, meta privacy (09 §5, §7, §9.1). */
import path from 'node:path';
import { CATALOG_SCHEMA_VERSION } from './schema';
import type { CatalogEntry, CatalogFile, DocumentMeta, LibraryIdSource, SourceRecord } from './types';

/** 09 §7 step 5. Reads meta only, never index.html. */
export function entryFromMeta(m: DocumentMeta): CatalogEntry {
  return {
    id: m.id,
    title: m.title,
    topicSlug: m.topicSlug,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    summary: m.summary,
    summarySource: m.summarySource,
    tabCount: m.tabs.length,
    mergedFromCount: m.merges.length,
  };
}

/** Newest first by createdAt, then by slug for a stable order (09 §9, §9.1). */
export function newestFirst(entries: Iterable<CatalogEntry>): CatalogEntry[] {
  return [...entries].sort((a, b) =>
    a.createdAt === b.createdAt ? a.topicSlug.localeCompare(b.topicSlug) : a.createdAt < b.createdAt ? 1 : -1,
  );
}

export function catalogFile(entries: Iterable<CatalogEntry>, appVersion: string, now: Date): CatalogFile {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    appVersion,
    updatedAt: now.toISOString(),
    entries: newestFirst(entries),
  };
}

const ENTRY_KEYS: readonly (keyof CatalogEntry)[] = [
  'id',
  'title',
  'topicSlug',
  'createdAt',
  'updatedAt',
  'summary',
  'summarySource',
  'tabCount',
  'mergedFromCount',
];

export function sameEntry(a: CatalogEntry, b: CatalogEntry): boolean {
  return ENTRY_KEYS.every((k) => a[k] === b[k]);
}

/** Slugs whose entry was added, dropped or changed between two catalogs (09 §7 step 6). */
export function diffEntries(before: readonly CatalogEntry[], after: readonly CatalogEntry[]): string[] {
  const byId = new Map(before.map((e) => [e.id, e]));
  const changed = new Set<string>();
  for (const e of after) {
    const old = byId.get(e.id);
    if (!old || !sameEntry(old, e)) {
      changed.add(e.topicSlug);
      if (old) changed.add(old.topicSlug);
    }
    byId.delete(e.id);
  }
  for (const e of byId.values()) changed.add(e.topicSlug);
  return [...changed].sort();
}

/** RFC 4122 v4 UUID built from injected hex, so tests get stable IDs (09 §5: IDs are UUIDs). */
export function uuidFrom(ids: LibraryIdSource): string {
  const h = ids.hex(32);
  const variant = '89ab'[parseInt(h.charAt(16), 16) & 3] ?? '8';
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * 09 §5.2 privacy rules: local paths become basenames, URLs lose credentials and their fragment,
 * and with the HOOK-LIB-01 'redacted' policy URLs keep only origin + path.
 */
export function sanitizeSourceRecord(s: SourceRecord, sourceUrls: 'full' | 'redacted'): SourceRecord {
  if (s.kind === 'url') {
    const ref = sanitizeUrl(s.ref, sourceUrls);
    return ref === undefined ? s : { ...s, ref };
  }
  if (s.kind === 'file' && (path.isAbsolute(s.ref) || s.ref.includes('/') || s.ref.includes('\\'))) {
    return { ...s, ref: basename(s.ref) };
  }
  return s;
}

/** Applied to every meta before it is written (09 §5.2). */
export function sanitizeMeta<M extends DocumentMeta>(m: M, sourceUrls: 'full' | 'redacted'): M {
  return {
    ...m,
    sourcesUsed: m.sourcesUsed.map((s) => sanitizeSourceRecord(s, sourceUrls)),
    sourcesSkipped: m.sourcesSkipped.map((s) => ({ ...s, ref: sanitizeRef(s.ref, sourceUrls) })),
  };
}

/** Skipped refs are raw input (03 §7.2): a URL of any scheme or a local path. */
function sanitizeRef(ref: string, sourceUrls: 'full' | 'redacted'): string {
  if (SCHEME_RE.test(ref)) {
    const clean = sanitizeUrl(ref, sourceUrls);
    if (clean !== undefined) return clean;
  }
  if (path.isAbsolute(ref) || ref.startsWith('~/')) return basename(ref);
  return ref;
}

/** A URL scheme of two or more characters (so `C:\x` is not one). */
const SCHEME_RE = /^[a-z][a-z0-9+.-]+:/i;

/**
 * http(s): no userinfo, no fragment, no query when redacted. file: basename only (a local path).
 * Any other scheme may carry credentials or content (mailto:, data:, smb://user@host/...), so only
 * the scheme and the path basename survive. Returns undefined when `ref` is not a URL.
 */
function sanitizeUrl(ref: string, sourceUrls: 'full' | 'redacted'): string | undefined {
  let u: URL;
  try {
    u = new URL(ref);
  } catch {
    return undefined;
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    u.username = '';
    u.password = '';
    u.hash = '';
    if (sourceUrls === 'redacted') u.search = '';
    return u.toString();
  }
  if (u.protocol === 'file:') return basename(safeDecode(u.pathname));
  const tail = u.pathname.includes('/') ? basename(safeDecode(u.pathname)) : '';
  return `${u.protocol}${tail}`;
}

function basename(p: string): string {
  return path.basename(p.replace(/\\/g, '/'));
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
