/**
 * The version tree of a document (09 §4.1). Every html change is a node; nodes branch, and Undo,
 * Redo and the Versions panel move between them by checking one out as the live files.
 *
 * On disk, under `<slug>/.versions/`:
 * - `blobs/<sha256>.html.gz`: gzip of an exact index.html, named by the sha256 of the plain bytes,
 *   so identical content is stored once.
 * - `nodes/<id>.json`: one node record with its meta snapshot; the source of truth, written
 *   before the live commit so a crash after the commit can be adopted with its real label.
 * - `tree.json`: the index of all nodes plus the current one; rebuildable from the node files.
 *
 * The live files say which node they are: meta.json `versionId` plus the sha of index.html. Any
 * mismatch is a *detached* document (an outside edit), snapshotted as an `outside` node before
 * the next write. Reads resolve all of this in memory and never write (`planVersions`); the write
 * paths persist the same plan (`FsLibrary.materialize`).
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DocVersionPending, DocVersionTree } from '../../preload/contract';
import { DIR_MODE, writeFileAtomic, writeJsonAtomic } from './fs-atomic';
import { readVersioned, treeMigrations, type ReadVersionedResult } from './migrations';
import { PREV_DIR, quoteLabel, readPriorState } from './prior';
import {
  DocumentMetaSchema,
  TREE_SCHEMA_VERSION,
  VERSION_ID_RE,
  VersionNodeFileSchema,
  VersionTreeFileSchema,
} from './schema';
import {
  LibraryError,
  type DocHistoryState,
  type DocumentMeta,
  type VersionNodeFile,
  type VersionNodeRecord,
  type VersionTarget,
  type VersionTreeFile,
  type VersionTreeView,
} from './types';

export { TREE_SCHEMA_VERSION, VERSION_ID_RE };
export const VERSIONS_DIR = '.versions';
export const TREE_FILE = 'tree.json';
export const NODES_DIR = 'nodes';
export const BLOBS_DIR = 'blobs';
/** Retention per document (09 §4.1, HOOK-LIB-01 public text). */
export const MAX_SNAPSHOTS = 60;
export const MAX_STORE_BYTES = 48 * 1024 * 1024;
export const MAX_NODES = 300;
export const OUTSIDE_LABEL = 'changed outside the app';
export const OUTSIDE_TOPIC = 'Changed outside the app';
const MAX_TOPIC_CHARS = 48;
const BLOB_SUFFIX = '.html.gz';
const SHA_RE = /^[0-9a-f]{64}$/;
/** At most this many missed node files are adopted in one chain. */
const MAX_ADOPT_CHAIN = 32;

// ---- pure functions over a tree ----

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Deterministic id from parts, so a view synthesized in memory matches the one written later. */
export function derivedVersionId(...parts: string[]): string {
  return `v-${sha256Hex(parts.join('\0')).slice(0, 12)}`;
}

/** The root of a tree started from `html` (09 §1). */
export function rootIdFor(htmlSha: string): string {
  return `v-${htmlSha.slice(0, 12)}`;
}

/** One line, at most 48 characters, never empty. */
export function cleanTopic(topic: string | undefined, fallback = OUTSIDE_TOPIC): string {
  const t = quoteLabel(topic ?? '', MAX_TOPIC_CHARS);
  return t === '' ? fallback : t;
}

export const isAvailable = (n: VersionNodeRecord): boolean => n.sha256 !== null;

export function nodeOf(tree: VersionTreeFile, id: string | null | undefined): VersionNodeRecord | undefined {
  return id == null ? undefined : tree.nodes.find((n) => n.id === id);
}

/** Children of `id`, oldest first (ties keep file order). */
export function childrenOf(tree: VersionTreeFile, id: string): VersionNodeRecord[] {
  return tree.nodes
    .map((n, i) => ({ n, i }))
    .filter((x) => x.n.parentId === id)
    .sort((a, b) => (a.n.createdAt === b.n.createdAt ? a.i - b.i : a.n.createdAt < b.n.createdAt ? -1 : 1))
    .map((x) => x.n);
}

