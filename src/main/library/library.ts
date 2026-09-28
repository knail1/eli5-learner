/** The Library facade (09 §9): root, catalog, meta, slugs, commit, update, reconcile, trash. */
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { log as defaultLog, type Logger } from '../security';
import { catalogFile, diffEntries, entryFromMeta, newestFirst, sanitizeMeta, uuidFrom } from './catalog';
import {
  DIR_MODE,
  TMP_MARKER,
  errnoOf,
  fsyncDir,
  isErrno,
  renameDirAtomic,
  writeFileAtomic,
  writeJsonAtomic,
} from './fs-atomic';
import { LockSet, acquireProcessLock, releaseProcessLock } from './locks';
import { catalogMigrations, compactTimestamp, metaMigrations, readVersioned } from './migrations';
import { defaultLibraryPolicy } from './policy';
import { CATALOG_SCHEMA_VERSION, CatalogFileSchema, DocumentMetaSchema, META_SCHEMA_VERSION } from './schema';
import { chooseSlug, isValidSlug } from './slug';
import {
  LibraryError,
  type CatalogEntry,
  type CatalogFile,
  type DocumentMeta,
  type Library,
  type LibraryChangeReason,
  type LibraryClock,
  type LibraryIdSource,
  type LibraryInfo,
  type LibraryPolicy,
  type LibraryRootInput,
  type MergeSuggestion,
  type ProcessProbe,
  type ReadOnlyReason,
  type SlugReservation,
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
  /** Process lock (09 §8.4). Off only in unit tests that exercise other behavior. */
  processLock?: {
    startedAt: Date;
    probe?: ProcessProbe;
    executableName?: string;
    pid?: number;
  };
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
  if (opts.processLock) {
    const res = await acquireProcessLock({
      file: path.join(root, ELI5_DIR, LOCK_FILE),
      appVersion: opts.appVersion,
      startedAt: opts.processLock.startedAt,
      pid: opts.processLock.pid,
      probe: opts.processLock.probe,
      executableName: opts.processLock.executableName,
    });
    if (!res.acquired) {
      readOnly = 'locked';
      logger.warn('library.read-only', { kind: 'locked' });
    }
  }

  const lib = new FsLibrary({
    root,
    policy,
    appVersion: opts.appVersion,
    clock,
    ids: opts.ids ?? cryptoIds,
    logger,
    devChecks: opts.devChecks ?? true,
    ownsProcessLock: opts.processLock !== undefined && readOnly === undefined,
    pid: opts.processLock?.pid ?? process.pid,
  });
  if (readOnly) lib.enterReadOnly(readOnly);
  await lib.loadCatalog();
  if (opts.reconcile ?? true) await lib.reconcile();
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

type ChangedListener = (e: { reason: LibraryChangeReason; slugs: string[] }) => void;
type SuggestionsListener = (s: MergeSuggestion[]) => void;

export class FsLibrary implements Library {
  readonly root: string;
  private readonly d: FsLibraryDeps;
  private readonly locks = new LockSet();
  private readonly reservations = new Set<string>();
  private entries = new Map<string, CatalogEntry>();
  private readOnlyReason: ReadOnlyReason | undefined;
  private readonly changedListeners = new Set<ChangedListener>();
  private readonly suggestionsListeners = new Set<SuggestionsListener>();

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

  /** The n latest-created entries (09 §9.1). */
  recents(n = 3): CatalogEntry[] {
    return this.list().slice(0, Math.max(0, n));
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
    const r = await readVersioned(file, {
      schema: DocumentMetaSchema,
      lenient: DocumentMetaSchema,
      chain: metaMigrations,
      current: META_SCHEMA_VERSION,
      allowWrite: !this.readOnly && this.hasSlug(slug),
      renameCorrupt: false,
      now: () => this.d.clock.now(),
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
  async updateDocument(
    slug: string,
    patch: { html?: string; meta: (m: DocumentMeta) => DocumentMeta },
  ): Promise<CatalogEntry> {
    this.assertWritable();
    this.docPath(slug);
    if (!this.holdsDocLock(slug)) {
      if (this.d.devChecks) throw new LibraryError('LOCK_NOT_HELD', { slug });
      return this.withDocLock(slug, () => this.updateDocument(slug, patch));
    }
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
    // index.html first, then meta.json: the meta write is the commit point (09 §10.6 step 7).
    if (patch.html !== undefined) await writeFileAtomic(this.docPath(slug, INDEX_FILE), patch.html);
    await writeJsonAtomic(this.docPath(slug, META_FILE), clean);
    const entry = await this.withCatalogLock(async () => {
      const e = entryFromMeta(clean);
      this.entries.set(e.id, e);
      await this.writeCatalog();
      return e;
    });
    this.emitChanged('updated', [slug]);
    return { ...entry };
  }

  /** 09 §9: `updateDocument(slug, {meta: m => m})`. */
  touch(slug: string): Promise<CatalogEntry> {
    return this.updateDocument(slug, { meta: (m) => m });
  }

  /**
   * Moves a document folder to `.trash/<slug>--<ts>` and drops its entry (12 §10.2 delete; the
   * merge flow reuses the move in M3). Takes the doc lock itself.
   */
  async trashDocument(slug: string): Promise<void> {
    this.assertWritable();
    const dir = path.dirname(this.docPath(slug));
    await this.withDocLock(slug, () =>
      this.withCatalogLock(async () => {
        const entry = [...this.entries.values()].find((e) => e.topicSlug === slug);
        if (!entry) throw new LibraryError('NOT_FOUND', { slug });
        await this.moveToTrash(dir, slug);
        this.entries.delete(entry.id);
        await this.writeCatalog();
      }),
    );
    this.d.logger.info('library.removed', { slug });
    this.emitChanged('removed', [slug]);
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

  /** 09 §7. Reads meta.json only; folders without valid meta are skipped and never touched. */
  async reconcile(): Promise<void> {
    const changed = await this.withCatalogLock(async () => {
      const metas = await this.scanFolders();
      const before = [...this.entries.values()];
      const after = metas.map(entryFromMeta);
      const slugs = diffEntries(before, after);
      this.entries = new Map(after.map((e) => [e.id, e]));
      if (!this.readOnly) {
        const onDisk = await fsp.stat(path.join(this.root, CATALOG_FILE)).catch(() => undefined);
        if (slugs.length > 0 || !onDisk) await this.writeCatalog();
      }
      return slugs;
    });
    if (!this.readOnly) await this.housekeeping();
    if (changed.length > 0) {
      this.d.logger.info('library.reconciled', { count: changed.length });
      this.emitChanged('reconciled', changed);
    }
  }

  private async scanFolders(): Promise<DocumentMeta[]> {
    const dirents = await fsp.readdir(this.root, { withFileTypes: true });
    const found: { meta: DocumentMeta; writable: boolean }[] = [];
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
      const r = await readVersioned(path.join(dir, META_FILE), {
        schema: DocumentMetaSchema,
        lenient: DocumentMetaSchema,
        chain: metaMigrations,
        current: META_SCHEMA_VERSION,
        allowWrite: !this.readOnly,
        renameCorrupt: false,
        now: () => this.d.clock.now(),
      });
      if (r.status === 'missing') {
        this.d.logger.debug('library.folder-skipped', { slug: d.name, kind: 'no-meta' });
        continue;
      }
      if (r.status === 'corrupt') {
        this.d.logger.warn('library.meta-invalid', { slug: d.name, kind: r.reason });
        continue;
      }
      if (r.status === 'newer') this.enterReadOnly('newer-schema');
      let meta = r.data;
      // Step 3: the folder name wins (the user may have renamed it in Finder).
      if (meta.topicSlug !== d.name) meta = { ...meta, topicSlug: d.name };
      found.push({ meta, writable: r.status === 'ok' && meta !== r.data });
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
        f.meta = { ...f.meta, id: uuidFrom(this.d.ids) };
        f.writable = true;
      }
      seen.add(f.meta.id);
    }
    if (!this.readOnly) {
      for (const f of found) {
        if (!f.writable) continue;
        await writeJsonAtomic(path.join(this.root, f.meta.topicSlug, META_FILE), f.meta).catch((err: unknown) =>
          this.d.logger.warn('library.meta-write-failed', { slug: f.meta.topicSlug, errno: errnoOf(err) }),
        );
      }
    }
    return found.map((f) => f.meta);
  }

  /** 09 §7 step 8: stale temp files and expired trash (HOOK-LIB-01 retention). */
  private async housekeeping(): Promise<void> {
    const now = this.d.clock.now().getTime();
    const dirs = [
      this.root,
      path.join(this.root, ELI5_DIR),
      ...[...this.entries.values()].map((e) => path.join(this.root, e.topicSlug)),
    ];
    let removed = 0;
    for (const dir of dirs) {
      const names = await fsp.readdir(dir).catch(() => [] as string[]);
      for (const n of names) {
        if (!n.includes(TMP_MARKER)) continue;
        const p = path.join(dir, n);
        const st = await fsp.lstat(p).catch(() => undefined);
        if (st?.isFile() && now - st.mtimeMs > TMP_MAX_AGE_MS) {
          await fsp.unlink(p).catch(() => {});
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
    await fsyncDir(this.root);
  }

  // ---- merge (09 §10): M3 ----

  /** M3 (09 §10.2). No suggestions are produced in M1. */
  runMergeCheck(_docId: string): Promise<MergeSuggestion | null> {
    return Promise.resolve(null);
  }

  suggestions(): MergeSuggestion[] {
    return [];
  }

  acceptSuggestion(id: string): Promise<{ targetSlug: string }> {
    return Promise.reject(new LibraryError('SUGGESTION_STALE', { id: id.slice(0, 64) }));
  }

  dismissSuggestion(_id: string): Promise<void> {
    return Promise.resolve();
  }

  // ---- events ----

  on(event: 'changed', cb: ChangedListener): () => void;
  on(event: 'suggestions', cb: SuggestionsListener): () => void;
  on(event: 'changed' | 'suggestions', cb: ChangedListener | SuggestionsListener): () => void {
    const set = (event === 'changed' ? this.changedListeners : this.suggestionsListeners) as Set<typeof cb>;
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  private emitChanged(reason: LibraryChangeReason, slugs: string[]): void {
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

async function exists(p: string): Promise<boolean> {
  return (await fsp.lstat(p).catch(() => undefined)) !== undefined;
}
