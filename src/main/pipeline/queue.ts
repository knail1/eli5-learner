// JobQueue (06 §4, §5.1, §7.3, §8, §9.4, §9.5): lanes, slots, stage runner, cancel/retry/dismiss,
// crash recovery and retention. Every transition is persisted before its event is emitted (06 §3.2).
import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { monotonicFactory } from 'ulid';
import { isValidSlug, STAGING_DIR } from '../library';
import { log as defaultLog } from '../security';
import { PipelineFailure, PipelineRequestError, failureFromError } from './errors';
import { dedupeInputs, runPendingCopy, snapshotInputs, type PendingCopy } from './inputs';
import { createJob, isRetryable, isTerminal, snapshotOf } from './job';
import { checkpointOf, resetToReading, stageIndex, type StageContext } from './stages/context';
import { extractStage } from './stages/extract';
import { GEN, generateStage } from './stages/generate';
import { readStage, resolvedArtifactsExist } from './stages/read';
import { libraryStagingDir, rebuildCommitted, saveStage, upsertRebuildSidecar } from './stages/save';
import { assertTransition } from './status';
import { JobStore } from './store';
import type {
  Job,
  JobDeps,
  JobDoneEvent,
  JobFailure,
  JobId,
  JobKind,
  JobOrigin,
  JobSnapshot,
  JobStatus,
  JobStep,
  PipelineDeps,
  RebuildTarget,
  SectionJobPayload,
  SourceInput,
  StartFromMainOptions,
  StartJobRequest,
} from './types';
import type { SlugReservation } from '../library';

/** A `done` line is listed for 10 minutes unless dismissed (06 §6). */
export const DONE_LINE_MS = 10 * 60 * 1000;
/** 06 §9.4 step 3: more attempts than this after crashes fail the job. */
export const MAX_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Running {
  controller: AbortController;
  runningSteps: JobStep[];
  commitStarted: boolean;
  reservation?: SlugReservation;
  stageStartedAt: number;
}

type ChangedListener = (s: JobSnapshot) => void;
type DoneListener = (e: JobDoneEvent) => void;

function withDefaults(d: PipelineDeps): JobDeps {
  const ulid = monotonicFactory();
  const { clock, log, sleep, ids, ...rest } = d;
  return {
    ...rest,
    clock: clock ?? { now: () => new Date() },
    log: log ?? defaultLog,
    sleep: sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    ids: {
      jobId: ids?.jobId ?? ((now) => ulid(now.getTime())),
      docId: ids?.docId ?? (() => randomUUID()),
    },
  };
}

export class JobQueue {
  readonly store: JobStore;
  private readonly d: JobDeps;
  private readonly jobs = new Map<JobId, Job>();
  private readonly lanes: Record<JobKind, JobId[]> = { create: [], section: [] };
  private readonly running = new Map<JobId, Running>();
  private readonly runs = new Map<JobId, Promise<void>>();
  /** Background snapshot copies per job; reading waits for them (06 §9.2). */
  private readonly copies = new Map<JobId, Promise<void>>();
  private readonly changed = new Set<ChangedListener>();
  private readonly doneListeners = new Set<DoneListener>();
  private readonly lastLine = new Map<JobId, string>();
  private powerId: number | undefined;
  private closed = false;
  private warnedClamp = false;

  constructor(deps: PipelineDeps) {
    this.d = withDefaults(deps);
    this.store = new JobStore(path.join(deps.userData, 'jobs'), {
      clock: this.d.clock,
      log: this.d.log,
      ...(deps.progressDebounceMs !== undefined ? { debounceMs: deps.progressDebounceMs } : {}),
    });
  }

  // ---- events ----

  on(event: 'changed', cb: ChangedListener): () => void;
  on(event: 'done', cb: DoneListener): () => void;
  on(event: 'changed' | 'done', cb: ChangedListener | DoneListener): () => void {
    const set = (event === 'changed' ? this.changed : this.doneListeners) as Set<typeof cb>;
    set.add(cb);
    return () => set.delete(cb);
  }

  private snapshot(job: Job): JobSnapshot {
    const rt = this.running.get(job.id);
    return snapshotOf(job, {
      ...(job.status === 'queued' ? { queuePosition: this.position(job), queueSlots: this.slotsFor(job.kind) } : {}),
      ...(rt ? { runningSteps: rt.runningSteps, commitStarted: rt.commitStarted } : {}),
    });
  }

