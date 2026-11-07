/** The Library facade (09 §9): root, catalog, meta, slugs, commit, update, reconcile, trash. */
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { log as defaultLog, type Logger } from '../security';
import { catalogFile, diffEntries, entryFromMeta, newestFirst, sanitizeMeta, uuidFrom } from './catalog';
import { DIR_MODE, errnoOf, fsyncDir, isErrno, renameDirAtomic, writeFileAtomic, writeJsonAtomic } from './fs-atomic';
import { LockSet, acquireProcessLock, releaseProcessLock } from './locks';
import {
  catalogMigrations,
  compactTimestamp,
  metaMigrations,
  organizationMigrations,
  readVersioned,
} from './migrations';
import {
  ORGANIZATION_FILE,
  ORGANIZATION_SCHEMA_VERSION,
  OrganizationFileSchema,
  TRASH_ID_RE,
  cleanFolderName,
  emptyOrganization,
  folderNameTaken,
  isFolderId,
  locationIn,
  organizationView,
  slugOfTrashId,
  sortedFolders,
  withPlacement,
} from './organization';
import { defaultLibraryPolicy } from './policy';
import { PREV_DIR, PREV_TMP_RE, cleanChangeLabel, quoteLabel } from './prior';
import {
  CATALOG_SCHEMA_VERSION,
  CatalogFileSchema,
  DocumentMetaSchema,
  META_SCHEMA_VERSION,
  VersionNodeRecordSchema,
} from './schema';
import { chooseSlug, isValidSlug } from './slug';
import {
  cleanTopic,
  historyFromTree,
  isAvailable,
  nodeOf,
  pathToRoot,
  planPrune,
  planVersions,
  readBlob,
  readNodeFile,
  redoChild,
  removeBlob,
  removeNodeFile,
  sweepOrphans,
  versionPaths,
  writeBlob,
  writeNodeFile,
  writeTree,
  type VersionPaths,
  type VersionPlan,
} from './versions';
import {
  LibraryError,
  type CatalogEntry,
  type CatalogFile,
  type DocHistoryState,
  type DocumentMeta,
  type DocumentPatch,
  type FolderId,
  type Library,
  type LibraryChangeReason,
  type LibraryClock,
  type LibraryFolder,
  type LibraryIdSource,
  type LibraryInfo,
  type LibraryLocation,
  type LibraryMoveReceipt,
  type LibraryOrganization,
  type LibraryPolicy,
  type LibraryRootInput,
  type MergeSuggestion,
  type OrganizationFile,
  type ProcessProbe,
  type PublicationRecord,
  type ReadOnlyReason,
  type SectionId,
  type SlugReservation,
  type TrashItem,
  type TrashRecord,
  type VersionNodeFile,
  type VersionNodeRecord,
  type VersionTreeFile,
  type VersionTreeView,
} from './types';

/** Hidden housekeeping folders and files (09 §4). */
export const STAGING_DIR = '.staging';
export const TRASH_DIR = '.trash';
export const ELI5_DIR = '.eli5';
export const CATALOG_FILE = 'catalog.json';
export const META_FILE = 'meta.json';
export const INDEX_FILE = 'index.html';
export const LOCK_FILE = 'library.lock';
/** Leftover temp files older than this are deleted by reconcile (09 §4, §7 step 8). */
export const TMP_MAX_AGE_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Only the library's own temp files, `<target>.tmp-<pid>-<8 hex>` (09 §4, §3.2). */
const TMP_FILE_RE = /\.tmp-\d+-[0-9a-f]{8}$/;

/** 09 §7 steps 3-4 and pending migrations, applied in reconcile's phase 2. */
interface ReconcilePatch {
  migrate?: true;
  topicSlug?: true;
  id?: { from: string; to: string };
}

interface ScannedFolder {
  meta: DocumentMeta;
  patch: ReconcilePatch | undefined;
}
const CATALOG_KEY = '\0catalog';

/** Status text for read-only mode (09 §8.5). */
export const READ_ONLY_MESSAGES: Record<ReadOnlyReason, string> = {
  locked: 'Library is in use by another copy of ELI5 Learner',
  'newer-schema': 'Library was written by a newer version of ELI5 Learner',
};

const cryptoIds: LibraryIdSource = {
  hex: (chars) =>
    randomBytes(Math.ceil(chars / 2))
      .toString('hex')
      .slice(0, chars),
};
const systemClock: LibraryClock = { now: () => new Date() };

export interface OpenLibraryOptions {
  /** Inputs to `policy.resolveRoot` (09 §3.1). */
  rootInput: LibraryRootInput;
  /** HOOK-LIB-01; the registry's `libraryPolicy()` in the app. */
  policy?: LibraryPolicy;
  appVersion: string;
  clock?: LibraryClock;
  ids?: LibraryIdSource;
  logger?: Logger;
  /** Dev builds assert lock discipline (LOCK_NOT_HELD). Pass `!app.isPackaged`. */
  devChecks?: boolean;
  /**
   * Process lock (09 §8.4). On by default with this process's start time
   * (`Date.now() - process.uptime() * 1000`) and executable name; `false` turns it off (tests only).
   */
  processLock?:
    | {
        startedAt?: Date;
        probe?: ProcessProbe;
        executableName?: string;
        pid?: number;
      }
    | false;
  /**
   * Dev-only `.gitignore` check (09 §3.1 step 2, §3.2). Returns false when the root is inside a
   * git work tree and not ignored. Default: none. Use `gitCheckIgnored` in the app.
   */
  checkIgnored?: (root: string) => Promise<boolean | undefined>;
  /** Run reconcile after opening (default true; 09 §7). */
  reconcile?: boolean;
}

/**
 * `git check-ignore -q <root>`: true when ignored, false when tracked-able inside a work tree,
 * undefined when not in a work tree or git is unavailable.
 */
