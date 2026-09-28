/**
 * Merge suggestions engine (09 §10.2-10.8): the post-save merge check, `.eli5/suggestions.json`,
 * the suggestion lifecycle, accept, dismiss and crash recovery. FsLibrary delegates its merge
 * methods here (`attachMerge`); `service` is the `MergeSuggestions` slot of src/main/ipc/suggestions.ts.
 *
 * Lock order (09 §8.3): doc locks → catalog lock → suggestions lock; the suggestions lock is never
 * held while a doc or catalog lock is taken.
 */
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { DocUpdatedEvent } from '../../../preload/contract';
import { tabKeyOfSectionId, weaveMergedDocument, type MergePlanner } from '../../document';
import { log as defaultLog, type Logger } from '../../security';
import { uuidFrom } from '../catalog';
import { DIR_MODE, errnoOf, writeFileAtomic, writeJsonAtomic } from '../fs-atomic';
import { ELI5_DIR, INDEX_FILE, TRASH_DIR, type FsLibrary, type MergeDelegate } from '../library';
import { LockSet } from '../locks';
import { quoteLabel } from '../prior';
import { compactTimestamp, readVersioned, suggestionsMigrations } from '../migrations';
import { RESOLVED_SUGGESTION_RETENTION_DAYS, defaultMergeEligibility } from '../policy';
import { MergeSuggestionSchema, SUGGESTIONS_SCHEMA_VERSION, SuggestionsFileSchema } from '../schema';
import {
  LibraryError,
  type CatalogEntry,
  type DocumentMeta,
  type LibraryClock,
  type LibraryIdSource,
  type MergeEligibility,
  type MergeRecord,
  type MergeSuggestion,
  type SectionId,
  type SourceRecord,
  type SuggestionsFile,
  type TabRecord,
} from '../types';
import {
  JUDGE_TIMEOUT_MS,
  K,
  MAX_REASON,
  MERGE_FAILED_MESSAGE,
  MERGE_INELIGIBLE_MESSAGE,
  MERGE_THRESHOLD,
  PREFILTER_MIN,
} from './constants';
import { LexicalScorer, type SimilarityScorer } from './similarity';

export const SUGGESTIONS_FILE = 'suggestions.json';
/** Keeps the array items this app understands; anything else becomes []. */
const knownItems = <T>(schema: z.ZodType<T>) =>
  z.unknown().transform((v): T[] =>
    Array.isArray(v)
      ? v.flatMap((x) => {
          const r = schema.safeParse(x);
          return r.success ? [r.data] : [];
        })
      : [],
  );
/**
 * A file from a newer app, read leniently in read-only mode (09 §5.3 step 3). Items this version
 * cannot parse (a new status, say) are skipped rather than failing the file, which would rename it
 * as corrupt and let this app overwrite the newer data.
 */
const NEWER_SUGGESTIONS_FILE = z
  .object({
    schemaVersion: z
      .number()
      .int()
      .transform(() => 1 as const),
    suggestions: knownItems(MergeSuggestionSchema),
    dismissedPairs: knownItems(SuggestionsFileSchema.shape.dismissedPairs.element),
  })
  .loose();
const DAY_MS = 24 * 60 * 60 * 1000;

/** 02 `matchMerge` (the section lane's shared limiter applies inside the LLM module, 06 §10 step 3). */
export type MergeJudge = (
  summary: string,
  candidates: { catalogId: string; title: string; summary: string }[],
  signal: AbortSignal,
) => Promise<{ matches: { catalogId: string; score: number; reason: string }[] }>;

/**
 * 07 §8.1 `weaveMergedDocument` bound to the `merge-weave` planner, injectable for tests (09 §13).
 * Rejects when the LLM call fails or the budget is exhausted; the documents are then left as they are.
 */
export type WeaveMerged = (input: {
  targetHtml: string;
  targetMeta: DocumentMeta;
  sourceHtml: string;
  sourceMeta: DocumentMeta;
  suggestionId: string;
  mergedAt: string;
  signal: AbortSignal;
}) => Promise<{ html: string; tabs: TabRecord[]; markerSectionIds: SectionId[]; prompt?: string }>;