/** `id`, its parent, ... up to the root. Stops at a missing parent or a cycle. */
export function pathToRoot(tree: VersionTreeFile, id: string): VersionNodeRecord[] {
  const out: VersionNodeRecord[] = [];
  const seen = new Set<string>();
  for (let n = nodeOf(tree, id); n && !seen.has(n.id); n = nodeOf(tree, n.parentId)) {
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

/** What Redo opens from `id`: its forward child when available, else the newest available child. */
export function redoChild(tree: VersionTreeFile, id: string): VersionNodeRecord | undefined {
  const fwd = nodeOf(tree, nodeOf(tree, id)?.forwardId);
  if (fwd && fwd.parentId === id && isAvailable(fwd)) return fwd;
  return childrenOf(tree, id).filter(isAvailable).at(-1);
}

/** The live node: `versionId` when it names a node with the live sha, else detached. */
export function resolveCurrent(
  tree: VersionTreeFile,
  liveVersionId: string | undefined,
  liveSha: string,
): { currentId: string; detached: boolean } {
  const n = nodeOf(tree, liveVersionId);
  if (n && n.sha256 === liveSha) return { currentId: n.id, detached: false };
  return { currentId: tree.currentId, detached: true };
}

/** The one-level history API over the tree (08 §6.7): Undo opens the parent, Redo `redoChild`. */
export function historyFromTree(tree: VersionTreeFile): DocHistoryState {
  const cur = nodeOf(tree, tree.currentId);
  if (!cur) return { canUndo: false, canRedo: false };
  const parent = nodeOf(tree, cur.parentId);
  const redo = redoChild(tree, cur.id);
  const canUndo = parent !== undefined && isAvailable(parent);
  return {
    canUndo,
    canRedo: redo !== undefined,
    ...(canUndo ? { undoLabel: cur.label } : {}),
    ...(redo ? { redoLabel: redo.label } : {}),
  };
}

/**
 * Where the viewer lands after moving from `fromId` to `toId`. Back to an ancestor: the place the
 * first undone change came from (its `undoTarget`). Anywhere else: the target's own change. The
 * root has no change, so `{}`.
 */
export function scrollTargetFor(tree: VersionTreeFile, fromId: string, toId: string): VersionTarget {
  const to = nodeOf(tree, toId);
  if (!to) return {};
  if (fromId !== toId) {
    const up = pathToRoot(tree, fromId);
    const at = up.findIndex((n) => n.id === toId);
    if (at > 0) return { ...(up[at - 1]?.undoTarget ?? {}) };
  }
  return { ...(to.target ?? {}) };
}

export interface PruneLimits {
  maxSnapshots?: number;
  maxBytes?: number;
  maxNodes?: number;
  /** Extra ids never stubbed or removed. */
  protect?: Iterable<string>;
}

export interface PrunePlan {
  tree: VersionTreeFile;
  /** Nodes whose snapshot was dropped (they stay as stubs). */
  stubbed: string[];
  /** Stub leaves removed from the tree. */
  removed: string[];
  /** Blobs no remaining node refers to. */
  unreferencedBlobs: string[];
}

/**
 * Retention (09 §4.1): the root, the current node, its ancestors and its redo child are kept.
 * Other snapshots are stubbed oldest first until both caps hold, then stub leaves are removed
 * oldest first while there are too many nodes. Pure; returns a new tree.
 */
export function planPrune(input: VersionTreeFile, limits: PruneLimits = {}): PrunePlan {
  const maxSnapshots = limits.maxSnapshots ?? MAX_SNAPSHOTS;
  const maxBytes = limits.maxBytes ?? MAX_STORE_BYTES;
  const maxNodes = limits.maxNodes ?? MAX_NODES;
  const tree: VersionTreeFile = { ...input, nodes: input.nodes.map((n) => ({ ...n })) };
  const keep = new Set<string>([tree.rootId, ...pathToRoot(tree, tree.currentId).map((n) => n.id)]);
  const redo = redoChild(tree, tree.currentId);
  if (redo) keep.add(redo.id);
  for (const id of limits.protect ?? []) keep.add(id);

  const before = new Set(tree.nodes.flatMap((n) => (n.sha256 ? [n.sha256] : [])));
  const count = () => tree.nodes.filter(isAvailable).length;
  const bytes = () => {
    const by = new Map<string, number>();
    for (const n of tree.nodes) if (n.sha256) by.set(n.sha256, Math.max(by.get(n.sha256) ?? 0, n.bytes));
    let sum = 0;
    for (const b of by.values()) sum += b;
    return sum;
  };
  const oldestFirst = (ns: VersionNodeRecord[]) =>
    ns
      .map((n, i) => ({ n, i }))
      .sort((a, b) => (a.n.createdAt === b.n.createdAt ? a.i - b.i : a.n.createdAt < b.n.createdAt ? -1 : 1))
      .map((x) => x.n);

  const stubbed: string[] = [];
  for (const n of oldestFirst(tree.nodes.filter((x) => isAvailable(x) && !keep.has(x.id)))) {
    if (count() <= maxSnapshots && bytes() <= maxBytes) break;
    n.sha256 = null;
    n.bytes = 0;
    stubbed.push(n.id);
  }

  const removed: string[] = [];
  while (tree.nodes.length > maxNodes) {
    const parents = new Set(tree.nodes.map((n) => n.parentId));
    const leaf = oldestFirst(tree.nodes.filter((n) => !isAvailable(n) && !keep.has(n.id) && !parents.has(n.id)))[0];
    if (!leaf) break;
    tree.nodes = tree.nodes.filter((n) => n !== leaf);
    removed.push(leaf.id);
  }
  if (removed.length > 0) {
    const gone = new Set(removed);
    for (const n of tree.nodes) if (n.forwardId && gone.has(n.forwardId)) delete n.forwardId;
  }

  const after = new Set(tree.nodes.flatMap((n) => (n.sha256 ? [n.sha256] : [])));
  return { tree, stubbed, removed, unreferencedBlobs: [...before].filter((s) => !after.has(s)) };
}

/** The wire shape for the renderer (`eli5:doc:versions`). */
export function toWire(view: VersionTreeView, extras: { busy: boolean; pending: DocVersionPending[] }): DocVersionTree {
  const { tree } = view;
  const redo = redoChild(tree, tree.currentId);
  return {
    slug: view.slug,
    nodes: tree.nodes.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      createdAt: n.createdAt,
      kind: n.kind,
      label: n.label,
      topic: n.topic,
      ...(n.heading !== undefined ? { heading: n.heading } : {}),
      ...(n.question !== undefined ? { question: n.question } : {}),
      ...(n.target !== undefined ? { target: { ...n.target } } : {}),
      available: isAvailable(n),
      published: n.sha256 !== null && n.sha256 === view.publishedSha,
    })),
    currentId: tree.currentId,
    ...(redo ? { redoId: redo.id } : {}),
    detached: view.detached,
    busy: extras.busy,
    pending: extras.pending.map((p) => ({ ...p })),
    readOnly: view.readOnly,
    ...(view.degraded ? { degraded: true } : {}),
  };
}

