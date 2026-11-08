/**
 * Sanitized remote views of the library (16 §4.4, §9): the library manifest (`lib-<deviceId>.json`)
 * and one version tree per document (`tree-<docId>.json`), plus the `sync.history` selection of the
 * snapshots whose blobs are uploaded (16 §4.5 step 2).
 *
 * Everything here is pure and works from an allowlist: each remote field is copied from a named
 * local field, so `meta.json` content outside that list (clarifying input, source names and URLs,
 * reader questions, model and cost data, publications) can never reach the store. Labels never carry
 * a reader's question: an "asked about" label names the section heading instead.
 */
import { createHash } from 'node:crypto';
import type { CatalogEntry, DocumentMeta, LibraryOrganization, VersionNodeRecord, VersionTreeFile } from '../library';
import { quoteLabel } from '../library';
import {
  LIMITS,
  LibraryManifestSchema,
  PROTOCOL_VERSION,
  TAB_KEY_RE,
  VERSION_CHANGE_KINDS,
  VersionTreeSchema,
  type LibraryManifest,
  type ManifestDoc,
  type VersionTree,
} from './protocol';

/** `sync.history` (16 §4.5 step 2). */
export type HistoryMode = 'current' | 'recent' | 'all';

/** 'recent': the newest snapshots that still have blobs, the current one always among them. */
export const RECENT_SNAPSHOTS = 10;
/** 'all' stays within the 09 §4.1 caps: snapshots, gzipped bytes and nodes. */
export const ALL_MAX_SNAPSHOTS = 60;
export const ALL_MAX_BYTES = 48 * 1024 * 1024;

const TITLE_MAX = 200;
const SUMMARY_MAX = 300;
const HEADING_MAX = 200;
const HEADINGS_MAX = 200;
const LABEL_MAX = 200;
const FOLDER_NAME_MAX = 60;
const TABS_MAX = 20;

const KINDS: ReadonlySet<string> = new Set(VERSION_CHANGE_KINDS);