export interface MergeSuggestionsOptions {
  library: FsLibrary;
  /** `tasks.matchMerge` from createPipelineDeps (02 §12). */
  judge: MergeJudge;
  /** HOOK-LIB-02: `registry.mergeEligibility()`. Default: the public `() => true`. */
  eligibility?: MergeEligibility;
  /** `tasks.weaveMerge` from createPipelineDeps (02 §12); used by the default `weaveMerged`. */
  planner?: MergePlanner;
  weaveMerged?: WeaveMerged;
  scorer?: SimilarityScorer;
  /** HOOK-LIB-01: `registry.libraryPolicy().resolvedSuggestionRetentionDays`. */
  retentionDays?: number;
  judgeTimeoutMs?: number;
  clock?: LibraryClock;
  ids?: LibraryIdSource;
  logger?: Logger;
}

type Unsub = () => void;

/** Structurally the `MergeSuggestions` IPC service (src/main/ipc/suggestions.ts). */
export interface MergeSuggestionsService {
  list(): Promise<MergeSuggestion[]>;
  accept(suggestionId: string): Promise<{ targetSlug: string }>;
  dismiss(suggestionId: string): Promise<void>;
  onChanged(cb: (suggestions: MergeSuggestion[]) => void): Unsub;
  onDocUpdated(cb: (e: DocUpdatedEvent) => void): Unsub;
}

export interface MergeSuggestionsHandle {
  /** For `m3.services.suggestions`. */
  service: MergeSuggestionsService;
  /** The post-save trigger (06 §10); also reachable as `library.runMergeCheck`. */
  runMergeCheck(docId: string): Promise<MergeSuggestion | null>;
  /** Resolves once suggestions.json is loaded and recovery (09 §10.8) ran. */
  ready: Promise<void>;
  /** Stops listening to library events. */
  dispose(): void;
}

/**
 * Builds the engine, attaches it to the library (FsLibrary.runMergeCheck and friends) and starts
 * loading and recovering `.eli5/suggestions.json`. Call after `openLibrary` (reconcile done).
 */
export function createMergeSuggestions(opts: MergeSuggestionsOptions): MergeSuggestionsHandle {
  const engine = new MergeEngine(opts);
  opts.library.attachMerge(engine);
  return {
    service: engine.service,
    runMergeCheck: (docId) => engine.runMergeCheck(docId),
    ready: engine.ready,
    dispose: () => engine.dispose(),
  };
}

const emptyFile = (): SuggestionsFile => ({ schemaVersion: 1, suggestions: [], dismissedPairs: [] });
const sortedPair = (x: string, y: string): { a: string; b: string } => (x < y ? { a: x, b: y } : { a: y, b: x });
const isOpen = (s: MergeSuggestion): boolean => s.status === 'pending' || s.status === 'accepting';
const newestFirst = (list: MergeSuggestion[]): MergeSuggestion[] =>
  [...list].sort((x, y) => (x.createdAt === y.createdAt ? 0 : x.createdAt < y.createdAt ? 1 : -1));
const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const involves = (s: MergeSuggestion, id: string): boolean => s.source.id === id || s.target.id === id;

class MergeEngine implements MergeDelegate {
  readonly ready: Promise<void>;
  readonly service: MergeSuggestionsService;
  private readonly lib: FsLibrary;
  private readonly judge: MergeJudge;
  private readonly eligibility: MergeEligibility;
  private readonly weaveMerged: WeaveMerged;
  /** Aborted on dispose so an accept waiting on the model releases its document locks. */
  private readonly disposed = new AbortController();
  private readonly scorer: SimilarityScorer;
  private readonly retentionDays: number;
  private readonly judgeTimeoutMs: number;
  private readonly clock: LibraryClock;
  private readonly newId: () => string;
  private readonly log: Logger;
  private readonly locks = new LockSet();
  private file: SuggestionsFile = emptyFile();
  /** False until suggestions.json was read; nothing is written before that (never clobber it). */
  private loaded = false;
  private reloading: Promise<void> | undefined;
  private readonly changedCbs = new Set<(s: MergeSuggestion[]) => void>();
  private readonly docUpdatedCbs = new Set<(e: DocUpdatedEvent) => void>();
  private readonly unsubLibrary: Unsub;