// ---- files ----

export interface VersionPaths {
  dir: string;
  tree: string;
  nodes: string;
  blobs: string;
}

export function versionPaths(docDir: string): VersionPaths {
  const dir = path.join(docDir, VERSIONS_DIR);
  return { dir, tree: path.join(dir, TREE_FILE), nodes: path.join(dir, NODES_DIR), blobs: path.join(dir, BLOBS_DIR) };
}

const blobPath = (p: VersionPaths, sha: string) => path.join(p.blobs, `${sha}${BLOB_SUFFIX}`);
const isBlobFile = async (p: VersionPaths, sha: string) =>
  (await fsp.lstat(blobPath(p, sha)).catch(() => undefined))?.isFile() === true;
const nodePath = (p: VersionPaths, id: string) => {
  if (!VERSION_ID_RE.test(id)) throw new LibraryError('VERSION_NOT_FOUND');
  return path.join(p.nodes, `${id}.json`);
};

async function ensureDirs(p: VersionPaths): Promise<void> {
  for (const d of [p.dir, p.nodes, p.blobs]) await fsp.mkdir(d, { recursive: true, mode: DIR_MODE });
}

/** Stores an index.html once by content (gzip level 6, header mtime 0). */
export async function writeBlob(
  p: VersionPaths,
  html: string | Uint8Array,
): Promise<{ sha256: string; bytes: number }> {
  const sha256 = sha256Hex(html);
  const file = blobPath(p, sha256);
  const st = await fsp.lstat(file).catch(() => undefined);
  if (st?.isFile()) return { sha256, bytes: st.size };
  await ensureDirs(p);
  const gz = gzipSync(html, { level: 6 });
  await writeFileAtomic(file, gz);
  return { sha256, bytes: gz.length };
}