export async function gitCheckIgnored(root: string): Promise<boolean | undefined> {
  const run = promisify(execFile);
  try {
    await run('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { timeout: 3000 });
  } catch {
    return undefined;
  }
  try {
    await run('git', ['-C', root, 'check-ignore', '-q', root], { timeout: 3000 });
    return true;
  } catch (err) {
    return (err as { code?: unknown }).code === 1 ? false : undefined;
  }
}

/**
 * Startup (09 §3.1 steps 1-5, §8.4, §7): resolve the root, mkdir it and the hidden folders, create
 * an empty catalog if missing, realpath and cache it, take the process lock, load the catalog and
 * reconcile.
 */
export async function openLibrary(opts: OpenLibraryOptions): Promise<FsLibrary> {
  const policy = opts.policy ?? defaultLibraryPolicy;
  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? defaultLog;
  const resolved = policy.resolveRoot(opts.rootInput);
  if (!path.isAbsolute(resolved)) throw new Error('Library root must be an absolute path');

  await fsp.mkdir(resolved, { recursive: true, mode: DIR_MODE });
  for (const d of [STAGING_DIR, TRASH_DIR, ELI5_DIR]) {
    await fsp.mkdir(path.join(resolved, d), { recursive: true, mode: DIR_MODE });
  }
  const root = await fsp.realpath(resolved);

  if (opts.checkIgnored && !opts.rootInput.isPackaged) {
    const ignored = await opts.checkIgnored(root).catch(() => undefined);
    if (ignored === false) logger.warn('library.root-not-ignored', { kind: 'git' });
  }

  let readOnly: ReadOnlyReason | undefined;
  const pl = opts.processLock === false ? undefined : (opts.processLock ?? {});
  const lockFile = path.join(root, ELI5_DIR, LOCK_FILE);
  const pid = pl?.pid ?? process.pid;
  if (pl) {
    const res = await acquireProcessLock({
      file: lockFile,
      appVersion: opts.appVersion,
      startedAt: pl.startedAt ?? new Date(Date.now() - process.uptime() * 1000),
      pid,
      probe: pl.probe,
      executableName: pl.executableName ?? path.basename(process.execPath),
    });
    if (!res.acquired) {
      readOnly = 'locked';
      logger.warn('library.read-only', { kind: 'locked' });
    }
  }
  const ownsProcessLock = pl !== undefined && readOnly === undefined;

  const lib = new FsLibrary({
    root,
    policy,
    appVersion: opts.appVersion,
    clock,
    ids: opts.ids ?? cryptoIds,
    logger,
    devChecks: opts.devChecks ?? true,
    ownsProcessLock,
    pid,
  });
  if (readOnly) lib.enterReadOnly(readOnly);
  try {
    await lib.loadCatalog();
    await lib.loadOrganization();
    if (opts.reconcile ?? true) await lib.reconcile();
  } catch (err) {
    // Do not leave our lock behind when startup fails (close() is unreachable for the caller).
    await lib.close().catch(() => {});
    throw err;
  }
  return lib;
}

interface FsLibraryDeps {
  root: string;
  policy: LibraryPolicy;
  appVersion: string;
  clock: LibraryClock;
  ids: LibraryIdSource;
  logger: Logger;
  devChecks: boolean;
  ownsProcessLock: boolean;
  pid: number;
}

/** What FsLibrary delegates its merge methods to (09 §9, §10); implemented by ./merge. */
export interface MergeDelegate {
  runMergeCheck(docId: string): Promise<MergeSuggestion | null>;
  /** Pending only, newest first. */
  pending(): MergeSuggestion[];
  accept(id: string): Promise<{ targetSlug: string }>;
  dismiss(id: string): Promise<void>;
}

type ChangedListener = (e: { reason: LibraryChangeReason; slugs: string[] }) => void;
type SuggestionsListener = (s: MergeSuggestion[]) => void;
type OrganizationListener = () => void;
type MovedListener = (r: LibraryMoveReceipt) => void;
type Where = Exclude<LibraryLocation, 'trash'>;

export class FsLibrary implements Library {
  readonly root: string;
  private readonly d: FsLibraryDeps;
  private readonly locks = new LockSet();
  private readonly reservations = new Set<string>();
  private entries = new Map<string, CatalogEntry>();
  private readOnlyReason: ReadOnlyReason | undefined;
  private readonly changedListeners = new Set<ChangedListener>();
  private readonly suggestionsListeners = new Set<SuggestionsListener>();
  private readonly organizationListeners = new Set<OrganizationListener>();
  private readonly movedListeners = new Set<MovedListener>();
  private merge: MergeDelegate | undefined;
  /** `.eli5/organization.json` (09 §4.2); replaced whole on every write, under the catalog lock. */
  private org: OrganizationFile = emptyOrganization();
  /** Slugs whose last html write could not save its version (09 §4.1); cleared by the next one. */
  private readonly degraded = new Set<string>();

  constructor(deps: FsLibraryDeps) {
    this.d = deps;
    this.root = deps.root;
  }

  get readOnly(): boolean {
    return this.readOnlyReason !== undefined;
  }

  /** 09 §8.5; the first reason wins. */
  enterReadOnly(reason: ReadOnlyReason): void {
    if (this.readOnlyReason === undefined) {
      this.readOnlyReason = reason;
      this.d.logger.warn('library.read-only', { kind: reason });
    }
  }

  /** `eli5:library:info` payload (09 §11). */
  info(): LibraryInfo {
    const reason = this.readOnlyReason;
    return {
      root: this.root,
      readOnly: reason !== undefined,
      ...(reason ? { readOnlyReason: READ_ONLY_MESSAGES[reason] } : {}),
      count: this.entries.size,
    };
  }

  // ---- listing (catalog only; never reads index.html) ----

  list(): CatalogEntry[] {
    return newestFirst(this.entries.values()).map((e) => ({ ...e }));
  }

  /** The n latest-created entries not in the Archive (09 §9.1, §4.2). */
  recents(n = 3): CatalogEntry[] {
    return this.list()
      .filter((e) => locationIn(this.org, e.id) !== 'archive')
      .slice(0, Math.max(0, n));
  }

  getEntry(idOrSlug: string): CatalogEntry | undefined {
    const e = this.entries.get(idOrSlug) ?? [...this.entries.values()].find((x) => x.topicSlug === idOrSlug);
    return e ? { ...e } : undefined;
  }

  /** Slug lookup only; used by the eli5doc:// handler. */
  hasSlug(slug: string): boolean {
    for (const e of this.entries.values()) if (e.topicSlug === slug) return true;
    return false;
  }

  async getMeta(slug: string): Promise<DocumentMeta> {
    const file = this.docPath(slug, META_FILE);
    const r = await this.readMeta(file, !this.readOnly && this.hasSlug(slug)).catch((err: unknown) => {
      // EISDIR, EACCES, ELOOP...: unreadable meta is invalid meta (09 §7 step 2).
      this.d.logger.warn('library.meta-invalid', { slug, errno: errnoOf(err) });
      throw new LibraryError('META_INVALID', { slug });
    });
    switch (r.status) {
      case 'ok':
        return r.data;
      case 'newer':
        this.enterReadOnly('newer-schema');
        return r.data;
      case 'missing':
        throw new LibraryError('NOT_FOUND', { slug });
      case 'corrupt':
        this.d.logger.warn('library.meta-invalid', { slug, kind: r.reason });
        throw new LibraryError('META_INVALID', { slug });
    }
  }

  private readMeta(file: string, allowWrite: boolean) {
    return readVersioned(file, {
      schema: DocumentMetaSchema,
      lenient: DocumentMetaSchema,
      chain: metaMigrations,
      current: META_SCHEMA_VERSION,
      allowWrite,
      renameCorrupt: false,
      now: () => this.d.clock.now(),
    });
  }

  /** 09 §9: valid slug pattern and inside the real root, else PATH_OUTSIDE_ROOT. */
  docPath(slug: string, file: 'index.html' | 'meta.json' = INDEX_FILE): string {
    if (!isValidSlug(slug)) throw new LibraryError('PATH_OUTSIDE_ROOT', { slug: 'invalid' });
    const p = path.resolve(this.root, slug, file);
    if (!p.startsWith(this.root + path.sep)) throw new LibraryError('PATH_OUTSIDE_ROOT', { slug });
    return p;
  }

  /** `<root>/.staging/<jobId>/` for the pipeline (06 §5.7). Created on demand. */
  async stagingDir(jobId: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw new LibraryError('PATH_OUTSIDE_ROOT', { jobId: 'invalid' });
    const dir = path.join(this.root, STAGING_DIR, jobId);
    await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });
    return dir;
  }

  // ---- locks (09 §8.3) ----

  withDocLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.with(`doc:${slug}`, fn);
  }

  withDocLocks<T>(slugs: string[], fn: () => Promise<T>): Promise<T> {
    return this.locks.withAll(
      slugs.map((s) => `doc:${s}`),
      fn,
    );
  }

  withCatalogLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.locks.with(CATALOG_KEY, fn);
  }

  holdsDocLock(slug: string): boolean {
    return this.locks.holds(`doc:${slug}`);
  }

  // ---- writes ----

  private assertWritable(): void {
    if (this.readOnly) throw new LibraryError('LIBRARY_READ_ONLY', { kind: this.readOnlyReason });
  }

  /** 09 §6.2: under the catalog lock; taken = folder names (case-insensitive), catalog, reservations. */
  async allocateSlug(title: string, hint?: string): Promise<SlugReservation> {
    this.assertWritable();
    return this.withCatalogLock(async () => {
      const taken: string[] = [...this.reservations];
      for (const e of this.entries.values()) taken.push(e.topicSlug);
      for (const name of await fsp.readdir(this.root)) taken.push(name);
      // A trashed document keeps its slug, so Put Back can restore it unchanged (09 §4.2).
      taken.push(...(await this.trashedSlugs()));
      const slug = chooseSlug(title, hint, taken, {
        now: this.d.clock.now(),
        randomHex: () => this.d.ids.hex(8),
      });
      this.reservations.add(slug);
      let released = false;
      return {
        slug,
        release: () => {
          if (released) return;
          released = true;
          this.reservations.delete(slug);
        },
      };
    });
  }

  /** 09 §8.2. `stagingDir` must be `<root>/.staging/<jobId>/` holding exactly index.html + meta.json. */
  async commitDocument(r: SlugReservation, stagingDir: string, meta: DocumentMeta): Promise<CatalogEntry> {
    this.assertWritable();
    const slug = r.slug;
    const target = this.docPath(slug);
    const dest = path.dirname(target);
    const staging = await this.checkStaging(stagingDir);

    const entry = await this.withDocLock(slug, async () => {
      const parsed = DocumentMetaSchema.safeParse({ ...meta, topicSlug: slug });
      if (!parsed.success) throw new LibraryError('META_INVALID', { slug });
      const clean = sanitizeMeta(parsed.data, this.d.policy.sourceUrls);
      const names = (await fsp.readdir(staging)).sort();
      if (names.length !== 2 || names[0] !== INDEX_FILE || names[1] !== META_FILE) {
        throw new LibraryError('WRITE_FAILED', { slug, kind: 'staging-contents' });
      }
      // The committed meta.json is the validated, sanitized one.
      await writeJsonAtomic(path.join(staging, META_FILE), clean);
      await fsp.chmod(staging, DIR_MODE).catch(() => {});

      return this.withCatalogLock(async () => {
        // lstat, not rename, detects an existing empty dir, file or symlink (09 §8.2 step 2).
        const existing = await fsp.lstat(dest).catch((err: unknown) => {
          if (isErrno(err, 'ENOENT')) return undefined;
          throw err;
        });
        if (existing) throw new LibraryError('SLUG_TAKEN', { slug });
        try {
          await renameDirAtomic(staging, dest);
        } catch (err) {
          throw new LibraryError('WRITE_FAILED', { slug, errno: errnoOf(err) });
        }
        const e = entryFromMeta(clean);
        this.entries.set(e.id, e);
        await this.writeCatalog();
        return e;
      });
    });
    r.release();
    this.d.logger.info('library.created', { slug });
    this.emitChanged('created', [slug]);
    return { ...entry };
  }

  private async checkStaging(stagingDir: string): Promise<string> {
    let real: string;
    try {
      real = await fsp.realpath(stagingDir);
    } catch {
      throw new LibraryError('NOT_FOUND', { kind: 'staging' });
    }
    if (path.dirname(real) !== path.join(this.root, STAGING_DIR)) {
      throw new LibraryError('PATH_OUTSIDE_ROOT', { kind: 'staging' });
    }
    return real;
  }

  /** 09 §9. Caller holds `withDocLock(slug)` (LOCK_NOT_HELD in dev; taken implicitly otherwise). */
  async updateDocument(slug: string, patch: DocumentPatch): Promise<CatalogEntry> {
    this.assertWritable();
    this.docPath(slug);
    if (!this.holdsDocLock(slug)) {
      if (this.d.devChecks) throw new LibraryError('LOCK_NOT_HELD', { slug });
      return this.withDocLock(slug, () => this.updateDocument(slug, patch));
    }
    const clean = await this.writeDocumentFiles(slug, patch);
    const entry = await this.withCatalogLock(async () => {
      const e = entryFromMeta(clean);
      this.entries.set(e.id, e);
      await this.writeCatalog();
      return e;
    });
    this.emitChanged('updated', [slug]);
    return { ...entry };
  }

  /**
   * The file half of `updateDocument`: validated meta, index.html then meta.json (the meta write is
   * the commit point, 09 §10.6 step 7). No catalog write, no event; the merge flow (09 §10.6) does
   * those itself in step 9. Caller holds `withDocLock(slug)`.
   *
   * With `html`, the new files become a version node whose parent is the current one (09 §4.1):
   * the tree is materialized, the blob and node file are written before the commit, the tree after
   * it. Saving the version is best effort: when it fails the edit still commits, without a
   * versionId, and the document's history is flagged degraded until the next saved change.
   */
  async writeDocumentFiles(slug: string, patch: DocumentPatch): Promise<DocumentMeta> {
    this.assertWritable();
    this.docPath(slug);
    if (!this.holdsDocLock(slug)) throw new LibraryError('LOCK_NOT_HELD', { slug });
    if (!this.hasSlug(slug)) throw new LibraryError('NOT_FOUND', { slug });
    const current = await this.getMeta(slug);
    this.assertWritable();
    const next = patch.meta(structuredClone(current));
    const parsed = DocumentMetaSchema.safeParse({
      ...next,
      id: current.id,
      topicSlug: slug,
      createdAt: current.createdAt,
      updatedAt: this.d.clock.now().toISOString(),
    });
    if (!parsed.success) throw new LibraryError('META_INVALID', { slug });
    const clean = sanitizeMeta(parsed.data, this.d.policy.sourceUrls);
    if (patch.html === undefined) {
      await writeJsonAtomic(this.docPath(slug, META_FILE), clean);
      return clean;
    }

    const vp = this.versionPaths(slug);
    let saved: { tree: VersionTreeFile; node: VersionNodeRecord } | undefined;
    try {
      const { tree } = await this.materialize(slug);
      const blob = await writeBlob(vp, patch.html);
      const node = nodeRecordFor(this.mintVersionId(tree), tree.currentId, clean.updatedAt, patch, blob);
      await writeNodeFile(vp, node, { ...clean, versionId: node.id });
      saved = { tree, node };
    } catch (err) {
      this.d.logger.warn('library.version-save-failed', {
        slug,
        errno: errnoOf(err),
        ...(err instanceof LibraryError ? { kind: err.code } : {}),
      });
    }
    // The version store may have found the library newer than this app (read-only): never commit then.
    this.assertWritable();
    const { versionId: _was, ...rest } = clean;
    const committed: DocumentMeta = saved ? { ...rest, versionId: saved.node.id } : rest;
    try {
      await writeFileAtomic(this.docPath(slug, INDEX_FILE), patch.html);
      await writeJsonAtomic(this.docPath(slug, META_FILE), committed);
    } catch (err) {
      if (saved) await removeNodeFile(vp, saved.node.id);
      throw err;
    }
    if (saved) {
      this.degraded.delete(slug);
      await this.indexNode(slug, saved.tree, saved.node);
    } else {
      this.degraded.add(slug);
    }
    return committed;
  }

  // ---- the version tree (09 §4.1) ----

  private versionPaths(slug: string): VersionPaths {
    return versionPaths(path.dirname(this.docPath(slug)));
  }

  /** 6 random bytes as 'v-' + 12 hex, redrawn on a clash. */
  private mintVersionId(tree: VersionTreeFile): string {
    let id: string;
    do id = `v-${this.d.ids.hex(12)}`;
    while (nodeOf(tree, id));
    return id;
  }

  /** After the commit: the node joins the tree as the current one. Only logged on failure (adopted later). */
  private async indexNode(slug: string, tree: VersionTreeFile, node: VersionNodeRecord): Promise<void> {
    try {
      const parent = nodeOf(tree, node.parentId);
      tree.nodes.push(node);
      if (parent) parent.forwardId = node.id;
      tree.currentId = node.id;
      await this.saveTree(slug, tree);
    } catch (err) {
      this.d.logger.warn('library.version-index-failed', { slug, errno: errnoOf(err) });
    }
  }

  /** Prunes (09 §4.1 retention), writes tree.json, then drops what the pruning released. */
  private async saveTree(slug: string, tree: VersionTreeFile): Promise<VersionTreeFile> {
    const vp = this.versionPaths(slug);
    const plan = planPrune(tree);
    await writeTree(vp, plan.tree);
    for (const id of plan.removed) await removeNodeFile(vp, id);
    for (const sha of plan.unreferencedBlobs) await removeBlob(vp, sha);
    if (plan.stubbed.length + plan.removed.length > 0) {
      this.d.logger.debug('library.versions-pruned', { slug, count: plan.stubbed.length + plan.removed.length });
    }
    return plan.tree;
  }

  /** Live meta and index.html as one consistent pair (re-read when a commit raced the read). */
  private async readLive(slug: string): Promise<{ plan: VersionPlan; meta: DocumentMeta }> {
    const docDir = path.dirname(this.docPath(slug));
    for (let attempt = 0; ; attempt++) {
      const meta = await this.getMeta(slug);
      let html: Buffer;
      try {
        html = await fsp.readFile(this.docPath(slug, INDEX_FILE));
      } catch (err) {
        if (isErrno(err, 'ENOENT')) throw new LibraryError('NOT_FOUND', { slug });
        throw err;
      }
      const plan = await planVersions(docDir, { html, meta }, () => this.d.clock.now());
      if (!plan.detached || attempt >= 2) return { plan, meta };
      const again = await this.getMeta(slug);
      if (again.updatedAt === meta.updatedAt && again.versionId === meta.versionId) return { plan, meta };
    }
  }

  /**
   * Write paths only, under the doc lock; idempotent (09 §4.1). Persists what `planVersions`
   * resolved: seeds a first tree (from a legacy `.prev/` slot when paired), adopts a node the index
   * missed, snapshots detached content as an `outside` node, points live meta at the current node
   * (keeping updatedAt), removes `.prev/` once tree.json is durable, and sweeps orphans.
   */
  private async materialize(slug: string): Promise<{ tree: VersionTreeFile; live: DocumentMeta }> {
    if (!this.holdsDocLock(slug)) throw new LibraryError('LOCK_NOT_HELD', { slug });
    const docDir = path.dirname(this.docPath(slug));
    const vp = versionPaths(docDir);
    // A symlinked or non-directory `.versions` would write outside the document: refuse.
    const st = await fsp.lstat(vp.dir).catch(() => undefined);
    if (st && !st.isDirectory()) throw new LibraryError('WRITE_FAILED', { slug, kind: 'versions-not-dir' });
    const { plan, meta } = await this.readLive(slug);
    this.assertWritable();
    if (plan.readOnly) throw new LibraryError('LIBRARY_READ_ONLY', { slug, kind: 'newer-tree' });
    for (const n of plan.newNodes) {
      const blob = await writeBlob(vp, n.html);
      n.node.bytes = blob.bytes;
      await writeNodeFile(vp, n.node, n.meta);
    }
    if (plan.corruptTree) {
      const aside = `${vp.tree}.corrupt-${compactTimestamp(this.d.clock.now())}`;
      await fsp.rename(vp.tree, aside).catch(() => {});
      this.d.logger.warn('library.version-tree-invalid', { slug });
    }
    // The node files are written, so a failed index write is recovered by the next write path
    // (adoption); only `.prev/` must wait for a durable tree.json.
    let tree = plan.tree;
    let durable = !plan.dirty;
    if (plan.dirty) {
      try {
        tree = await this.saveTree(slug, plan.tree);
        durable = true;
      } catch (err) {
        this.d.logger.warn('library.version-index-failed', { slug, errno: errnoOf(err) });
      }
    }
    let live = meta;
    if (meta.versionId !== tree.currentId) {
      const parsed = DocumentMetaSchema.safeParse({ ...meta, versionId: tree.currentId });
      if (!parsed.success) throw new LibraryError('META_INVALID', { slug });
      live = sanitizeMeta(parsed.data, this.d.policy.sourceUrls);
      await writeJsonAtomic(this.docPath(slug, META_FILE), live);
    }
    if (plan.removePrev && durable) {
      await fsp.rm(path.join(docDir, PREV_DIR), { recursive: true, force: true });
      await fsyncDir(docDir);
    }
    await sweepOrphans(vp, tree, tree.currentId);
    if (plan.newNodes.length > 0) {
      this.d.logger.info('library.versions-saved', { slug, count: plan.newNodes.length });
    }
    return { tree, live };
  }

  private viewOf(slug: string, tree: VersionTreeFile, live: DocumentMeta): VersionTreeView {
    const last = live.publications.at(-1);
    return {
      slug,
      tree,
      detached: false,
      readOnly: this.readOnly,
      degraded: this.degraded.has(slug),
      ...(last ? { publishedSha: last.contentSha256 } : {}),
    };
  }

  /** The version tree right now (09 §4.1): lock-free, and never writes (D5). */
  async versions(slug: string): Promise<VersionTreeView> {
    this.docPath(slug);
    if (!this.hasSlug(slug)) throw new LibraryError('NOT_FOUND', { slug });
    const { plan, meta } = await this.readLive(slug);
    return {
      ...this.viewOf(slug, plan.tree, meta),
      detached: plan.detached,
      readOnly: this.readOnly || plan.readOnly,
    };
  }

  /** A version's exact index.html and meta snapshot. Lock-free; never writes. */
  async readVersion(slug: string, id: string): Promise<{ html: Buffer; meta: DocumentMeta; node: VersionNodeRecord }> {
    this.docPath(slug);
    if (!this.hasSlug(slug)) throw new LibraryError('NOT_FOUND', { slug });
    const { plan } = await this.readLive(slug);
    const node = nodeOf(plan.tree, id);
    if (!node) throw new LibraryError('VERSION_NOT_FOUND', { slug });
    if (!node.sha256) throw new LibraryError('VERSION_NOT_FOUND', { slug, kind: 'pruned' });
    const planned = plan.newNodes.find((n) => n.node.id === id);
    if (planned) return { html: planned.html, meta: planned.meta, node: { ...node } };
    const vp = this.versionPaths(slug);
    const file = await readNodeFile(vp, id);
    if (!file) throw new LibraryError('VERSION_CORRUPT', { slug });
    return { html: await readBlob(vp, node.sha256), meta: file.meta, node: { ...node } };
  }

  /**
   * Makes version `id` the live document (09 §4.1, D1). Caller holds `withDocLock(slug)` (same rule
   * as updateDocument). The meta is the version's own, except id, topicSlug, createdAt and
   * publications, which stay as they are live; updatedAt is now and `retiredIds` is the caller's
   * (08 works out the IDs no version may reuse). With `html` (a runtime upgrade of the same
   * model) that html is written and becomes the node's snapshot. Checking out the current node
   * writes nothing.
   */
  async checkout(
    slug: string,
    id: string,
    opts: { retiredIds: SectionId[]; html?: string | Uint8Array },
  ): Promise<{ tree: VersionTreeView; node: VersionNodeRecord; previousId: string }> {
    this.assertWritable();
    this.docPath(slug);
    if (!this.holdsDocLock(slug)) {
      if (this.d.devChecks) throw new LibraryError('LOCK_NOT_HELD', { slug });
      return this.withDocLock(slug, () => this.checkout(slug, id, opts));
    }
    const out = await this.checkoutLocked(slug, id, opts);
    if (out.previousId !== id) this.emitChanged('updated', [slug]);
    return out;
  }

  private async checkoutLocked(
    slug: string,
    id: string,
    opts: { retiredIds: SectionId[]; html?: string | Uint8Array },
  ): Promise<{ tree: VersionTreeView; node: VersionNodeRecord; previousId: string }> {
    if (!this.hasSlug(slug)) throw new LibraryError('NOT_FOUND', { slug });
    const { tree, live } = await this.materialize(slug);
    const node = nodeOf(tree, id);
    if (!node) throw new LibraryError('VERSION_NOT_FOUND', { slug });
    const previousId = tree.currentId;
    if (id === previousId) return { tree: this.viewOf(slug, tree, live), node: { ...node }, previousId };
    if (!node.sha256) throw new LibraryError('VERSION_NOT_FOUND', { slug, kind: 'pruned' });

    const vp = this.versionPaths(slug);
    let html: Buffer;
    let file: VersionNodeFile | undefined;
    try {
      file = await readNodeFile(vp, id);
      if (!file) throw new LibraryError('VERSION_CORRUPT', { slug });
      html = await readBlob(vp, node.sha256);
    } catch (err) {
      if (err instanceof LibraryError && err.code === 'VERSION_CORRUPT') {
        // The snapshot is unusable: keep the node as a stub so it is never offered again.
        node.sha256 = null;
        node.bytes = 0;
        await this.saveTree(slug, tree).catch(() => {});
        this.d.logger.warn('library.version-corrupt', { slug });
      }
      throw err;
    }
    const parsed = DocumentMetaSchema.safeParse({
      ...file.meta,
      id: live.id,
      topicSlug: slug,
      createdAt: live.createdAt,
      publications: live.publications,
      updatedAt: this.d.clock.now().toISOString(),
      versionId: id,
      retiredIds: opts.retiredIds,
    });
    if (!parsed.success) throw new LibraryError('META_INVALID', { slug, kind: 'version' });
    const clean = sanitizeMeta(parsed.data, this.d.policy.sourceUrls);

    let body: string | Uint8Array = html;
    const before = { ...node };
    if (opts.html !== undefined) {
      const blob = await writeBlob(vp, opts.html);
      node.sha256 = blob.sha256;
      node.bytes = blob.bytes;
      await writeNodeFile(vp, node, file.meta);
      body = opts.html;
    }
    try {
      await writeFileAtomic(this.docPath(slug, INDEX_FILE), body);
      await writeJsonAtomic(this.docPath(slug, META_FILE), clean);
    } catch (err) {
      // The node keeps its old snapshot: put its record back as it was.
      if (opts.html !== undefined) await writeNodeFile(vp, before, file.meta).catch(() => {});
      throw err;
    }

    // Back to an ancestor: point forwardId down the path just left, so Redo retraces it.
    tree.currentId = id;
    const up = pathToRoot(tree, previousId);
    for (let i = up.findIndex((n) => n.id === id); i > 0; i--) {
      const above = up[i];
      const below = up[i - 1];
      if (above && below) above.forwardId = below.id;
    }
    let saved = tree;
    try {
      saved = await this.saveTree(slug, tree);
      const oldSha = before.sha256;
      if (oldSha && oldSha !== node.sha256 && !saved.nodes.some((n) => n.sha256 === oldSha)) {
        await removeBlob(vp, oldSha);
      }
    } catch (err) {
      this.d.logger.warn('library.version-index-failed', { slug, errno: errnoOf(err) });
    }
    await this.withCatalogLock(async () => {
      const e = entryFromMeta(clean);
      this.entries.set(e.id, e);
      await this.writeCatalog();
    });
    this.d.logger.info('library.version-checkout', { slug });
    return { tree: this.viewOf(slug, saved, clean), node: { ...(nodeOf(saved, id) ?? node) }, previousId };
  }

  /**
   * Rewrites the current version's index.html (a runtime upgrade of the same model, 07 §5.5): the
   * node keeps its id and takes the new snapshot; meta.json is untouched. Caller holds the lock.
   */
  async refreshRuntime(slug: string, html: string | Uint8Array): Promise<void> {
    this.assertWritable();
    this.docPath(slug);
    if (!this.holdsDocLock(slug)) {
      if (this.d.devChecks) throw new LibraryError('LOCK_NOT_HELD', { slug });
      return this.withDocLock(slug, () => this.refreshRuntime(slug, html));
    }
    if (!this.hasSlug(slug)) throw new LibraryError('NOT_FOUND', { slug });
    const { tree } = await this.materialize(slug);
    const node = nodeOf(tree, tree.currentId);
    if (!node) throw new LibraryError('VERSION_NOT_FOUND', { slug });
    const vp = this.versionPaths(slug);
    const file = await readNodeFile(vp, node.id);
    const before = { ...node };
    const oldSha = node.sha256;
    const blob = await writeBlob(vp, html);
    node.sha256 = blob.sha256;
    node.bytes = blob.bytes;
    // The node record names the new snapshot before the commit, so a crash before tree.json is
    // recovered as the same node (not an outside edit).
    if (file) await writeNodeFile(vp, node, file.meta);
    try {
      await writeFileAtomic(this.docPath(slug, INDEX_FILE), html);
    } catch (err) {
      if (file) await writeNodeFile(vp, before, file.meta).catch(() => {});
      throw err;
    }
    try {
      await this.saveTree(slug, tree);
      if (oldSha && !tree.nodes.some((n) => n.sha256 === oldSha)) await removeBlob(vp, oldSha);
    } catch (err) {
      this.d.logger.warn('library.version-index-failed', { slug, errno: errnoOf(err) });
    }
    this.d.logger.info('library.runtime-refreshed', { slug });
  }

  /** What Undo and Redo offer for `slug` right now (no `busy`; 08 adds it). Lock-free. */
  async history(slug: string): Promise<DocHistoryState> {
    return historyFromTree((await this.versions(slug)).tree);
  }

  undo(slug: string): Promise<DocHistoryState> {
    return this.step(slug, 'undo');
  }

  redo(slug: string): Promise<DocHistoryState> {
    return this.step(slug, 'redo');
  }

  /**
   * Undo checks out the parent, Redo the redo child (09 §4.1); HISTORY_EMPTY when there is none.
   * Takes the doc lock unless the caller holds it. The library cannot parse documents, so the
   * retired IDs are the union of both versions' (08 refines this when it checks out itself).
   */
  private async step(slug: string, dir: 'undo' | 'redo'): Promise<DocHistoryState> {
    this.assertWritable();
    this.docPath(slug);
    const run = async () => {
      if (!this.hasSlug(slug)) throw new LibraryError('NOT_FOUND', { slug });
      const { tree, live } = await this.materialize(slug);
      const parent = nodeOf(tree, nodeOf(tree, tree.currentId)?.parentId);
      const target =
        dir === 'undo' ? (parent && isAvailable(parent) ? parent : undefined) : redoChild(tree, tree.currentId);
      if (!target) throw new LibraryError('HISTORY_EMPTY', { slug });
      const old = await readNodeFile(this.versionPaths(slug), target.id);
      const retiredIds = [...new Set([...live.retiredIds, ...(old?.meta.retiredIds ?? [])])];
      return (await this.checkoutLocked(slug, target.id, { retiredIds })).tree;
    };
    const view = this.holdsDocLock(slug) ? await run() : await this.withDocLock(slug, run);
    this.d.logger.info('library.history-step', { slug, kind: dir });
    this.emitChanged('updated', [slug]);
    return historyFromTree(view.tree);
  }

  /**
   * 09 §10.6 step 9: under the catalog lock, drop the merged-away source entry and upsert the target
   * from its committed meta (updatedAt, tabCount, mergedFromCount). Idempotent (09 §10.8 step 2).
   */
  async applyMergeToCatalog(target: DocumentMeta | undefined, sourceId: string): Promise<void> {
    this.assertWritable();
    await this.withCatalogLock(async () => {
      this.entries.delete(sourceId);
      if (target) this.entries.set(target.id, entryFromMeta(target));
      await this.writeCatalog();
    });
  }

  /**
   * 10 §4 step 7: appends a PublicationRecord to meta.json (atomic) and nothing else. Publishing is
   * not an edit: `updatedAt`, catalog.json and the catalog entry stay as they are, and no Library
   * change is emitted. Same lock rule as updateDocument.
   */
  async appendPublication(slug: string, record: PublicationRecord): Promise<void> {
    this.assertWritable();
    this.docPath(slug);
    if (!this.holdsDocLock(slug)) {
      if (this.d.devChecks) throw new LibraryError('LOCK_NOT_HELD', { slug });
      return this.withDocLock(slug, () => this.appendPublication(slug, record));
    }
    if (!this.hasSlug(slug)) throw new LibraryError('NOT_FOUND', { slug });
    const current = await this.getMeta(slug);
    this.assertWritable();
    const parsed = DocumentMetaSchema.safeParse({ ...current, publications: [...current.publications, record] });
    if (!parsed.success) throw new LibraryError('META_INVALID', { slug });
    await writeJsonAtomic(this.docPath(slug, META_FILE), sanitizeMeta(parsed.data, this.d.policy.sourceUrls));
  }

  /** 09 §9: `updateDocument(slug, {meta: m => m})`. */
  touch(slug: string): Promise<CatalogEntry> {
    return this.updateDocument(slug, { meta: (m) => m });
  }

  /**
   * Moves a document folder to `.trash/<slug>--<ts>`, drops its entry and records where it was
   * filed (09 §4.2). Takes the doc lock itself. Returns the receipt; the files stay intact.
   */
  async trashDocument(slug: string): Promise<LibraryMoveReceipt> {
    this.assertWritable();
    const dir = path.dirname(this.docPath(slug));
    const receipt = await this.withDocLock(slug, () =>
      this.withCatalogLock(async () => {
        const entry = [...this.entries.values()].find((e) => e.topicSlug === slug);
        if (!entry) throw new LibraryError('NOT_FOUND', { slug });
        const from = locationIn(this.org, entry.id);
        const dest = await this.moveToTrash(dir, slug);
        this.entries.delete(entry.id);
        await this.writeCatalog();
        const trashId = path.basename(dest);
        const record: TrashRecord = {
          docId: entry.id,
          trashedAt: this.d.clock.now().toISOString(),
          reason: 'trashed',
          from,
          ...(isFolderId(from) ? { fromName: this.folderById(from)?.name ?? '' } : {}),
        };
        const next = withPlacement(this.org, entry.id, 'unfiled');
        await this.writeOrganization({ ...next, trashed: { ...next.trashed, [trashId]: record } });
        return { slug, docId: entry.id, title: entry.title, from, to: 'trash', trashId } satisfies LibraryMoveReceipt;
      }),
    );
    this.d.logger.info('library.removed', { slug });
    this.emitChanged('removed', [slug]);
    this.emitOrganization();
    return receipt;
  }

  /** `.trash/<name>--<yyyymmddThhmmss>[-n]` (09 §4). Returns the trash path. */
  async moveToTrash(dir: string, name: string, suffix = ''): Promise<string> {
    const base = path.join(this.root, TRASH_DIR, `${name}--${compactTimestamp(this.d.clock.now())}${suffix}`);
    let dest = base;
    for (let n = 2; await exists(dest); n++) dest = `${base}-${n}`;
    await fsp.mkdir(path.join(this.root, TRASH_DIR), { recursive: true, mode: DIR_MODE });
    try {
      await renameDirAtomic(dir, dest);
    } catch (err) {
      throw new LibraryError('WRITE_FAILED', { errno: errnoOf(err) });
    }
    return dest;
  }

  // ---- organization: folders, Archive, Trash (09 §4.2) ----

  /** Loads `.eli5/organization.json`; missing means every document is unfiled (nothing to migrate). */
  async loadOrganization(): Promise<void> {
    const r = await readVersioned<OrganizationFile>(this.organizationPath(), {
      schema: OrganizationFileSchema,
      lenient: OrganizationFileSchema.loose(),
      chain: organizationMigrations,
      current: ORGANIZATION_SCHEMA_VERSION,
      allowWrite: !this.readOnly,
      renameCorrupt: true,
      now: () => this.d.clock.now(),
    });
    switch (r.status) {
      case 'ok':
        this.org = r.data;
        return;
      case 'newer':
        this.org = r.data;
        this.enterReadOnly('newer-schema');
        return;
      case 'missing':
        this.org = emptyOrganization();
        return;
      case 'corrupt':
        this.d.logger.warn('library.organization-invalid', { kind: r.reason });
        this.org = emptyOrganization();
        return;
    }
  }

  private organizationPath(): string {
    return path.join(this.root, ELI5_DIR, ORGANIZATION_FILE);
  }

  /** Caller holds the catalog lock. The file is written first, then the in-memory copy. */
  private async writeOrganization(next: OrganizationFile): Promise<void> {
    if (!this.locks.holds(CATALOG_KEY)) throw new LibraryError('LOCK_NOT_HELD', { kind: 'organization' });
    const file = { ...next, schemaVersion: ORGANIZATION_SCHEMA_VERSION };
    await writeJsonAtomic(this.organizationPath(), file);
    this.org = file;
  }

  private folderById(id: string): LibraryFolder | undefined {
    return this.org.folders.find((f) => f.id === id);
  }

  /** User folders by name. */
  folders(): LibraryFolder[] {
    return sortedFolders(this.org.folders);
  }

  /** Where a catalogued document is filed; unknown ids read as unfiled. */
  locationOf(docId: string): Where {
    return locationIn(this.org, docId);
  }

  /** `eli5:library:organization`: folders, placements of catalogued documents, and the Trash. */
  async organization(): Promise<LibraryOrganization> {
    const trash = await this.listTrash();
    return organizationView(this.org, new Set(this.entries.keys()), trash, this.d.policy.trashRetentionDays);
  }

  async createFolder(name: string): Promise<LibraryFolder> {
    this.assertWritable();
    const clean = cleanFolderName(name);
    if (clean === undefined) throw new LibraryError('FOLDER_NAME_INVALID');
    const folder = await this.withCatalogLock(async () => {
      if (folderNameTaken(this.org, clean)) throw new LibraryError('FOLDER_NAME_TAKEN');
      let id: FolderId;
      do id = `f-${this.d.ids.hex(8)}`;
      while (this.folderById(id));
      const f: LibraryFolder = { id, name: clean, createdAt: this.d.clock.now().toISOString() };
      await this.writeOrganization({ ...this.org, folders: [...this.org.folders, f] });
      return f;
    });
    this.emitOrganization();
    return { ...folder };
  }

  async renameFolder(id: string, name: string): Promise<LibraryFolder> {
    this.assertWritable();
    const clean = cleanFolderName(name);
    if (clean === undefined) throw new LibraryError('FOLDER_NAME_INVALID');
    const folder = await this.withCatalogLock(async () => {
      const f = this.folderById(id);
      if (!f) throw new LibraryError('FOLDER_NOT_FOUND');
      if (folderNameTaken(this.org, clean, id)) throw new LibraryError('FOLDER_NAME_TAKEN');
      const renamed = { ...f, name: clean };
      await this.writeOrganization({ ...this.org, folders: this.org.folders.map((x) => (x.id === id ? renamed : x)) });
      return renamed;
    });
    this.emitOrganization();
    return { ...folder };
  }

  /** Moves the folder's documents to the Trash (each remembers the folder's name), then drops it. */
  async deleteFolder(id: string): Promise<{ trashed: number }> {
    this.assertWritable();
    const folder = this.folderById(id);
    if (!folder) throw new LibraryError('FOLDER_NOT_FOUND');
    const members = [...this.entries.values()].filter((e) => locationIn(this.org, e.id) === id).map((e) => e.topicSlug);
    let trashed = 0;
    for (const slug of members) {
      try {
        await this.trashDocument(slug);
        trashed++;
      } catch (err) {
        // Gone meanwhile: nothing to trash. Anything else stops the delete with the folder kept.
        if (!(err instanceof LibraryError && err.code === 'NOT_FOUND')) throw err;
      }
    }
    await this.withCatalogLock(async () => {
      const placement = Object.fromEntries(Object.entries(this.org.placement).filter(([, at]) => at !== id));
      await this.writeOrganization({ ...this.org, folders: this.org.folders.filter((f) => f.id !== id), placement });
    });
    this.emitOrganization();
    return { trashed };
  }

  /**
   * Files a document in a folder, the Archive, unfiled, or the Trash (09 §4.2). Emits `moved` with
   * a receipt the app uses to offer Undo (11 §5.2); `undo` marks the move that reverses one.
   */
  async moveDocument(slug: string, to: LibraryLocation, opts: { undo?: boolean } = {}): Promise<LibraryMoveReceipt> {
    this.assertWritable();
    if (!isValidSlug(slug)) throw new LibraryError('NOT_FOUND', { slug: 'invalid' });
    let receipt: LibraryMoveReceipt;
    if (to === 'trash') {
      receipt = await this.trashDocument(slug);
    } else {
      receipt = await this.withCatalogLock(async () => {
        const entry = [...this.entries.values()].find((e) => e.topicSlug === slug);
        if (!entry) throw new LibraryError('NOT_FOUND', { slug });
        if (isFolderId(to) && !this.folderById(to)) throw new LibraryError('FOLDER_NOT_FOUND');
        if (to !== 'unfiled' && to !== 'archive' && !isFolderId(to)) throw new LibraryError('FOLDER_NOT_FOUND');
        const from = locationIn(this.org, entry.id);
        if (from !== to) await this.writeOrganization(withPlacement(this.org, entry.id, to));
        return { slug, docId: entry.id, title: entry.title, from, to };
      });
      this.emitOrganization();
    }
    if (opts.undo) receipt = { ...receipt, undo: true };
    this.d.logger.info('library.moved', { slug, kind: to === 'trash' || to === 'archive' ? to : 'folder' });
    for (const cb of [...this.movedListeners]) {
      try {
        cb({ ...receipt });
      } catch (err) {
        this.d.logger.error('library.listener-failed', { kind: 'moved' }, err);
      }
    }
    return receipt;
  }

  /**
   * Restores a Trash entry to the Library (09 §4.2): its old slug when free, else a fresh one (the
   * meta follows); back into its old folder or the Archive when that still exists, else unfiled.
   */
  async putBack(trashId: string): Promise<{ slug: string }> {
    this.assertWritable();
    const oldSlug = slugOfTrashId(trashId);
    if (oldSlug === undefined) throw new LibraryError('TRASH_ITEM_NOT_FOUND');
    const src = path.join(this.root, TRASH_DIR, trashId);
    const slug = await this.withDocLock(oldSlug, () =>
      this.withCatalogLock(async () => {
        const html = await fsp.lstat(path.join(src, INDEX_FILE)).catch(() => undefined);
        if (!html?.isFile()) throw new LibraryError('TRASH_ITEM_NOT_FOUND');
        const r = await this.readMeta(path.join(src, META_FILE), false).catch(() => undefined);
        if (r?.status !== 'ok') throw new LibraryError(r ? 'META_INVALID' : 'TRASH_ITEM_NOT_FOUND', { kind: 'trash' });
        const taken: string[] = [...this.reservations, ...[...this.entries.values()].map((e) => e.topicSlug)];
        for (const name of await fsp.readdir(this.root)) taken.push(name);
        const free = !taken.some((t) => t.toLowerCase() === oldSlug);
        const slug = free
          ? oldSlug
          : chooseSlug(r.data.title, oldSlug, taken, { now: this.d.clock.now(), randomHex: () => this.d.ids.hex(8) });
        try {
          await renameDirAtomic(src, path.join(this.root, slug));
        } catch (err) {
          throw new LibraryError('WRITE_FAILED', { errno: errnoOf(err) });
        }
        let meta = r.data;
        // A copy of the same document is live: this one gets a new id (as reconcile would, §7 step 4).
        const clash = this.entries.has(meta.id);
        if (meta.topicSlug !== slug || clash) {
          meta = {
            ...meta,
            topicSlug: slug,
            ...(clash ? { id: uuidFrom(this.d.ids) } : {}),
            updatedAt: this.d.clock.now().toISOString(),
          };
          await writeJsonAtomic(path.join(this.root, slug, META_FILE), meta);
        }
        const e = entryFromMeta(meta);
        this.entries.set(e.id, e);
        await this.writeCatalog();
        const record = this.org.trashed[trashId];
        const back: Where =
          record?.from === 'archive' || (record && isFolderId(record.from) && this.folderById(record.from))
            ? record.from
            : 'unfiled';
        const { [trashId]: _gone, ...trashed } = this.org.trashed;
        await this.writeOrganization({ ...withPlacement(this.org, e.id, back), trashed });
        return slug;
      }),
    );
    this.d.logger.info('library.restored', { slug });
    this.emitChanged('restored', [slug]);
    this.emitOrganization();
    return { slug };
  }

  /** Deletes one Trash entry for good. */
  async deletePermanently(trashId: string): Promise<void> {
    this.assertWritable();
    if (slugOfTrashId(trashId) === undefined) throw new LibraryError('TRASH_ITEM_NOT_FOUND');
    await this.withCatalogLock(async () => {
      const dir = path.join(this.root, TRASH_DIR, trashId);
      const st = await fsp.lstat(dir).catch(() => undefined);
      if (!st?.isDirectory()) throw new LibraryError('TRASH_ITEM_NOT_FOUND');
      await fsp.rm(dir, { recursive: true, force: true });
      await fsyncDir(path.join(this.root, TRASH_DIR));
      const { [trashId]: _gone, ...trashed } = this.org.trashed;
      await this.writeOrganization({ ...this.org, trashed });
    });
    this.d.logger.info('library.trash-deleted', { count: 1 });
    this.emitOrganization();
  }

  /** Deletes every Trash entry (not the merge flow's pre-merge backups, 09 §10.6). */
  async emptyTrash(): Promise<{ deleted: number }> {
    this.assertWritable();
    const deleted = await this.withCatalogLock(async () => {
      const trash = path.join(this.root, TRASH_DIR);
      let n = 0;
      for (const name of await fsp.readdir(trash).catch(() => [] as string[])) {
        if (!TRASH_ID_RE.test(name)) continue;
        await fsp.rm(path.join(trash, name), { recursive: true, force: true });
        n++;
      }
      await fsyncDir(trash);
      await this.writeOrganization({ ...this.org, trashed: {} });
      return n;
    });
    this.d.logger.info('library.trash-deleted', { count: deleted });
    this.emitOrganization();
    return { deleted };
  }

  /** The merge flow (09 §10.6 step 8) marks the source it moved to the Trash as merged away. */
  async noteMergedAway(trashId: string, docId: string, mergedInto: string): Promise<void> {
    if (this.readOnly || slugOfTrashId(trashId) === undefined) return;
    await this.withCatalogLock(async () => {
      const from = locationIn(this.org, docId);
      const record: TrashRecord = {
        docId,
        trashedAt: this.d.clock.now().toISOString(),
        reason: 'merged',
        from,
        ...(isFolderId(from) ? { fromName: this.folderById(from)?.name ?? '' } : {}),
        mergedInto: mergedInto.slice(0, 200),
      };
      const next = withPlacement(this.org, docId, 'unfiled');
      await this.writeOrganization({ ...next, trashed: { ...next.trashed, [trashId]: record } });
    });
    this.emitOrganization();
  }

  /** Trash entries with a valid meta.json; others are not listed (Empty Trash still removes them). */
  private async listTrash(): Promise<TrashItem[]> {
    const trash = path.join(this.root, TRASH_DIR);
    const items: TrashItem[] = [];
    for (const name of await fsp.readdir(trash).catch(() => [] as string[])) {
      const slug = slugOfTrashId(name);
      if (slug === undefined) continue;
      const r = await this.readMeta(path.join(trash, name, META_FILE), false).catch(() => undefined);
      if (r?.status !== 'ok' && r?.status !== 'newer') continue;
      const rec = this.org.trashed[name];
      const at = trashTime(name);
      items.push({
        trashId: name,
        docId: r.data.id,
        title: r.data.title,
        topicSlug: slug,
        summary: r.data.summary,
        trashedAt: rec?.trashedAt ?? (at !== undefined ? new Date(at).toISOString() : r.data.updatedAt),
        reason: rec?.reason ?? 'trashed',
        from: rec?.from ?? 'unfiled',
        ...(rec?.fromName !== undefined ? { fromName: rec.fromName } : {}),
        ...(rec?.mergedInto !== undefined ? { mergedInto: rec.mergedInto } : {}),
      });
    }
    return items;
  }

  /** Slugs of user-facing Trash entries (09 §4.2: not reused while trashed). */
  private async trashedSlugs(): Promise<string[]> {
    const names = await fsp.readdir(path.join(this.root, TRASH_DIR)).catch(() => [] as string[]);
    return names.map(slugOfTrashId).filter((s): s is string => s !== undefined);
  }

  /** Housekeeping: records of Trash entries that are gone (purged, deleted by hand). */
  private async pruneTrashRecords(): Promise<void> {
    await this.withCatalogLock(async () => {
      const present = new Set(await fsp.readdir(path.join(this.root, TRASH_DIR)).catch(() => [] as string[]));
      const kept = Object.entries(this.org.trashed).filter(([id]) => present.has(id));
      if (kept.length === Object.keys(this.org.trashed).length) return;
      await this.writeOrganization({ ...this.org, trashed: Object.fromEntries(kept) });
    });
  }

  private emitOrganization(): void {
    for (const cb of [...this.organizationListeners]) {
      try {
        cb();
      } catch (err) {
        this.d.logger.error('library.listener-failed', { kind: 'organization' }, err);
      }
    }
  }

  // ---- catalog load, reconcile (09 §5.3, §7) ----

  /** Loads catalog.json; a missing file becomes empty, a corrupt one is renamed and rebuilt by reconcile. */
  async loadCatalog(): Promise<void> {
    const file = path.join(this.root, CATALOG_FILE);
    const r = await readVersioned<CatalogFile>(file, {
      schema: CatalogFileSchema,
      lenient: CatalogFileSchema.loose(),
      chain: catalogMigrations,
      current: CATALOG_SCHEMA_VERSION,
      allowWrite: !this.readOnly,
      renameCorrupt: true,
      now: () => this.d.clock.now(),
    });
    switch (r.status) {
      case 'ok':
        this.entries = new Map(r.data.entries.map((e) => [e.id, e]));
        return;
      case 'newer':
        this.entries = new Map(r.data.entries.map((e) => [e.id, e]));
        this.enterReadOnly('newer-schema');
        return;
      case 'missing':
        this.entries = new Map();
        if (!this.readOnly) await this.writeCatalog();
        return;
      case 'corrupt':
        this.d.logger.warn('library.catalog-invalid', { kind: r.reason });
        this.entries = new Map();
        return;
    }
  }

  private writeCatalog(): Promise<void> {
    return writeJsonAtomic(
      path.join(this.root, CATALOG_FILE),
      catalogFile(this.entries.values(), this.d.appVersion, this.d.clock.now()),
    );
  }

  /**
   * 09 §7. Reads meta.json only; folders without valid meta are skipped and never touched.
   * Phase 1 (catalog lock) scans read-only and rebuilds the catalog. Phase 2 applies the meta
   * patches of steps 3-4 and pending migrations, each under its doc lock (09 §8.3 lock order: doc
   * locks are never taken while the catalog lock is held), re-reading meta inside the lock.
   */
  async reconcile(): Promise<void> {
    const { changed, patches } = await this.withCatalogLock(async () => {
      const found = await this.scanFolders();
      const before = [...this.entries.values()];
      const after = found.map((f) => entryFromMeta(f.meta));
      const slugs = diffEntries(before, after);
      this.entries = new Map(after.map((e) => [e.id, e]));
      if (!this.readOnly) {
        const onDisk = await fsp.stat(path.join(this.root, CATALOG_FILE)).catch(() => undefined);
        if (slugs.length > 0 || !onDisk) await this.writeCatalog();
      }
      return { changed: slugs, patches: found.filter((f) => f.patch !== undefined) };
    });
    if (!this.readOnly) {
      for (const f of patches) if (f.patch) await this.applyReconcilePatch(f.meta.topicSlug, f.patch);
      await this.housekeeping();
    }
    if (changed.length > 0) {
      this.d.logger.info('library.reconciled', { count: changed.length });
      this.emitChanged('reconciled', changed);
    }
  }

  private async scanFolders(): Promise<ScannedFolder[]> {
    const dirents = await fsp.readdir(this.root, { withFileTypes: true });
    const found: ScannedFolder[] = [];
    for (const d of dirents) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      if (!isValidSlug(d.name)) {
        this.d.logger.warn('library.folder-skipped', { kind: 'invalid-name' });
        continue;
      }
      const dir = path.join(this.root, d.name);
      const html = await fsp.stat(path.join(dir, INDEX_FILE)).catch(() => undefined);
      if (!html?.isFile()) {
        this.d.logger.debug('library.folder-skipped', { slug: d.name, kind: 'no-index' });
        continue;
      }
      // Step 2: unreadable meta (EISDIR, EACCES, ELOOP) is skipped like invalid meta.
      let r: Awaited<ReturnType<FsLibrary['readMeta']>>;
      try {
        r = await this.readMeta(path.join(dir, META_FILE), false);
      } catch (err) {
        this.d.logger.warn('library.meta-invalid', { slug: d.name, errno: errnoOf(err) });
        continue;
      }
      if (r.status === 'missing') {
        this.d.logger.debug('library.folder-skipped', { slug: d.name, kind: 'no-meta' });
        continue;
      }
      if (r.status === 'corrupt') {
        this.d.logger.warn('library.meta-invalid', { slug: d.name, kind: r.reason });
        continue;
      }
      if (r.status === 'newer') this.enterReadOnly('newer-schema');
      const patch: ReconcilePatch = {};
      let meta = r.data;
      if (r.status === 'ok' && r.migratedFrom !== undefined) patch.migrate = true;
      // Step 3: the folder name wins (the user may have renamed it in Finder).
      if (meta.topicSlug !== d.name) {
        meta = { ...meta, topicSlug: d.name };
        if (r.status === 'ok') patch.topicSlug = true;
      }
      found.push({ meta, patch: Object.keys(patch).length > 0 ? patch : undefined });
    }

    // Step 4: duplicate IDs (a copied folder): the earliest createdAt keeps the ID.
    found.sort((a, b) =>
      a.meta.createdAt === b.meta.createdAt
        ? a.meta.topicSlug.localeCompare(b.meta.topicSlug)
        : a.meta.createdAt < b.meta.createdAt
          ? -1
          : 1,
    );
    const seen = new Set<string>();
    for (const f of found) {
      if (seen.has(f.meta.id)) {
        const newId = uuidFrom(this.d.ids);
        f.patch = { ...f.patch, id: { from: f.meta.id, to: newId } };
        f.meta = { ...f.meta, id: newId };
      }
      seen.add(f.meta.id);
    }
    // Rewritten metas get a fresh updatedAt (09 §5.2 "every write updates updatedAt").
    const now = this.d.clock.now().toISOString();
    for (const f of found) if (f.patch && (f.patch.id || f.patch.topicSlug)) f.meta = { ...f.meta, updatedAt: now };
    return found;
  }

  /** Phase 2 of reconcile: one folder's meta rewrite under its doc lock, then a catalog upsert. */
  private async applyReconcilePatch(slug: string, patch: ReconcilePatch): Promise<void> {
    try {
      await this.withDocLock(slug, async () => {
        const file = path.join(this.root, slug, META_FILE);
        // Re-read inside the lock; this also writes any pending migration (09 §5.3).
        const r = await this.readMeta(file, true);
        if (r.status !== 'ok') return;
        let meta = r.data;
        let dirty = false;
        if (meta.topicSlug !== slug) {
          meta = { ...meta, topicSlug: slug };
          dirty = true;
        }
        // Only reassign when the folder still carries the duplicated ID.
        if (patch.id && meta.id === patch.id.from) {
          meta = { ...meta, id: patch.id.to };
          dirty = true;
        }
        if (!dirty && r.migratedFrom === undefined) return;
        if (dirty) {
          meta = { ...meta, updatedAt: this.d.clock.now().toISOString() };
          await writeJsonAtomic(file, meta);
        }
        await this.withCatalogLock(async () => {
          for (const [id, e] of this.entries) if (e.topicSlug === slug && id !== meta.id) this.entries.delete(id);
          this.entries.set(meta.id, entryFromMeta(meta));
          await this.writeCatalog();
        });
      });
    } catch (err) {
      this.d.logger.warn('library.meta-write-failed', { slug, errno: errnoOf(err) });
    }
  }

  /**
   * 09 §7 step 8: stale temp files (also under each `.versions/`, 09 §4.1) and expired trash
   * (HOOK-LIB-01 retention). By age only, so no doc lock is needed.
   */
  private async housekeeping(): Promise<void> {
    const now = this.d.clock.now().getTime();
    const docDirs = [...this.entries.values()].map((e) => path.join(this.root, e.topicSlug));
    const dirs = [
      this.root,
      path.join(this.root, ELI5_DIR),
      ...docDirs,
      ...docDirs.flatMap((d) => {
        const v = versionPaths(d);
        return [v.dir, v.nodes, v.blobs];
      }),
    ];
    let removed = 0;
    for (const dir of dirs) {
      const names = await fsp.readdir(dir).catch(() => [] as string[]);
      for (const n of names) {
        if (!TMP_FILE_RE.test(n)) continue;
        const p = path.join(dir, n);
        const st = await fsp.lstat(p).catch(() => undefined);
        if (!st || now - st.mtimeMs <= TMP_MAX_AGE_MS) continue;
        if (st.isFile()) {
          await fsp.unlink(p).catch(() => {});
          removed++;
        } else if (st.isDirectory() && PREV_TMP_RE.test(n)) {
          // A `.prev/` staging or retired folder left by a crash (09 §4.1).
          await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
          removed++;
        }
      }
    }
    const trash = path.join(this.root, TRASH_DIR);
    const cutoff = now - this.d.policy.trashRetentionDays * DAY_MS;
    for (const n of await fsp.readdir(trash).catch(() => [] as string[])) {
      const p = path.join(trash, n);
      const at = trashTime(n) ?? (await fsp.lstat(p).catch(() => undefined))?.mtimeMs;
      if (at !== undefined && at < cutoff) {
        await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
        removed++;
      }
    }
    if (removed > 0) this.d.logger.debug('library.housekeeping', { count: removed });
    await this.pruneTrashRecords().catch((err: unknown) =>
      this.d.logger.warn('library.organization-write-failed', { errno: errnoOf(err) }),
    );
    await fsyncDir(this.root);
  }

  // ---- merge (09 §10): delegated to the engine in ./merge once attached ----

  /** Plugs the merge engine in (09 §10); until then there are no suggestions. */
  attachMerge(delegate: MergeDelegate): void {
    this.merge = delegate;
  }

  /** 09 §10.1-10.2; swallows nothing itself: the engine logs and returns null on failure. */
  runMergeCheck(docId: string): Promise<MergeSuggestion | null> {
    return this.merge ? this.merge.runMergeCheck(docId) : Promise.resolve(null);
  }

  /** Pending only, newest first (09 §9). */
  suggestions(): MergeSuggestion[] {
    return this.merge ? this.merge.pending() : [];
  }

  acceptSuggestion(id: string): Promise<{ targetSlug: string }> {
    if (this.merge) return this.merge.accept(id);
    return Promise.reject(new LibraryError('SUGGESTION_STALE', { id: id.slice(0, 64) }));
  }

  dismissSuggestion(id: string): Promise<void> {
    return this.merge ? this.merge.dismiss(id) : Promise.resolve();
  }

  /** `on('suggestions')` listeners get the pending list (09 §9). */
  emitSuggestions(pending: MergeSuggestion[]): void {
    for (const cb of [...this.suggestionsListeners]) {
      try {
        cb(pending.map((x) => ({ ...x })));
      } catch (err) {
        this.d.logger.error('library.listener-failed', { kind: 'suggestions' }, err);
      }
    }
  }

  // ---- events ----

  on(event: 'changed', cb: ChangedListener): () => void;
  on(event: 'suggestions', cb: SuggestionsListener): () => void;
  on(event: 'organization', cb: OrganizationListener): () => void;
  on(event: 'moved', cb: MovedListener): () => void;
  on(
    event: 'changed' | 'suggestions' | 'organization' | 'moved',
    cb: ChangedListener | SuggestionsListener | OrganizationListener | MovedListener,
  ): () => void {
    const sets = {
      changed: this.changedListeners,
      suggestions: this.suggestionsListeners,
      organization: this.organizationListeners,
      moved: this.movedListeners,
    };
    const set = sets[event] as Set<typeof cb>;
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  /** Emits `changed`; public so the merge flow can report `merged` (09 §10.6 step 12). */
  emitChanged(reason: LibraryChangeReason, slugs: string[]): void {
    for (const cb of [...this.changedListeners]) {
      try {
        cb({ reason, slugs });
      } catch (err) {
        this.d.logger.error('library.listener-failed', { kind: 'changed' }, err);
      }
    }
  }

  /** Releases the process lock; call on `before-quit` (09 §8.4). */
  async close(): Promise<void> {
    if (this.d.ownsProcessLock) await releaseProcessLock(path.join(this.root, ELI5_DIR, LOCK_FILE), this.d.pid);
  }
}