  constructor(o: MergeSuggestionsOptions) {
    this.lib = o.library;
    this.judge = o.judge;
    this.eligibility = o.eligibility ?? defaultMergeEligibility;
    const planner = o.planner;
    this.weaveMerged =
      o.weaveMerged ??
      ((input) =>
        planner ? weaveMergedDocument(input, planner) : Promise.reject(new Error('No merge planner is configured')));
    this.scorer = o.scorer ?? new LexicalScorer();
    this.retentionDays = o.retentionDays ?? RESOLVED_SUGGESTION_RETENTION_DAYS;
    this.judgeTimeoutMs = o.judgeTimeoutMs ?? JUDGE_TIMEOUT_MS;
    this.clock = o.clock ?? { now: () => new Date() };
    const ids = o.ids;
    this.newId = ids ? () => uuidFrom(ids) : () => randomUUID();
    this.log = o.logger ?? defaultLog;
    this.service = {
      list: async () => {
        await this.ensureLoaded();
        return this.openList();
      },
      accept: (id) => this.accept(id),
      dismiss: (id) => this.dismiss(id),
      onChanged: (cb) => this.subscribe(this.changedCbs, cb),
      onDocUpdated: (cb) => this.subscribe(this.docUpdatedCbs, cb),
    };
    this.ready = this.initLogged();
    // Suggestions go stale when a document leaves the Library (09 §12).
    this.unsubLibrary = this.lib.on('changed', (e) => {
      if (e.reason === 'removed' || e.reason === 'reconciled') void this.validate().catch(() => {});
    });
  }

  private initLogged(): Promise<void> {
    return this.init().catch((err: unknown) => {
      this.log.error('merge.init-failed', { errno: errnoOf(err) }, err);
    });
  }

  /** Waits for startup; if suggestions.json could not be read (an I/O error), tries again. */
  private async ensureLoaded(): Promise<boolean> {
    await this.ready;
    if (!this.loaded) {
      this.reloading ??= this.initLogged().finally(() => (this.reloading = undefined));
      await this.reloading;
    }
    return this.loaded;
  }

  dispose(): void {
    this.disposed.abort();
    this.unsubLibrary();
  }

  private subscribe<T>(set: Set<(x: T) => void>, cb: (x: T) => void): Unsub {
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  // ---- lists and events ----

  /** `eli5:suggestions:list`: pending and accepting, newest first (09 §11). */
  private openList(): MergeSuggestion[] {
    return newestFirst(this.file.suggestions.filter(isOpen)).map((s) => ({ ...s }));
  }

  /** Library API `suggestions()`: pending only (09 §9). */
  pending(): MergeSuggestion[] {
    return newestFirst(this.file.suggestions.filter((s) => s.status === 'pending')).map((s) => ({ ...s }));
  }

  private emit(): void {
    const list = this.openList();
    for (const cb of [...this.changedCbs]) {
      try {
        cb(list.map((s) => ({ ...s })));
      } catch (err) {
        this.log.error('merge.listener-failed', { kind: 'suggestions' }, err);
      }
    }
    this.lib.emitSuggestions(this.pending());
  }

  private emitDocUpdated(e: DocUpdatedEvent): void {
    for (const cb of [...this.docUpdatedCbs]) {
      try {
        cb({ ...e });
      } catch (err) {
        this.log.error('merge.listener-failed', { kind: 'doc-updated' }, err);
      }
    }
  }

  // ---- persistence (09 §10.5) ----

  private get filePath(): string {
    return path.join(this.lib.root, ELI5_DIR, SUGGESTIONS_FILE);
  }

  private withSuggestionsLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.locks.with('suggestions', fn);
  }

  private async load(): Promise<void> {
    const r = await readVersioned<SuggestionsFile>(this.filePath, {
      schema: SuggestionsFileSchema,
      lenient: NEWER_SUGGESTIONS_FILE,
      chain: suggestionsMigrations,
      current: SUGGESTIONS_SCHEMA_VERSION,
      allowWrite: !this.lib.readOnly,
      renameCorrupt: true,
      now: () => this.clock.now(),
    });
    this.loaded = true;
    switch (r.status) {
      case 'ok':
        this.file = r.data;
        return;
      case 'newer':
        this.file = r.data;
        this.lib.enterReadOnly('newer-schema');
        return;
      case 'missing':
        this.file = emptyFile();
        return;
      case 'corrupt':
        // 09 §5.3 step 6: suggestions.json starts empty.
        this.log.warn('merge.suggestions-invalid', { kind: r.reason });
        this.file = emptyFile();
        return;
    }
  }

  /** Prunes, then writes atomically. Nothing is written in read-only mode. */
  private async persist(): Promise<void> {
    if (!this.loaded) return;
    this.prune();
    if (this.lib.readOnly) return;
    await writeJsonAtomic(this.filePath, this.file);
  }