/** The exact bytes of a snapshot; VERSION_CORRUPT when missing, unreadable or not matching its sha. */
export async function readBlob(p: VersionPaths, sha256: string): Promise<Buffer> {
  if (!SHA_RE.test(sha256)) throw new LibraryError('VERSION_CORRUPT');
  let html: Buffer;
  try {
    html = gunzipSync(await fsp.readFile(blobPath(p, sha256)));
  } catch {
    throw new LibraryError('VERSION_CORRUPT');
  }
  if (sha256Hex(html) !== sha256) throw new LibraryError('VERSION_CORRUPT');
  return html;
}

export async function writeNodeFile(p: VersionPaths, node: VersionNodeRecord, meta: DocumentMeta): Promise<void> {
  await ensureDirs(p);
  const file: VersionNodeFile = { schemaVersion: TREE_SCHEMA_VERSION, node, meta };
  await writeJsonAtomic(nodePath(p, node.id), file);
}

/** A node file, or undefined when missing or invalid. */
export async function readNodeFile(p: VersionPaths, id: string): Promise<VersionNodeFile | undefined> {
  if (!VERSION_ID_RE.test(id)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(nodePath(p, id), 'utf8'));
  } catch {
    return undefined;
  }
  const r = VersionNodeFileSchema.safeParse(raw);
  return r.success && r.data.node.id === id ? r.data : undefined;
}

export async function removeNodeFile(p: VersionPaths, id: string): Promise<void> {
  if (VERSION_ID_RE.test(id)) await fsp.unlink(nodePath(p, id)).catch(() => {});
}

export async function removeBlob(p: VersionPaths, sha256: string): Promise<void> {
  if (SHA_RE.test(sha256)) await fsp.unlink(blobPath(p, sha256)).catch(() => {});
}

/** tree.json through the versioned read (09 §5.3); its own (empty) migration chain. */
export function readTree(p: VersionPaths, now: () => Date): Promise<ReadVersionedResult<VersionTreeFile>> {
  return readVersioned<VersionTreeFile>(p.tree, {
    schema: VersionTreeFileSchema,
    lenient: VersionTreeFileSchema.loose(),
    chain: treeMigrations,
    current: TREE_SCHEMA_VERSION,
    allowWrite: false,
    renameCorrupt: false,
    now,
  });
}

export async function writeTree(p: VersionPaths, tree: VersionTreeFile): Promise<void> {
  await ensureDirs(p);
  await writeJsonAtomic(p.tree, { ...tree, schemaVersion: TREE_SCHEMA_VERSION });
}

/**
 * Rebuilds the index from `nodes/*.json` (a missing or corrupt tree.json). The oldest parentless
 * node is the root; nodes not reachable from it are dropped; a node whose blob is gone is a stub.
 * Undefined when there are no usable node files. Reads only.
 */