/** Cuts to `max` code points (zod counts code points), collapsing whitespace to one line. */
export function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  const cps = [...one];
  return cps.length > max
    ? `${cps
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : one;
}

/** ISO 8601 UTC with milliseconds, as the protocol requires; `fallback` for an unparsable value. */
export function isoUtc(s: string | undefined, fallback: string): string {
  const t = s === undefined ? NaN : Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

/** Snapshots (nodes with a sha) newest first; ties broken by id so the order is stable. */
function snapshotsNewestFirst(tree: VersionTreeFile): VersionNodeRecord[] {
  return tree.nodes
    .filter((n) => n.sha256 !== null)
    .sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : b.createdAt.localeCompare(a.createdAt)));
}

/**
 * The version nodes whose blobs `sync.history` uploads (16 §4.5 step 2), current first. `current`:
 * the live version only. `recent`: the current one plus the newest others, 10 in all. `all`: every
 * snapshot within 60 snapshots and 48 MiB of gzipped blobs (the 09 caps; the tree itself holds at
 * most 300 nodes). A pruned node (no sha) is never selected.
 */
export function selectHistory(tree: VersionTreeFile, mode: HistoryMode): VersionNodeRecord[] {
  const current = tree.nodes.find((n) => n.id === tree.currentId && n.sha256 !== null);
  const out: VersionNodeRecord[] = current ? [current] : [];
  if (mode === 'current') return out;
  const others = snapshotsNewestFirst(tree).filter((n) => n.id !== current?.id);
  if (mode === 'recent') return [...out, ...others.slice(0, Math.max(0, RECENT_SNAPSHOTS - out.length))];
  let bytes = out.reduce((s, n) => s + n.bytes, 0);
  for (const n of others) {
    if (out.length >= ALL_MAX_SNAPSHOTS || bytes + n.bytes > ALL_MAX_BYTES) break;
    out.push(n);
    bytes += n.bytes;
  }
  return out;
}

/**
 * A node's remote label (08 §6.7 label builder output, as stored on the node). An `ask` label never
 * repeats the question or a topic drawn from it: it names the section heading.
 */
export function remoteLabel(node: VersionNodeRecord): string {
  if (node.kind === 'ask') {
    const heading = node.heading?.trim();
    return heading ? `asked about '${quoteLabel(heading)}'` : 'asked a question';
  }
  const label = clip(node.label, LABEL_MAX);
  return label.length > 0 ? label : node.kind;
}

/**
 * `tree-<docId>.json` (16 §4.4). `uploaded` is true only for selected snapshots whose blob is in
 * the store, so a blob that is due for garbage collection is never advertised.
 */
export function buildTree(p: {
  docId: string;
  seq: number;
  tree: VersionTreeFile;
  /** Shas selected by `sync.history` whose blob upload finished. */
  uploaded: ReadonlySet<string>;
  fallbackTime: string;
}): VersionTree {
  const nodes = p.tree.nodes
    .filter((n) => KINDS.has(n.kind))
    .slice(-LIMITS.treeNodes)
    .map((n) => ({
      id: n.id,
      parentId: n.parentId,
      kind: n.kind as VersionTree['nodes'][number]['kind'],
      label: remoteLabel(n),
      createdAt: isoUtc(n.createdAt, p.fallbackTime),
      sha: n.sha256,
      uploaded: n.sha256 !== null && p.uploaded.has(n.sha256),
    }));
  return VersionTreeSchema.parse({
    v: PROTOCOL_VERSION,
    docId: p.docId,
    seq: p.seq,
    currentId: p.tree.currentId,
    nodes,
  });
}

/** Where a document sits in the manifest (16 §4.4), from the organization view (09 §4.2). */
export type Placement = ManifestDoc['placement'];

export function placementOf(org: Pick<LibraryOrganization, 'placement' | 'folders'>, docId: string): Placement {
  const p = org.placement[docId];
  if (p === 'archive') return { kind: 'archive' };
  if (p && org.folders.some((f) => f.id === p)) return { kind: 'folder', folderId: p };
  return { kind: 'unfiled' };
}

/** The live version a manifest entry points at. */
export interface CurrentVersion {
  versionId: string;
  sha: string;
  /** Uncompressed `index.html` bytes. */
  sizeBytes: number;
  /** Section headings of the in-depth tab, from the DocumentModel. */
  headings: readonly string[];
}

/** One manifest entry from the allowlisted catalog and meta fields only (16 §4.4, §9). */
export function buildDocEntry(p: {
  entry: Pick<CatalogEntry, 'id' | 'title' | 'summary' | 'createdAt' | 'updatedAt'>;
  meta: Pick<DocumentMeta, 'tabs'>;
  current: CurrentVersion;
  placement: Placement;
  busy: boolean;
  replaces?: string;
  fallbackTime: string;
}): ManifestDoc {
  // The protocol pattern omits 'ste' (16 §4.4, D21), so 0.3.0 phones never see the ASD-STE100 key.
  const tabs = [...new Set(p.meta.tabs.map((t) => t.key).filter((k) => TAB_KEY_RE.test(k)))].slice(0, TABS_MAX);
  const doc: ManifestDoc = {
    docId: p.entry.id,
    title: clip(p.entry.title, TITLE_MAX) || 'Untitled',
    summary: clip(p.entry.summary, SUMMARY_MAX),
    headings: p.current.headings
      .map((h) => clip(h, HEADING_MAX))
      .filter((h) => h.length > 0)
      .slice(0, HEADINGS_MAX),
    tabs: tabs.length > 0 ? tabs : ['indepth'],
    createdAt: isoUtc(p.entry.createdAt, p.fallbackTime),
    updatedAt: isoUtc(p.entry.updatedAt, p.fallbackTime),
    placement: p.placement,
    currentVersionId: p.current.versionId,
    currentSha: p.current.sha,
    sizeBytes: p.current.sizeBytes,
    busy: p.busy,
  };
  if (p.replaces && p.replaces !== p.entry.id) doc.replaces = p.replaces;
  return doc;
}

/**
 * `lib-<deviceId>.json` (16 §4.4). Folders are the user's folders (names cut to 60); entries keep
 * the given order. A folder placement that names a missing folder becomes unfiled. Validated
 * against the wire schema before it is returned.
 */
export function buildManifest(p: {
  seq: number;
  generatedAt: string;
  folders: ReadonlyArray<{ id: string; name: string }>;
  docs: readonly ManifestDoc[];
}): LibraryManifest {
  const folders = p.folders
    .slice(0, LIMITS.manifestFolders)
    .map((f) => ({ id: f.id, name: clip(f.name, FOLDER_NAME_MAX) || 'Folder' }));
  const ids = new Set(folders.map((f) => f.id));
  const seen = new Set<string>();
  const docs: ManifestDoc[] = [];
  for (const d of p.docs) {
    if (seen.has(d.docId) || docs.length >= LIMITS.manifestDocs) continue;
    seen.add(d.docId);
    docs.push(
      d.placement.kind === 'folder' && !ids.has(d.placement.folderId) ? { ...d, placement: { kind: 'unfiled' } } : d,
    );
  }
  return LibraryManifestSchema.parse({ v: PROTOCOL_VERSION, seq: p.seq, generatedAt: p.generatedAt, folders, docs });
}

/** Content hash of a manifest or tree without its `seq` and `generatedAt`: "did anything change?". */
export function contentHash(value: { seq: number; generatedAt?: string }): string {
  const { seq: _seq, generatedAt: _at, ...rest } = value as Record<string, unknown> & { seq: number };
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

/** Wire bytes of a protocol file. */
export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