  /** 09 §10.5: resolved suggestions after the retention period; pairs whose documents left. */
  private prune(): void {
    const cutoff = this.clock.now().getTime() - this.retentionDays * DAY_MS;
    this.file.suggestions = this.file.suggestions.filter((s) => {
      if (isOpen(s)) return true;
      const at = Date.parse(s.resolvedAt ?? s.createdAt);
      return Number.isNaN(at) || at >= cutoff;
    });
    const known = new Set(this.lib.list().map((e) => e.id));
    this.file.dismissedPairs = this.file.dismissedPairs.filter((p) => known.has(p.a) && known.has(p.b));
  }

  // ---- startup (09 §10.8) ----

  private async init(): Promise<void> {
    await this.withSuggestionsLock(() => this.load());
    const accepting = this.file.suggestions.filter((s) => s.status === 'accepting');
    for (const s of accepting) await this.recoverAccepting(s);
    await this.withSuggestionsLock(async () => {
      this.markMissingStale();
      if (!this.lib.readOnly) await this.persist();
    });
    this.emit();
  }

  /** Step 2: finish a committed accept idempotently, or roll an uncommitted one back to pending. */
  private async recoverAccepting(s: MergeSuggestion): Promise<void> {
    if (this.lib.readOnly) return;
    let committed: DocumentMeta | undefined;
    if (this.lib.getEntry(s.target.id)) {
      const meta = await this.lib.getMeta(s.target.slug).catch(() => undefined);
      if (meta?.merges.some((m) => m.suggestionId === s.id)) committed = meta;
    }
    if (!committed) {
      // A crash between the index.html and meta.json writes of step 7 left merged HTML behind.
      if (this.lib.getEntry(s.target.id)) {
        await this.lib
          .withDocLock(s.target.slug, () => this.restoreFromPremergeBackup(s.target.slug))
          .catch((err: unknown) => this.log.error('merge.restore-failed', { slug: s.target.slug }, err));
      }
      await this.withSuggestionsLock(async () => {
        this.setStatus(s.id, 'pending');
        await this.persist();
      });
      this.log.info('merge.recovered', { status: 'pending' });
      return;
    }
    const target = committed;
    try {
      await this.lib.withDocLocks([s.target.slug, s.source.slug], async () => {
        await this.trashSourceFolder(s);
        await this.lib.applyMergeToCatalog(target, s.source.id);
      });
      await this.withSuggestionsLock(async () => {
        this.resolveAccepted(s);
        await this.persist();
      });
      this.log.info('merge.recovered', { status: 'accepted' });
      this.lib.emitChanged('merged', [s.target.slug, s.source.slug]);
    } catch (err) {
      this.log.error('merge.recover-failed', { errno: errnoOf(err) }, err);
    }
  }

  /**
   * Puts back the newest `.trash/<slug>--<ts>-premerge/index.html` whose meta.json still equals the
   * live one: the meta.json write never happened, so the live index.html must be the pre-merge one.
   */
  private async restoreFromPremergeBackup(slug: string): Promise<void> {
    const trash = path.join(this.lib.root, TRASH_DIR);
    const names = await fsp.readdir(trash).catch(() => [] as string[]);
    const liveMeta = await fsp.readFile(this.lib.docPath(slug, 'meta.json'));
    const backups = names.filter((n) => n.startsWith(`${slug}--`) && /-premerge(-\d+)?$/.test(n)).sort();
    for (const name of backups.reverse()) {
      const meta = await fsp.readFile(path.join(trash, name, 'meta.json')).catch(() => undefined);
      if (!meta?.equals(liveMeta)) continue;
      await this.restoreIndex(path.join(trash, name), slug);
      return;
    }
  }

  /** Step 8 of accept; skips a folder that is already gone or no longer the source document. */
  private async trashSourceFolder(s: MergeSuggestion): Promise<void> {
    const dir = path.dirname(this.lib.docPath(s.source.slug));
    const meta = await this.lib.getMeta(s.source.slug).catch(() => undefined);
    if (!meta || meta.id !== s.source.id) return;
    const dest = await this.lib.moveToTrash(dir, s.source.slug);
    // Listed in the Trash as merged into the target, restorable with Put Back (09 §4.2).
    await this.lib
      .noteMergedAway(path.basename(dest), s.source.id, s.target.title)
      .catch((err: unknown) => this.log.warn('merge.trash-note-failed', { errno: errnoOf(err) }));
  }