export async function rebuildTree(p: VersionPaths, liveVersionId?: string): Promise<VersionTreeFile | undefined> {
  const names = await fsp.readdir(p.nodes).catch(() => [] as string[]);
  const records: VersionNodeRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const f = await readNodeFile(p, name.slice(0, -'.json'.length));
    if (f) records.push({ ...f.node });
  }
  const byAge = records.sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? -1 : 1));
  const root = byAge.find((n) => n.parentId === null);
  if (!root) return undefined;
  // Parents before children (breadth first from the root), siblings oldest first.
  const kept = new Map<string, VersionNodeRecord>([[root.id, root]]);
  const nodes: VersionNodeRecord[] = [root];
  for (let i = 0; i < nodes.length; i++) {
    const id = nodes[i]?.id;
    for (const n of byAge) {
      if (n.parentId === id && !kept.has(n.id)) {
        kept.set(n.id, n);
        nodes.push(n);
      }
    }
  }
  for (const n of nodes) {
    if (n.forwardId && !(kept.get(n.forwardId)?.parentId === n.id)) delete n.forwardId;
    if (n.sha256) {
      const st = await fsp.lstat(blobPath(p, n.sha256)).catch(() => undefined);
      if (!st?.isFile()) {
        n.sha256 = null;
        n.bytes = 0;
      }
    }
  }
  const currentId =
    liveVersionId && kept.has(liveVersionId)
      ? liveVersionId
      : (byAge.filter((n) => kept.has(n.id)).at(-1)?.id ?? root.id);
  return { schemaVersion: TREE_SCHEMA_VERSION, rootId: root.id, currentId, nodes };
}

// ---- resolving a document's tree in memory ----

export interface LiveFiles {
  html: Buffer;
  meta: DocumentMeta;
}

/** A node the plan synthesized: its blob and node file are written by `materialize`. */
export interface PlannedNode {
  node: VersionNodeRecord;
  meta: DocumentMeta;
  html: Buffer;
}

export interface VersionPlan {
  /** Resolved: `currentId` is the live version (synthesized when detached). */
  tree: VersionTreeFile;
  detached: boolean;
  /** tree.json is from a newer app: shown, never written. */
  readOnly: boolean;
  /** tree.json must be (re)written. */
  dirty: boolean;
  /** tree.json exists but could not be read; it is set aside before the rewrite. */
  corruptTree: boolean;
  newNodes: PlannedNode[];
  /** A legacy `.prev/` folder exists; removed once tree.json is durable. */
  removePrev: boolean;
}