/** Parses the `<name>--<yyyymmddThhmmss>` suffix of a trash entry. */
export function trashTime(name: string): number | undefined {
  const m = /--(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isNaN(t) ? undefined : t;
}

/** The node a write creates (09 §4.1); a patch without `change` is an `outside` change. */
function nodeRecordFor(
  id: string,
  parentId: string | null,
  createdAt: string,
  patch: DocumentPatch,
  blob: { sha256: string; bytes: number },
): VersionNodeRecord {
  const c = patch.change;
  const base: VersionNodeRecord = {
    id,
    parentId,
    createdAt,
    kind: c?.kind ?? 'outside',
    label: cleanChangeLabel(patch.label),
    topic: cleanTopic(c?.topic ?? patch.label),
    sha256: blob.sha256,
    bytes: blob.bytes,
  };
  const question = c?.question?.replace(/\s+/g, ' ').trim().slice(0, 500);
  const full: VersionNodeRecord = {
    ...base,
    ...(c?.heading ? { heading: quoteLabel(c.heading, 80) } : {}),
    ...(question ? { question } : {}),
    ...(c?.target ? { target: { ...c.target } } : {}),
    ...(c?.undoTarget ? { undoTarget: { ...c.undoTarget } } : {}),
    ...(c?.jobId ? { jobId: c.jobId } : {}),
  };
  // A malformed target must not make tree.json unreadable: drop the extras rather than the node.
  return VersionNodeRecordSchema.safeParse(full).success ? full : base;
}

async function exists(p: string): Promise<boolean> {
  return (await fsp.lstat(p).catch(() => undefined)) !== undefined;
}