  private emit(job: Job): void {
    const s = this.snapshot(job);
    this.lastLine.set(job.id, s.statusLine + String(s.canCancel));
    for (const cb of this.changed) {
      try {
        cb(s);
      } catch (err) {
        this.d.log.error('pipeline.listener-failed', { jobId: job.id }, err);
      }
    }
  }

  /** Re-emits queued jobs whose line changed (queue positions, 06 §6). */
  private emitPositions(): void {
    for (const kind of ['create', 'section'] as const) {
      for (const id of this.lanes[kind]) {
        const job = this.jobs.get(id);
        if (!job) continue;
        const s = this.snapshot(job);
        if (this.lastLine.get(id) !== s.statusLine + String(s.canCancel)) this.emit(job);
      }
    }
  }

  // ---- queries ----

  get(id: JobId): Job | undefined {
    const j = this.jobs.get(id);
    return j ? structuredClone(j) : undefined;
  }

  /** `eli5:jobs:list`: non-terminal jobs plus undismissed terminal ones (done lines for 10 minutes). */
  list(): JobSnapshot[] {
    const now = this.d.clock.now().getTime();
    return [...this.jobs.values()]
      .filter((j) => {
        if (j.dismissed) return false;
        if (j.status !== 'done') return true;
        return now - Date.parse(j.finishedAt ?? j.createdAt) < DONE_LINE_MS;
      })
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((j) => this.snapshot(j));
  }

  /** Non-terminal jobs (the Tray quit label, 06 §4.3). */
  activeCount(): number {
    return [...this.jobs.values()].filter((j) => !isTerminal(j.status)).length;
  }

  /** Create-lane slots: pipeline.maxConcurrentJobs clamped to 1..policy.maxCreateSlots (06 §4.1). */
  createSlots(): number {
    const want = this.d.settings().pipeline.maxConcurrentJobs;
    const max = Math.max(1, Math.floor(this.d.policy.maxCreateSlots));
    const n = Math.min(max, Math.max(1, Math.floor(want)));
    if (n !== want && !this.warnedClamp) {
      this.warnedClamp = true;
      this.d.log.warn('pipeline.slots-clamped', { count: n });
    }
    return n;
  }

  /** Resolves when the job's current run (if any) has fully finished. */
  settled(id: JobId): Promise<void> {
    return this.runs.get(id) ?? Promise.resolve();
  }

  /** Resolves when no job is running and no snapshot copy is in flight. */
  async idle(): Promise<void> {
    while (this.runs.size || this.copies.size) await Promise.all([...this.runs.values(), ...this.copies.values()]);
  }

  private slotsFor(kind: Job['kind']): number {
    return kind === 'create' ? this.createSlots() : 1;
  }

  /**
   * Jobs that must finish before this one starts (06 §6): the waiting jobs ahead in its lane, plus
   * at least one run, or more when the lane has more running jobs than slots. With one slot this
   * is running + waiting ahead, as before.
   */
  private position(job: Job): number {
    const lane = this.lanes[job.kind];
    const i = lane.indexOf(job.id);
    if (i < 0) return 0;
    const runningInLane = [...this.running.keys()].filter((id) => this.jobs.get(id)?.kind === job.kind).length;
    const slots = this.slotsFor(job.kind);
    // A free slot is waiting for it: the next pump starts it, so it waits for nothing (plain "Queued").
    if (i < slots - runningInLane) return 0;
    return i + Math.max(1, runningInLane - slots + 1);
  }

  /**
   * pipeline.maxConcurrentJobs changed (06 §4.1): waiting jobs that now fit start at once, and
   * queue lines are re-emitted only where their text changed.
   */
  slotsChanged(): void {
    this.pump();
  }

  // ---- lifecycle ----

  /**
   * Load records, recover interrupted jobs (06 §9.4), apply retention (06 §9.5), start scheduling.
   *
   * `holdLeftovers` (the headless dev driver, design §5): leftover non-terminal jobs other than
   * rebuilds are loaded but neither recovered nor scheduled, and their records stay as they are, so
   * nothing spends outside the driver's own plan (a dry run makes no provider call at all). The next
   * normal launch recovers them as usual.
   */
  async init(opts: { holdLeftovers?: boolean } = {}): Promise<void> {
    await this.store.init();
    const all = await this.store.loadAll();
    for (const j of all) this.jobs.set(j.id, j);
    const held = opts.holdLeftovers ? all.filter((j) => !isTerminal(j.status) && !j.rebuild) : [];
    if (held.length) this.d.log.info('pipeline.leftovers-held', { count: held.length });
    const heldIds = new Set(held.map((j) => j.id));
    await this.recover(all.filter((j) => !heldIds.has(j.id)));
    await this.sweepRetention();
    this.updatePower();
    this.pump();
  }