/** Legacy `.prev/`, when it holds a valid slot paired with the live meta (09 §4.1.1). */
async function readLegacyPrior(docDir: string, live: DocumentMeta) {
  const dir = path.join(docDir, PREV_DIR);
  const exists = (await fsp.lstat(dir).catch(() => undefined)) !== undefined;
  const state = exists ? await readPriorState(docDir) : undefined;
  if (!state || state.pairedUpdatedAt !== live.updatedAt) return { exists };
  try {
    const html = await fsp.readFile(path.join(dir, 'index.html'));
    const meta = DocumentMetaSchema.safeParse(JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')));
    if (!meta.success) return { exists };
    return { exists, prior: { state, html, meta: meta.data } };
  } catch {
    return { exists };
  }
}

function seedNode(
  id: string,
  parentId: string | null,
  createdAt: string,
  kind: 'initial' | 'outside',
  label: string,
  html: Buffer,
): VersionNodeRecord {
  return { id, parentId, createdAt, kind, label, topic: cleanTopic(label), sha256: sha256Hex(html), bytes: 0 };
}

/**
 * Resolves the tree for the live files without writing anything (09 §4.1, D5): reads tree.json
 * (rebuilding from node files when missing or corrupt), adopts a committed node the index missed,
 * synthesizes an `outside` node for detached content, or seeds a first tree from the live files
 * and a legacy `.prev/` slot.
 */
export async function planVersions(docDir: string, live: LiveFiles, now: () => Date): Promise<VersionPlan> {
  const p = versionPaths(docDir);
  const liveSha = sha256Hex(live.html);
  const vid = live.meta.versionId;
  const r = await readTree(p, now);
  let tree: VersionTreeFile | undefined;
  let dirty = false;
  const corruptTree = r.status === 'corrupt';
  if (r.status === 'ok' || r.status === 'newer') {
    tree = structuredClone(r.data);
  } else {
    tree = await rebuildTree(p, vid);
    dirty = tree !== undefined;
  }
  const legacy = tree ? undefined : await readLegacyPrior(docDir, live.meta);
  const removePrev = tree ? (await fsp.lstat(path.join(docDir, PREV_DIR)).catch(() => undefined)) !== undefined : false;

  if (r.status === 'newer' && tree) {
    const { currentId, detached } = resolveCurrent(tree, vid, liveSha);
    return {
      tree: { ...tree, currentId },
      detached,
      readOnly: true,
      dirty: false,
      corruptTree,
      newNodes: [],
      removePrev: false,
    };
  }

  const newNodes: PlannedNode[] = [];
  if (!tree) {
    // Seed: the live files are the root, or the child of a legacy `.prev/` slot.
    const created = live.meta.createdAt;
    const prior = legacy?.prior;
    if (prior?.state.slot === 'undo') {
      const root = seedNode(rootIdFor(sha256Hex(prior.html)), null, created, 'initial', 'Earlier version', prior.html);
      root.topic = 'Earlier version';
      const child = seedNode(
        derivedVersionId('legacy', root.id, liveSha),
        root.id,
        live.meta.updatedAt,
        'outside',
        prior.state.label,
        live.html,
      );
      root.forwardId = child.id;
      newNodes.push({ node: root, meta: { ...prior.meta, versionId: root.id }, html: prior.html });
      newNodes.push({ node: child, meta: { ...live.meta, versionId: child.id }, html: live.html });
      tree = { schemaVersion: TREE_SCHEMA_VERSION, rootId: root.id, currentId: child.id, nodes: [root, child] };
    } else {
      const root = seedNode(rootIdFor(liveSha), null, created, 'initial', 'Original', live.html);
      newNodes.push({ node: root, meta: { ...live.meta, versionId: root.id }, html: live.html });
      tree = { schemaVersion: TREE_SCHEMA_VERSION, rootId: root.id, currentId: root.id, nodes: [root] };
      if (prior?.state.slot === 'redo') {
        const child = seedNode(
          derivedVersionId('legacy', root.id, sha256Hex(prior.html)),
          root.id,
          prior.meta.updatedAt,
          'outside',
          prior.state.label,
          prior.html,
        );
        root.forwardId = child.id;
        newNodes.push({ node: child, meta: { ...prior.meta, versionId: child.id }, html: prior.html });
        tree.nodes.push(child);
      }
    }
    return {
      tree,
      detached: false,
      readOnly: false,
      dirty: true,
      corruptTree,
      newNodes,
      removePrev: legacy?.exists ?? false,
    };
  }

  const { currentId, detached } = resolveCurrent(tree, vid, liveSha);
  if (!detached) {
    if (tree.currentId !== currentId) {
      tree.currentId = currentId;
      dirty = true;
    }
    return { tree, detached: false, readOnly: false, dirty, corruptTree, newNodes, removePrev };
  }

  // (b) Committed, but the index missed it (a crash before tree.json): adopt the node file, and
  // any ancestors the index also missed (two failed index writes in a row), with their real labels.
  if (vid && !nodeOf(tree, vid)) {
    const chain: VersionNodeRecord[] = [];
    let f = await readNodeFile(p, vid);
    if (f?.node.sha256 === liveSha) {
      while (f && chain.length < MAX_ADOPT_CHAIN && !chain.some((n) => n.id === f?.node.id)) {
        const { forwardId: _fwd, ...n } = f.node;
        chain.unshift(n);
        if (n.parentId === null || nodeOf(tree, n.parentId)) break;
        f = await readNodeFile(p, n.parentId);
      }
    }
    const top = chain[0];
    if (top && nodeOf(tree, top.parentId)) {
      for (const n of chain) {
        if (n.id !== vid && n.sha256 && !(await isBlobFile(p, n.sha256))) {
          n.sha256 = null;
          n.bytes = 0;
        }
        const parent = nodeOf(tree, n.parentId);
        tree.nodes.push(n);
        if (parent) parent.forwardId = n.id;
      }
      tree.currentId = vid;
      return { tree, detached: false, readOnly: false, dirty: true, corruptTree, newNodes, removePrev };
    }
  }

  // (b2) The current node took a new snapshot (a runtime refresh) but the index missed it: the node
  // file, written before the commit, already names the live sha.
  const known = nodeOf(tree, vid);
  if (known && vid) {
    const f = await readNodeFile(p, vid);
    if (f && f.node.sha256 === liveSha && (await isBlobFile(p, liveSha))) {
      known.sha256 = liveSha;
      known.bytes = f.node.bytes;
      tree.currentId = vid;
      return { tree, detached: false, readOnly: false, dirty: true, corruptTree, newNodes, removePrev };
    }
  }

  // (c) Detached: the live files become an `outside` child of the last known current node.
  const parent = nodeOf(tree, tree.currentId) ?? nodeOf(tree, tree.rootId);
  const parentId = parent?.id ?? tree.rootId;
  let id = derivedVersionId('outside', parentId, liveSha);
  for (let n = 1; nodeOf(tree, id); n++) id = derivedVersionId('outside', parentId, liveSha, String(n));
  const node: VersionNodeRecord = {
    id,
    parentId,
    createdAt: live.meta.updatedAt,
    kind: 'outside',
    label: OUTSIDE_LABEL,
    topic: OUTSIDE_TOPIC,
    sha256: liveSha,
    bytes: 0,
  };
  tree.nodes.push(node);
  if (parent) parent.forwardId = id;
  tree.currentId = id;
  newNodes.push({ node, meta: { ...live.meta, versionId: id }, html: live.html });
  return { tree, detached: true, readOnly: false, dirty: true, corruptTree, newNodes, removePrev };
}

/**
 * Deletes what the tree no longer refers to: node files outside it (except `keepId`, the live
 * version), unreferenced blobs and any `*.tmp-*` under `.versions/`. Caller holds the doc lock.
 */
export async function sweepOrphans(p: VersionPaths, tree: VersionTreeFile, keepId?: string): Promise<number> {
  const ids = new Set(tree.nodes.map((n) => n.id));
  if (keepId) ids.add(keepId);
  const shas = new Set(tree.nodes.flatMap((n) => (n.sha256 ? [n.sha256] : [])));
  let removed = 0;
  const rm = async (file: string) => {
    await fsp.unlink(file).catch(() => {});
    removed++;
  };
  for (const name of await fsp.readdir(p.dir).catch(() => [] as string[])) {
    if (name.includes('.tmp-')) await rm(path.join(p.dir, name));
  }
  for (const name of await fsp.readdir(p.nodes).catch(() => [] as string[])) {
    const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';
    if (name.includes('.tmp-') || (VERSION_ID_RE.test(id) && !ids.has(id))) await rm(path.join(p.nodes, name));
  }
  for (const name of await fsp.readdir(p.blobs).catch(() => [] as string[])) {
    const sha = name.endsWith(BLOB_SUFFIX) ? name.slice(0, -BLOB_SUFFIX.length) : '';
    if (name.includes('.tmp-') || (SHA_RE.test(sha) && !shas.has(sha))) await rm(path.join(p.blobs, name));
  }
  return removed;
}