  /** 09 §10.8 step 1 / §12: a pending suggestion whose document left the catalog is stale. */
  private markMissingStale(): boolean {
    let changed = false;
    const now = this.clock.now().toISOString();
    for (const s of this.file.suggestions) {
      if (s.status !== 'pending') continue;
      if (!this.lib.getEntry(s.source.id) || !this.lib.getEntry(s.target.id)) {
        s.status = 'stale';
        s.resolvedAt = now;
        changed = true;
      }
    }
    return changed;
  }

  /** Re-checks pending suggestions after a removal or reconcile. */
  private async validate(): Promise<void> {
    if (!(await this.ensureLoaded())) return;
    const changed = await this.withSuggestionsLock(async () => {
      const c = this.markMissingStale();
      if (c) await this.persist();
      return c;
    });
    if (changed) this.emit();
  }

  private setStatus(id: string, status: MergeSuggestion['status'], lastError?: string): void {
    const s = this.file.suggestions.find((x) => x.id === id);
    if (!s) return;
    s.status = status;
    if (lastError === undefined) delete s.lastError;
    else s.lastError = lastError;
    if (status === 'pending' || status === 'accepting') delete s.resolvedAt;
    else s.resolvedAt = this.clock.now().toISOString();
  }

  /** Step 10: accepted; any other pending suggestion referencing the source is stale. */
  private resolveAccepted(s: MergeSuggestion): void {
    this.setStatus(s.id, 'accepted');
    const now = this.clock.now().toISOString();
    for (const o of this.file.suggestions) {
      if (o.id !== s.id && o.status === 'pending' && involves(o, s.source.id)) {
        o.status = 'stale';
        o.resolvedAt = now;
      }
    }
  }

  // ---- merge check (09 §10.1-10.2) ----

  async runMergeCheck(docId: string): Promise<MergeSuggestion | null> {
    try {
      return await this.check(docId);
    } catch (err) {
      // 06 §10 step 4: logged and swallowed; the job is already done.
      this.log.warn('merge.check-failed', { errno: errnoOf(err) });
      return null;
    }
  }