  /**
   * Quit: stop scheduling and flush records. Running jobs keep their last checkpoint and resume on the
   * next launch (06 §4.3); nothing is failed here.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.store.flush();
    if (this.powerId !== undefined) {
      this.d.powerSave?.stop(this.powerId);
      this.powerId = undefined;
    }
  }

  // ---- requests (06 §11) ----

  /** `eli5:jobs:start` (06 §5.1). */
  start(req: StartJobRequest): Promise<{ jobId: JobId }> {
    return this.startCreate(req);
  }

  /**
   * A create job that main starts itself, not from a renderer request (16 §5.3: a job sent from the
   * phone). It skips the renderer drop-id check (06 §11) because main staged every file, and instead
   * requires each file input to sit under `opts.root`. Every input is stamped with `origin: 'inbox'`,
   * so URL fetching never applies the user-typed private-address exception (05 §4.4 rule 4).
   * Pasted-item inputs are refused: they belong to renderer drafts.
   */
  async startFromMain(req: StartJobRequest, opts: StartFromMainOptions): Promise<{ jobId: JobId }> {
    const root = path.resolve(opts.root);
    const inputs = req.inputs.map((input): SourceInput => {
      if (input.kind === 'url') return { ...input, origin: opts.origin };
      if (input.kind === 'file') {
        const rel = path.relative(root, path.resolve(input.path));
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new PipelineRequestError('E_BAD_REQUEST', 'File is outside the staging folder');
        }
        return { ...input, origin: opts.origin };
      }
      throw new PipelineRequestError('E_BAD_REQUEST', 'Pasted items cannot be started from main');
    });
    const { draftId: _draft, ...rest } = req;
    return this.startCreate({ ...rest, inputs }, { kind: opts.origin, ref: opts.ref });
  }

  /**
   * A rebuild job (design §5; the dev driver only, no UI): regenerates an existing document from
   * `req.inputs` and saves the result as a new version of `target.slug` (kind `outside`), keeping
   * its id, slug and createdAt. No merge check follows. Pasted items are refused.
   */
  async startRebuild(req: StartJobRequest, target: RebuildTarget): Promise<{ jobId: JobId }> {
    if (this.d.library.readOnly) throw new PipelineRequestError('E_LIBRARY_READ_ONLY', 'The Library is read-only');
    if (!isValidSlug(target.slug) || !this.d.library.hasSlug(target.slug)) {
      throw new PipelineRequestError('E_NOT_FOUND', 'No such document');
    }
    if (req.inputs.some((i) => i.kind !== 'file' && i.kind !== 'url')) {
      throw new PipelineRequestError('E_BAD_REQUEST', 'Pasted items cannot be rebuilt');
    }
    const { draftId: _draft, ...rest } = req;
    return this.startCreate(rest, undefined, target);
  }

  /** The newest job main started for `ref` (16 §5.3 step 2 dedupe), including dismissed ones. */
  findByOrigin(ref: string): JobSnapshot | undefined {
    let hit: Job | undefined;
    for (const j of this.jobs.values()) if (j.origin?.ref === ref && (!hit || j.id > hit.id)) hit = j;
    return hit ? this.snapshot(hit) : undefined;
  }

  /** The origin reference of a job main started itself (`startFromMain`), if any. */
  originOf(id: JobId): JobOrigin | undefined {
    const o = this.jobs.get(id)?.origin;
    return o ? { ...o } : undefined;
  }

  private async startCreate(
    req: StartJobRequest,
    origin?: JobOrigin,
    rebuild?: RebuildTarget,
  ): Promise<{ jobId: JobId }> {
    if (!req.inputs.length) throw new PipelineRequestError('E_BAD_REQUEST', 'Add at least one source');
    if (this.d.library.readOnly) throw new PipelineRequestError('E_LIBRARY_READ_ONLY', 'The Library is read-only');
    const now = this.d.clock.now();
    const id = this.d.ids.jobId(now);
    const { inputs, pending } = await snapshotInputs(dedupeInputs(req.inputs), {
      stagingDir: this.store.stagingDir(id),
      userData: this.d.userData,
      copyMaxBytes: this.d.policy.snapshotCopyMaxBytes,
      ...(this.d.copyFile ? { copyFile: this.d.copyFile } : {}),
      ...(this.d.snapshotInlineCopyMaxBytes !== undefined
        ? { inlineCopyMaxBytes: this.d.snapshotInlineCopyMaxBytes }
        : {}),
    });
    const job = createJob({ id, kind: 'create', now, inputs, options: { ...req.options } });
    if (origin) job.origin = { ...origin };
    if (rebuild) job.rebuild = { ...rebuild };
    await this.store.save(job);
    this.jobs.set(id, job);
    if (pending.length) this.startCopies(job, pending);
    this.lanes.create.push(id);
    this.d.log.info('pipeline.enqueued', { jobId: id, kind: 'create', count: inputs.length });
    this.updatePower();
    this.emit(job);
    this.pump();
    return { jobId: id };
  }

  /**
   * 06 §9.2: copies that could not be cloned run after `jobs:start` returns. Each sets `copyPath` when
   * it settles, so a failed copy is skipped by the resolver as `file changed or moved`. A crash while
   * copying leaves no `copyPath`; the resolver then checks the original's size and mtime instead.
   */
  private startCopies(job: Job, pending: readonly PendingCopy[]): void {
    const all = Promise.all(
      pending.map(async (p) => {
        const ok = await runPendingCopy(p, this.d.copyFile);
        const input = job.inputs[p.index];
        if (input?.kind === 'file' && input.snapshot) input.snapshot.copyPath = p.dst;
        if (!ok) this.d.log.warn('pipeline.snapshot-copy-failed', { jobId: job.id, index: p.index });
      }),
    )
      .then(async () => {
        if (!isTerminal(job.status)) await this.store.save(job);
      })
      .catch((err: unknown) => this.d.log.error('pipeline.snapshot-copy-failed', { jobId: job.id }, err))
      .finally(() => this.copies.delete(job.id));
    this.copies.set(job.id, all);
  }

  /** Section jobs (08) enter the Section lane (06 §8.2); started by 08's channels. */
  async enqueueSection(payload: SectionJobPayload): Promise<{ jobId: JobId }> {
    if (this.d.library.readOnly) throw new PipelineRequestError('E_LIBRARY_READ_ONLY', 'The Library is read-only');
    const now = this.d.clock.now();
    const id = this.d.ids.jobId(now);
    const job = createJob({
      id,
      kind: 'section',
      now,
      inputs: [],
      options: { clarifyingInput: '', glossary: false },
      section: payload,
    });
    await this.store.save(job);
    this.jobs.set(id, job);
    this.lanes.section.push(id);
    this.updatePower();
    this.emit(job);
    this.pump();
    return { jobId: id };
  }

  private must(id: JobId): Job {
    const j = this.jobs.get(id);
    if (!j || j.dismissed) throw new PipelineRequestError('E_NOT_FOUND', 'No such job');
    return j;
  }

  /** `eli5:jobs:cancel` (06 §8.1). */
  async cancel(id: JobId): Promise<void> {
    const job = this.must(id);
    if (isTerminal(job.status)) throw new PipelineRequestError('E_CONFLICT', 'The job has already finished');
    const rt = this.running.get(id);
    if (!rt) {
      // Queued: removed from its lane immediately.
      this.dequeue(job);
      job.cancelRequested = true;
      await this.fail(job, new PipelineFailure('CANCELLED').toFailure());
      await this.cleanupStaging(job, 'cancelled');
      this.updatePower();
      this.emitPositions();
      return;
    }
    if (rt.commitStarted) throw new PipelineRequestError('E_CONFLICT', 'The document is being saved');
    job.cancelRequested = true;
    await this.store.save(job);
    rt.controller.abort();
  }

  /** `eli5:jobs:retry` (06 §7.3). */
  async retry(id: JobId): Promise<void> {
    const job = this.must(id);
    // Design §5: a rebuild spends only inside the dev driver's guarded session; rerun the driver.
    if (job.status !== 'failed' || job.rebuild || !isRetryable(job.failure?.code)) {
      throw new PipelineRequestError('E_CONFLICT', 'This job cannot be retried');
    }
    job.attempt += 1;
    delete job.failure;
    delete job.finishedAt;
    delete job.cancelRequested;
    delete job.resuming;
    const cp = job.checkpoint;
    const hasUrl = job.inputs.some((i) => i.kind === 'url');
    // URL sources are refetched unless the generated outputs are complete (then Retry goes straight to
    // saving, §5.7); file and clipboard snapshots are reused.
    if (job.stagingPurged || !cp || (hasUrl && stageIndex(cp.stage) < stageIndex('saving'))) {
      await resetToReading(job, this.store);
      delete job.stagingPurged;
    } else {
      await this.validateCheckpoint(job);
    }
    if (job.checkpoint) delete job.checkpoint.topicSlug;
    await this.transition(job, 'queued');
    this.lanes[job.kind].push(job.id);
    this.updatePower();
    this.pump();
  }

  /** `eli5:jobs:dismiss`: hides a terminal line and frees retained staging (06 §11). */
  async dismiss(id: JobId): Promise<void> {
    const job = this.must(id);
    if (!isTerminal(job.status)) throw new PipelineRequestError('E_CONFLICT', 'The job is still running');
    job.dismissed = true;
    await this.store.removeStaging(job.id);
    if (job.status === 'failed') job.stagingPurged = true;
    await this.store.save(job);
  }

  // ---- scheduling ----

  private dequeue(job: Job): void {
    const lane = this.lanes[job.kind];
    const i = lane.indexOf(job.id);
    if (i >= 0) lane.splice(i, 1);
  }

  private pump(): void {
    if (this.closed) return;
    for (const kind of ['create', 'section'] as const) {
      const slots = this.slotsFor(kind);
      const lane = this.lanes[kind];
      while (lane.length && [...this.running.keys()].filter((id) => this.jobs.get(id)?.kind === kind).length < slots) {
        const id = lane.shift() as JobId;
        const job = this.jobs.get(id);
        if (!job || job.status !== 'queued') continue;
        this.launch(job);
      }
    }
    this.emitPositions();
  }

  private launch(job: Job): void {
    const rt: Running = {
      controller: new AbortController(),
      runningSteps: [],
      commitStarted: false,
      stageStartedAt: this.d.clock.now().getTime(),
    };
    this.running.set(job.id, rt);
    const run = this.run(job, rt)
      .catch((err: unknown) => this.d.log.error('pipeline.run-failed', { jobId: job.id }, err))
      .finally(() => {
        this.running.delete(job.id);
        this.runs.delete(job.id);
        this.updatePower();
        this.pump();
      });
    this.runs.set(job.id, run);
  }

  private stageContext(job: Job, rt: Running): StageContext {
    const ctx: StageContext = {
      job,
      signal: rt.controller.signal,
      deps: this.d,
      store: this.store,
      persist: async () => {
        await this.store.save(job);
        this.emit(job);
      },
      progress: () => {
        this.store.saveProgress(job);
        this.emit(job);
      },
      setRunningSteps: (steps) => {
        rt.runningSteps = [...steps];
        if (steps[0]) job.progress.step = steps[0];
        else delete job.progress.step;
        this.store.saveProgress(job);
        this.emit(job);
      },
      setCommitStarted: (started) => {
        rt.commitStarted = started;
        this.emit(job);
      },
      inputsReady: () => this.copies.get(job.id) ?? Promise.resolve(),
    };
    // The reservation lives on the runtime so the failure path can release it (06 §5.7 step 4).
    Object.defineProperty(ctx, 'reservation', {
      get: () => rt.reservation,
      set: (r: SlugReservation | undefined) => {
        rt.reservation = r;
      },
    });
    return ctx;
  }

  private async run(job: Job, rt: Running): Promise<void> {
    const ctx = this.stageContext(job, rt);
    try {
      delete job.resuming;
      if (job.kind === 'section') {
        await this.runSection(job, rt, ctx);
        return;
      }
      await this.transition(job, 'reading', rt);
      await readStage(ctx);
      await this.transition(job, 'extracting', rt);
      await extractStage(ctx);
      await this.transition(job, 'generating', rt);
      await generateStage(ctx);
      await this.transition(job, 'saving', rt);
      const entry = await saveStage(ctx);
      job.result = { docId: entry.id, topicSlug: entry.topicSlug, title: entry.title };
      // A rebuild replaces a version of an existing document: no merge suggestion (design §5).
      await this.finishDone(job, rt, !job.rebuild);
    } catch (err) {
      const failure = failureFromError(err, rt.controller.signal.aborted || job.cancelRequested === true);
      if (failure.code === 'INTERNAL')
        this.d.log.error('pipeline.internal', { jobId: job.id, attempt: job.attempt }, err);
      rt.reservation?.release();
      rt.reservation = undefined;
      await rm(libraryStagingDir(this.d.library.root, job.id), { recursive: true, force: true }).catch(() => {});
      if (!isTerminal(job.status)) {
        await this.fail(job, failure, rt).catch((e: unknown) =>
          this.d.log.error('pipeline.fail-failed', { jobId: job.id }, e),
        );
      }
      await this.cleanupStaging(job, failure.code === 'CANCELLED' ? 'cancelled' : 'failed');
    } finally {
      await this.d.endFetchJob?.(job.id).catch(() => {});
    }
  }

  private async runSection(job: Job, rt: Running, ctx: StageContext): Promise<void> {
    await this.transition(job, 'generating', rt);
    const runner = this.d.sectionRunner;
    if (!runner) throw new PipelineFailure('INTERNAL', 'no-section-runner');
    const out = await runner({
      job,
      signal: rt.controller.signal,
      enterSaving: () => this.transition(job, 'saving', rt),
      markCommitStarted: () => ctx.setCommitStarted(true),
    });
    if (job.status === 'generating') await this.transition(job, 'saving', rt);
    job.result = out.result;
    if (out.tabLabel) job.tabLabel = out.tabLabel;
    await this.finishDone(job, rt, false);
  }

  /** 06 §5.7 steps 5-7: done, events, staging removal, merge check (create jobs only). */
  private async finishDone(job: Job, rt: Running | undefined, mergeCheck: boolean): Promise<void> {
    await this.store.removeStaging(job.id);
    await this.transition(job, 'done', rt);
    const r = job.result;
    if (r) {
      const e: JobDoneEvent = { jobId: job.id, kind: job.kind, slug: r.topicSlug, docId: r.docId, title: r.title };
      for (const cb of this.doneListeners) {
        try {
          cb(e);
        } catch (err) {
          this.d.log.error('pipeline.listener-failed', { jobId: job.id }, err);
        }
      }
      if (mergeCheck && job.kind === 'create') this.fireMergeCheck(job.id, r.docId);
    }
  }

  /** 06 §10: detached; failures are logged and swallowed. */
  private fireMergeCheck(jobId: JobId, docId: string): void {
    const check = this.d.onMergeCheck;
    if (!check) return;
    void Promise.resolve()
      .then(() => check(docId))
      .catch((err: unknown) =>
        this.d.log.warn('pipeline.merge-check-failed', { jobId, errorKind: (err as Error | null)?.name ?? 'Error' }),
      );
  }

  private async fail(job: Job, failure: JobFailure, rt?: Running): Promise<void> {
    job.failure = failure;
    await this.transition(job, 'failed', rt);
  }

  /** CANCELLED deletes staging at once (06 §7.2); other failures keep it unless policy purges (06 §9.5). */
  private async cleanupStaging(job: Job, why: 'cancelled' | 'failed'): Promise<void> {
    const purge =
      why === 'cancelled' || job.resolved.some((r) => this.d.policy.stagingRetention?.(r) === 'purge-on-terminal');
    if (!purge) return;
    await this.store.removeStaging(job.id).catch(() => {});
    if (why === 'failed') {
      job.stagingPurged = true;
      await this.store.save(job).catch(() => {});
    }
  }

  private async transition(job: Job, to: JobStatus, rt?: Running): Promise<void> {
    const from = job.status;
    assertTransition(from, to, job.kind);
    const now = this.d.clock.now();
    const durationMs = rt ? now.getTime() - rt.stageStartedAt : 0;
    if (rt) {
      job.timings = { ...job.timings, [from]: (job.timings?.[from] ?? 0) + durationMs };
      rt.stageStartedAt = now.getTime();
      if (to !== 'generating') rt.runningSteps = [];
    }
    job.status = to;
    if (to !== 'generating') delete job.progress.step;
    if (to === 'reading' || (to === 'generating' && job.kind === 'section')) job.startedAt ??= now.toISOString();
    if (isTerminal(to)) job.finishedAt = now.toISOString();
    if (to === 'queued') delete job.finishedAt;
    await this.store.save(job);
    this.d.log.info('pipeline.transition', {
      jobId: job.id,
      attempt: job.attempt,
      from,
      to,
      durationMs,
      ...(job.failure && to === 'failed' ? { code: job.failure.code } : {}),
    });
    this.emit(job);
  }

  private updatePower(): void {
    const ps = this.d.powerSave;
    if (!ps || this.closed) return;
    const active = this.activeCount() > 0;
    if (active && this.powerId === undefined) this.powerId = ps.start();
    else if (!active && this.powerId !== undefined) {
      ps.stop(this.powerId);
      this.powerId = undefined;
    }
  }

  // ---- crash recovery (06 §9.3, §9.4) ----

  /** Moves the resume point back to the earliest stage whose artifacts are missing (06 §9.3). */
  private async validateCheckpoint(job: Job): Promise<void> {
    if (job.kind === 'section') return;
    const cp = checkpointOf(job);
    if (stageIndex(cp.stage) === 0) return;
    if (job.resolved.length === 0 || !(await resolvedArtifactsExist(job.resolved))) {
      await resetToReading(job, this.store);
      return;
    }
    const present: number[] = [];
    for (const r of job.resolved) {
      if (await this.store.readExtracted(job.id, r.id)) present.push(Number(r.id.slice(4)));
    }
    const allExtracted = present.length === job.resolved.length;
    cp.extractedIndexes = present;
    if (!allExtracted && stageIndex(cp.stage) > stageIndex('extracting')) {
      cp.stage = 'extracting';
      cp.completedSteps = [];
    }
    const has = async (rel: string): Promise<boolean> => (await this.store.readJson(job.id, rel)) !== null;
    const ok = new Set<JobStep>();
    if ((await has(GEN.prepared)) && (await has(GEN.document))) ok.add('indepth').add('eli5');
    if (ok.has('indepth') && (await has(GEN.ste))) ok.add('ste');
    if (ok.has('indepth') && (await has(GEN.eli5Critique))) ok.add('eli5-critique');
    if (ok.has('indepth') && (await has(GEN.glossary))) ok.add('glossary');
    if (ok.has('indepth') && (await has(GEN.summary))) ok.add('summary');
    cp.completedSteps = cp.completedSteps.filter((s) => ok.has(s));
    const allSteps = job.progress.stepsPlanned.every((s) => ok.has(s) && cp.completedSteps.includes(s));
    if (cp.stage === 'saving' && !allSteps) cp.stage = 'generating';
  }

  private async recover(all: readonly Job[]): Promise<void> {
    const resumed: Job[] = [];
    const waiting: Job[] = [];
    for (const job of all) {
      if (isTerminal(job.status)) continue;
      try {
        await this.recoverOne(job, resumed, waiting);
      } catch (err) {
        this.d.log.error('pipeline.recover-failed', { jobId: job.id }, err);
        if (!isTerminal(job.status)) await this.fail(job, new PipelineFailure('INTERNAL', 'recovery').toFailure());
      }
    }
    // 06 §9.4 step 4: resumed jobs go to the front of their lanes in their original order.
    for (const kind of ['create', 'section'] as const) {
      this.lanes[kind] = [
        ...resumed.filter((j) => j.kind === kind).map((j) => j.id),
        ...waiting.filter((j) => j.kind === kind).map((j) => j.id),
        ...this.lanes[kind],
      ];
    }
    // Step 5: orphaned library staging directories.
    const live = new Set([...this.jobs.values()].filter((j) => !isTerminal(j.status)).map((j) => j.id));
    const stagingRoot = path.join(this.d.library.root, STAGING_DIR);
    for (const name of await readdir(stagingRoot).catch(() => [] as string[])) {
      if (!live.has(name)) await rm(path.join(stagingRoot, name), { recursive: true, force: true }).catch(() => {});
    }
  }

  private async recoverOne(job: Job, resumed: Job[], waiting: Job[]): Promise<void> {
    // 1. A cancel that never took effect finishes as CANCELLED.
    if (job.cancelRequested) {
      await this.fail(job, new PipelineFailure('CANCELLED').toFailure());
      await this.store.removeStaging(job.id);
      return;
    }
    if (job.rebuild) {
      // Design §5: a rebuild spends on the owner's key only inside the dev driver's session (budget
      // guard, per-document gate, hard stop). A later launch never resumes one: it finishes as done
      // when its version committed, else it fails INTERRUPTED (rerun the driver to retry).
      if (job.status === 'saving' && (await this.finishInterruptedRebuild(job))) return;
      await this.fail(job, new PipelineFailure('INTERRUPTED', 'rebuild-not-resumed').toFailure());
      await this.cleanupStaging(job, 'failed');
      return;
    }
    if (job.status === 'queued' && !job.resuming) {
      waiting.push(job);
      return;
    }
    // 2. Interrupted inside the commit: the folder may already exist.
    const slug = job.checkpoint?.topicSlug;
    if (job.status === 'saving' && slug) {
      if (await this.finishInterruptedCommit(job, slug)) return;
      await rm(libraryStagingDir(this.d.library.root, job.id), { recursive: true, force: true });
      delete job.checkpoint?.topicSlug;
    }
    // 3. Policy may refuse to resume (HOOK-PIPE-01).
    if (this.d.policy.resumeAfterCrash?.(job) === false) {
      await this.fail(job, new PipelineFailure('INTERRUPTED').toFailure());
      await this.cleanupStaging(job, 'failed');
      return;
    }
    // 06 §9.4 step 3: repeated crashes on the same job stop it.
    if (job.status !== 'queued' && job.attempt + 1 > MAX_ATTEMPTS) {
      await this.fail(
        job,
        new PipelineFailure('INTERNAL', 'crash-loop', 'stopped after repeated interruptions').toFailure(),
      );
      return;
    }
    // 4. Resume from a validated checkpoint.
    await this.validateCheckpoint(job);
    if (job.status !== 'queued') {
      job.attempt += 1;
      job.resuming = true;
      await this.transition(job, 'queued');
    } else {
      this.emit(job);
    }
    resumed.push(job);
  }

  /** 06 §9.4 step 2.2: `<slug>/meta.json` with this jobId means the rename happened; finish via 09. */
  private async finishInterruptedCommit(job: Job, slug: string): Promise<boolean> {
    const lib = this.d.library;
    let metaJobId: unknown;
    try {
      metaJobId = (JSON.parse(await readFile(lib.docPath(slug, 'meta.json'), 'utf8')) as { jobId?: unknown }).jobId;
    } catch {
      return false;
    }
    if (metaJobId !== job.id) return false;
    const before = lib.getEntry(slug);
    if (!before) await lib.reconcile(); // upserts the missing catalog entry (09 §7 step 6)
    const entry = lib.getEntry(slug);
    if (!entry) return false;
    job.result = { docId: entry.id, topicSlug: entry.topicSlug, title: entry.title };
    await this.finishDone(job, undefined, !before);
    await this.d.endFetchJob?.(job.id).catch(() => {});
    return true;
  }

  /** Design §5 step 5: the current version node carries this job's id, so the rebuild committed. */
  private async finishInterruptedRebuild(job: Job): Promise<boolean> {
    const r = job.rebuild;
    if (!r) return false;
    const done = await rebuildCommitted(this.d.library, r.slug, job.id).catch(() => undefined);
    if (!done) return false;
    // 09 §4.4: the sidecar upsert the crashed save never reached (the job's extracted texts are
    // still in its staging until finishDone).
    const rt: Running = {
      controller: new AbortController(),
      runningSteps: [],
      commitStarted: false,
      stageStartedAt: this.d.clock.now().getTime(),
    };
    await upsertRebuildSidecar(this.stageContext(job, rt), r.slug);
    job.result = { docId: done.id, topicSlug: done.topicSlug, title: done.title };
    await this.finishDone(job, undefined, false);
    await this.d.endFetchJob?.(job.id).catch(() => {});
    return true;
  }

  // ---- retention (06 §9.5) ----

  async sweepRetention(): Promise<void> {
    const now = this.d.clock.now().getTime();
    const { recordDays, failedStagingDays } = this.d.policy.retention;
    for (const job of [...this.jobs.values()]) {
      if (!isTerminal(job.status)) continue;
      const age = now - Date.parse(job.finishedAt ?? job.createdAt);
      if (age > recordDays * DAY_MS) {
        await this.store.removeStaging(job.id);
        await this.store.removeRecord(job.id);
        this.jobs.delete(job.id);
        continue;
      }
      if (job.status === 'failed' && !job.stagingPurged && age > failedStagingDays * DAY_MS) {
        await this.store.removeStaging(job.id);
        job.stagingPurged = true;
        await this.store.save(job);
      }
    }
  }
}