  private async check(docId: string): Promise<MergeSuggestion | null> {
    if (!(await this.ensureLoaded())) return null;
    // Step 1.
    if (this.lib.readOnly) return null;
    const newEntry = this.lib.getEntry(docId);
    if (!newEntry) return null;
    if (this.file.suggestions.some((s) => s.source.id === newEntry.id && isOpen(s))) return null;

    // Step 2.
    const dismissed = new Set(this.file.dismissedPairs.map((p) => `${p.a}\0${p.b}`));
    const busy = new Set<string>();
    for (const s of this.file.suggestions)
      if (s.status === 'accepting') {
        busy.add(s.source.id);
        busy.add(s.target.id);
      }
    if (busy.has(newEntry.id)) return null;
    const corpus = this.lib.list().filter((e) => {
      if (e.id === newEntry.id || busy.has(e.id)) return false;
      const p = sortedPair(newEntry.id, e.id);
      return !dismissed.has(`${p.a}\0${p.b}`);
    });
    if (corpus.length === 0) return null;

    // Step 3: prefilter, then HOOK-LIB-02 over the top K only (meta.json, never index.html).
    const scored = await this.scorer.score({ title: newEntry.title, summary: newEntry.summary }, corpus);
    const byId = new Map(corpus.map((e) => [e.id, e]));
    const top = scored
      .filter((x) => x.score >= PREFILTER_MIN && byId.has(x.id))
      .slice(0, K)
      .map((x) => byId.get(x.id) as CatalogEntry);
    const candidates = await this.eligible(newEntry, top);
    // Step 4.
    if (candidates.length === 0) return null;

    // Step 5: the judge, temperature 0 by prompt policy, with a timeout.
    let draft: Awaited<ReturnType<MergeJudge>>;
    try {
      draft = await this.callJudge(
        `${newEntry.title}: ${newEntry.summary}`,
        candidates.map((c) => ({ catalogId: c.id, title: c.title, summary: c.summary })),
      );
    } catch (err) {
      // No suggestion and no lexical-only fallback (09 §10.2 failure handling).
      const kind = (err as { kind?: unknown }).kind;
      this.log.warn('merge.judge-failed', { errorKind: typeof kind === 'string' ? kind : 'error' });
      return null;
    }

    // Steps 6-7.
    const known = new Map(candidates.map((c) => [c.id, c]));
    let best: { entry: CatalogEntry; score: number; reason: string } | undefined;
    for (const m of draft.matches ?? []) {
      const entry = known.get(m.catalogId);
      if (!entry) continue;
      const score = clamp01(m.score);
      if (score < MERGE_THRESHOLD) continue;
      if (!best || score > best.score || (score === best.score && entry.createdAt > best.entry.createdAt)) {
        best = { entry, score, reason: typeof m.reason === 'string' ? m.reason : '' };
      }
    }
    if (!best) return null;
    const pick = best;

    // Step 8: re-check under the suggestions lock, then persist and emit.
    const created = await this.withSuggestionsLock(async () => {
      const source = this.lib.getEntry(newEntry.id);
      const target = this.lib.getEntry(pick.entry.id);
      if (!source || !target || this.lib.readOnly) return null;
      const p = sortedPair(source.id, target.id);
      if (this.file.dismissedPairs.some((d) => d.a === p.a && d.b === p.b)) return null;
      const dup = this.file.suggestions.some(
        (s) => isOpen(s) && (s.source.id === source.id || (involves(s, source.id) && involves(s, target.id))),
      );
      if (dup) return null;
      const s: MergeSuggestion = {
        id: this.newId(),
        createdAt: this.clock.now().toISOString(),
        status: 'pending',
        source: { id: source.id, slug: source.topicSlug, title: source.title },
        target: { id: target.id, slug: target.topicSlug, title: target.title },
        score: pick.score,
        reason: pick.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON),
        scorer: this.scorer.id === 'embedding' ? 'embedding+llm' : 'lexical+llm',
      };
      this.file.suggestions.push(s);
      await this.persist();
      return s;
    });
    if (!created) return null;
    this.log.info('merge.suggested', { slug: created.source.slug });
    this.emit();
    return { ...created };
  }

  /** HOOK-LIB-02 at match time (09 §10.2 step 2). Unreadable meta drops the candidate. */
  private async eligible(newEntry: CatalogEntry, top: CatalogEntry[]): Promise<CatalogEntry[]> {
    if (top.length === 0) return [];
    const a = await this.lib.getMeta(newEntry.topicSlug).catch(() => undefined);
    if (!a) return [];
    const out: CatalogEntry[] = [];
    for (const c of top) {
      const b = await this.lib.getMeta(c.topicSlug).catch(() => undefined);
      if (b && this.isEligible(a, b)) out.push(c);
    }
    return out;
  }

  private isEligible(a: DocumentMeta, b: DocumentMeta): boolean {
    try {
      return this.eligibility(a, b) === true;
    } catch {
      return false;
    }
  }

  private callJudge(
    summary: string,
    candidates: { catalogId: string; title: string; summary: string }[],
  ): ReturnType<MergeJudge> {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(Object.assign(new Error('merge judge timed out'), { kind: 'timeout' }));
      }, this.judgeTimeoutMs);
    });
    return Promise.race([this.judge(summary, candidates, ac.signal), timeout]).finally(() => clearTimeout(timer));
  }

  // ---- accept (09 §10.6) ----

  async accept(id: string): Promise<{ targetSlug: string }> {
    await this.assertLoaded();
    this.assertWritable();
    // Step 1.
    const s = await this.withSuggestionsLock(async () => {
      const found = this.file.suggestions.find((x) => x.id === id);
      if (!found || found.status !== 'pending') throw new LibraryError('SUGGESTION_STALE', {});
      this.setStatus(id, 'accepting');
      await this.persist();
      return { ...found };
    });
    this.emit();

    let result: AcceptResult;
    try {
      // Step 2: waits for any section job on either document (08).
      result = await this.lib.withDocLocks([s.target.slug, s.source.slug], () => this.acceptLocked(s));
    } catch (err) {
      const e = err instanceof AcceptOutcome ? err : undefined;
      await this.withSuggestionsLock(async () => {
        if (e?.status === 'stale') this.setStatus(id, 'stale');
        else if (e?.status === 'committed') {
          // Past the commit point: steps 8-10 finish on the next start (09 §10.8).
        } else if (this.lib.readOnly) this.setStatus(id, 'pending');
        else this.setStatus(id, 'pending', e?.lastError ?? MERGE_FAILED_MESSAGE);
        await this.persist();
      });
      if (e?.status === 'committed') {
        // Past the commit point: retry steps 8-10 now rather than only on the next start (09 §10.8).
        this.log.error('merge.finish-failed', { errno: errnoOf(e.cause) }, e.cause);
        await this.recoverAccepting(s);
        const done = this.file.suggestions.find((x) => x.id === id)?.status === 'accepted';
        if (!done) this.lib.emitChanged('updated', [s.target.slug]);
        this.emit();
        this.emitMerged(s.target.slug, e.markerId);
        return { targetSlug: s.target.slug };
      }
      this.emit();
      if (!e) this.log.warn('merge.accept-failed', { errno: errnoOf(err) });
      if (err instanceof LibraryError && err.code === 'LIBRARY_READ_ONLY') throw err;
      throw new LibraryError(e?.status === 'stale' ? 'SUGGESTION_STALE' : 'MERGE_FAILED', {});
    }

    // Step 10.
    await this.withSuggestionsLock(async () => {
      this.resolveAccepted(s);
      await this.persist();
    });
    // Step 12.
    this.log.info('merge.accepted', { slug: s.target.slug });
    this.lib.emitChanged('merged', [s.target.slug, s.source.slug]);
    this.emit();
    this.emitMerged(s.target.slug, result.markerId);
    return { targetSlug: result.targetSlug };
  }

  /** Step 12 `eli5:doc:updated`: the marker's own tab (the in-depth one when it has no marker). */
  private emitMerged(slug: string, markerId: SectionId | undefined): void {
    this.emitDocUpdated(
      markerId ? { slug, tabKey: tabKeyOfSectionId(markerId), sectionId: markerId } : { slug, tabKey: 'indepth' },
    );
  }

  /** Steps 3-9 under both doc locks. */
  private async acceptLocked(s: MergeSuggestion): Promise<AcceptResult> {
    this.assertWritable();
    // Step 3.
    const targetEntry = this.lib.getEntry(s.target.id);
    const sourceEntry = this.lib.getEntry(s.source.id);
    if (
      !targetEntry ||
      !sourceEntry ||
      targetEntry.topicSlug !== s.target.slug ||
      sourceEntry.topicSlug !== s.source.slug
    ) {
      throw new AcceptOutcome('stale');
    }
    let targetMeta: DocumentMeta;
    let sourceMeta: DocumentMeta;
    let targetHtml: string;
    let sourceHtml: string;
    try {
      targetMeta = await this.lib.getMeta(s.target.slug);
      sourceMeta = await this.lib.getMeta(s.source.slug);
    } catch (err) {
      throw new AcceptOutcome('failed', MERGE_FAILED_MESSAGE, err);
    }
    if (!this.isEligible(targetMeta, sourceMeta)) throw new AcceptOutcome('failed', MERGE_INELIGIBLE_MESSAGE);
    // Step 4.
    try {
      targetHtml = await fsp.readFile(this.lib.docPath(s.target.slug, INDEX_FILE), 'utf8');
      sourceHtml = await fsp.readFile(this.lib.docPath(s.source.slug, INDEX_FILE), 'utf8');
    } catch (err) {
      throw new AcceptOutcome('failed', MERGE_FAILED_MESSAGE, err);
    }
    // Step 5: the woven merge (one LLM call). Any failure leaves both documents untouched; there
    // is no fallback to appending.
    const mergedAt = this.clock.now().toISOString();
    let merged: Awaited<ReturnType<WeaveMerged>>;
    try {
      merged = await this.weaveMerged({
        targetHtml,
        targetMeta,
        sourceHtml,
        sourceMeta,
        suggestionId: s.id,
        mergedAt,
        signal: this.disposed.signal,
      });
    } catch (err) {
      const kind = (err as { kind?: unknown }).kind;
      this.log.warn('merge.weave-failed', { errorKind: typeof kind === 'string' ? kind : 'error' });
      throw new AcceptOutcome('failed', MERGE_FAILED_MESSAGE, err);
    }
    // Step 6.
    let backup: string;
    try {
      backup = await this.backupTarget(s.target.slug);
    } catch (err) {
      throw new AcceptOutcome('failed', MERGE_FAILED_MESSAGE, err);
    }
    // Step 7: index.html, then meta.json (the commit point).
    const record: MergeRecord = {
      suggestionId: s.id,
      sourceDocId: sourceMeta.id,
      sourceTitle: sourceMeta.title,
      sourceSlug: sourceMeta.topicSlug,
      sourceSummary: sourceMeta.summary,
      mergedAt,
      anchorSectionIds: merged.markerSectionIds,
    };
    let committed: DocumentMeta;
    try {
      committed = await this.lib.writeDocumentFiles(s.target.slug, {
        html: merged.html,
        // 09 §4.1: the pre-merge target becomes the prior version; Undo names the merge.
        label: `merged '${quoteLabel(sourceMeta.title)}' in`,
        meta: (m) => ({
          ...m,
          tabs: merged.tabs,
          generation: {
            ...m.generation,
            prompts:
              merged.prompt && !m.generation.prompts.includes(merged.prompt)
                ? [...m.generation.prompts, merged.prompt]
                : m.generation.prompts,
          },
          sourcesUsed: unionSources(m.sourcesUsed, sourceMeta.sourcesUsed, `merge:${sourceMeta.id}`),
          sourcesSkipped: unionBy(m.sourcesSkipped, sourceMeta.sourcesSkipped, (x) => `${x.ref}\0${x.code}`),
          merges: [...m.merges, record],
        }),
      });
    } catch (err) {
      // Not committed: put the pre-merge index.html back if it was already replaced.
      await this.restoreIndex(backup, s.target.slug);
      throw new AcceptOutcome('failed', MERGE_FAILED_MESSAGE, err);
    }
    // Steps 8-9.
    const markerId = merged.markerSectionIds[0];
    try {
      await this.trashSourceFolder(s);
      await this.lib.applyMergeToCatalog(committed, s.source.id);
    } catch (err) {
      throw new AcceptOutcome('committed', undefined, err, markerId);
    }
    return { targetSlug: s.target.slug, ...(markerId ? { markerId } : {}) };
  }

  /** Step 6: `.trash/<slug>--<ts>-premerge/` with the target's index.html and meta.json. */
  private async backupTarget(slug: string): Promise<string> {
    const base = path.join(this.lib.root, TRASH_DIR, `${slug}--${compactTimestamp(this.clock.now())}-premerge`);
    let dir = base;
    for (let n = 2; await exists(dir); n++) dir = `${base}-${n}`;
    await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });
    for (const f of ['index.html', 'meta.json'] as const)
      await fsp.copyFile(this.lib.docPath(slug, f), path.join(dir, f));
    return dir;
  }

  private async restoreIndex(backup: string, slug: string): Promise<void> {
    try {
      const html = await fsp.readFile(path.join(backup, INDEX_FILE));
      const live = await fsp.readFile(this.lib.docPath(slug, INDEX_FILE));
      if (!html.equals(live)) await writeFileAtomic(this.lib.docPath(slug, INDEX_FILE), html);
    } catch (err) {
      this.log.error('merge.restore-failed', { slug }, err);
    }
  }

  // ---- dismiss (09 §10.7) ----

  async dismiss(id: string): Promise<void> {
    await this.assertLoaded();
    this.assertWritable();
    await this.withSuggestionsLock(async () => {
      const s = this.file.suggestions.find((x) => x.id === id);
      if (!s || s.status !== 'pending') return;
      this.setStatus(id, 'dismissed');
      const p = sortedPair(s.source.id, s.target.id);
      if (!this.file.dismissedPairs.some((d) => d.a === p.a && d.b === p.b)) {
        this.file.dismissedPairs.push({ ...p, at: this.clock.now().toISOString() });
      }
      await this.persist();
    });
    this.emit();
  }

  private async assertLoaded(): Promise<void> {
    if (!(await this.ensureLoaded())) throw new LibraryError('MERGE_FAILED', {});
  }

  private assertWritable(): void {
    if (this.lib.readOnly) throw new LibraryError('LIBRARY_READ_ONLY', {});
  }
}

type AcceptResult = { targetSlug: string; markerId?: SectionId };

/** Why an accept stopped (09 §10.6 steps 3, 11). */
class AcceptOutcome extends Error {
  constructor(
    readonly status: 'stale' | 'failed' | 'committed',
    readonly lastError?: string,
    override readonly cause?: unknown,
    readonly markerId?: SectionId,
  ) {
    super(status);
    this.name = 'AcceptOutcome';
  }
}

async function exists(p: string): Promise<boolean> {
  return fsp.lstat(p).then(
    () => true,
    () => false,
  );
}

function unionBy<T>(base: readonly T[], extra: readonly T[], key: (x: T) => string): T[] {
  const seen = new Set(base.map(key));
  const out = [...base];
  for (const x of extra) {
    const k = key(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/** 09 §10.6 step 7: dedup by ref + sha256; incoming items are tagged with their merge origin. */
function unionSources(base: readonly SourceRecord[], extra: readonly SourceRecord[], origin: string): SourceRecord[] {
  return unionBy(
    base,
    extra.map((x) => ({ ...x, origin: x.origin ?? origin })),
    (x) => `${x.ref}\0${x.sha256 ?? ''}`,
  );
}
