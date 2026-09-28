// Job model for the generation pipeline (06 §3, §9.3, HOOK-PIPE-01).
import type {
  JobFailureCode,
  JobId,
  JobKind,
  JobOptions,
  JobResultRef,
  JobSnapshot,
  JobStatus,
  SourceInput,
  StartJobRequest,
} from '../../preload/contract';
import type { Settings } from '../config';
import type {
  DocRuntime,
  DocTheme,
  DocThemeRef,
  IdSource,
  ImageNormalizer as DocImageNormalizer,
  ReferenceFormatter,
  SectionJobPayload,
} from '../document';
import type { Edition } from '../editions';
import type { ExtractLimits, ExtractResult, JobImageBudget } from '../extract';
import type { CatalogEntry, DocumentMeta, SlugReservation } from '../library';
import type { LLMErrorKind, LlmTasks } from '../llm';
import type { Logger } from '../security';
import type {
  LaneRouter,
  McpClient,
  ResolveContext,
  ResolveLimits,
  ResolvedSource,
  SkippedSource,
  SourceResolver,
} from '../sources';

export type { SectionJobPayload };

export type {
  JobFailureCode,
  JobId,
  JobKind,
  JobOptions,
  JobResultRef,
  JobSnapshot,
  JobStatus,
  SourceInput,
  StartJobRequest,
};

/** Sub-step shown while status === 'generating' (06 §3.1). */
export type JobStep = 'indepth' | 'eli5' | 'glossary' | 'summary';

export interface JobProgress {
  sourcesTotal: number;
  /** Resolved + skipped so far. */
  sourcesDone: number;
  /** Only while generating. */
  step?: JobStep;
  /** e.g. ['indepth','eli5','summary'] when glossary is off. */
  stepsPlanned: JobStep[];
}

export interface JobFailure {
  code: JobFailureCode;
  /** The user-facing text shown after "Failed: ". */
  message: string;
  /** Log-only diagnostic, never rendered (06 §13). */
  detail?: string;
}

/** Partial-failure notes, persisted into meta.json (06 §7.1). */
export interface JobWarning {
  kind: 'source-skipped' | 'glossary-omitted' | 'summary-fallback' | 'eli5-placeholder' | 'input-truncated';
  message: string;
}

/** Resume checkpoint (06 §9.3). */
export interface JobCheckpoint {
  stage: 'reading' | 'extracting' | 'generating' | 'saving';
  /** Inputs whose ResolvedSource artifact is staged. */
  resolvedRefs: string[];
  /** ExtractedContent files present in jobs/<jobId>/extracted. */
  extractedIndexes: number[];
  /** Generation outputs present in jobs/<jobId>/gen. */
  completedSteps: JobStep[];
  /** Set once saving reserved a slug. */
  topicSlug?: string;
}

export interface Job {
  id: JobId;
  kind: JobKind;
  status: JobStatus;
  /** ISO 8601. */
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Snapshotted at enqueue (06 §9.2). */
  inputs: SourceInput[];
  options: JobOptions;
  progress: JobProgress;
  resolved: ResolvedSource[];
  skipped: SkippedSource[];
  warnings: JobWarning[];
  /** 1 on first run, +1 on each crash-resume or user retry. */
  attempt: number;
  checkpoint?: JobCheckpoint;
  /** Set when done. */
  result?: JobResultRef;
  /** Set when failed. */
  failure?: JobFailure;
  cancelRequested?: boolean;
  /** Present iff kind === 'section' (08). */
  section?: SectionJobPayload;
  /** Set by crash recovery while re-queued; status line `Resuming` (06 §9.4). */
  resuming?: boolean;
  /** Per-stage timings in ms (06 §13). */
  timings?: Partial<Record<JobStatus | JobStep, number>>;
  /** The user dismissed the terminal line (06 §11 `eli5:jobs:dismiss`); hidden from list(). */
  dismissed?: boolean;
  /** Staging was deleted by retention or dismiss (06 §9.5); a Retry then starts from reading. */
  stagingPurged?: boolean;
  /** Label of the tab a section `eli5-tab` job added (06 §6 `Added tab: {label}`). */
  tabLabel?: string;
}

/** HOOK-PIPE-01 enterprise job policy (06 §9.5 hook). */
export interface PipelinePolicy {
  /** Clamp ceiling for pipeline.maxConcurrentJobs. */
  maxCreateSlots: number;
  /** Optional overrides passed into doc 02's retry.ts; absent means doc 02's defaults (02 §7). Never a second retry loop. */
  llmRetryOverride?: { maxAttempts?: Partial<Record<LLMErrorKind, number>>; baseMs?: number; maxRetryAfterMs?: number };
  llmTimeoutOverride?: { idleMs?: number; totalMs?: number };
  snapshotCopyMaxBytes: number;
  retention: { failedStagingDays: number; recordDays: number };
  /** Called for each staged artifact; enterprise may shorten retention by source lane. */
  stagingRetention?(src: ResolvedSource): 'default' | 'purge-on-terminal';
  /** Default: always true. */
  resumeAfterCrash?(job: Job): boolean;
}

/** Injected time source (13 §3.2); FakeClock in tests. */
export interface PipelineClock {
  now(): Date;
}

// ---- Dependencies (06 §2: interfaces only; production wiring in deps.ts) ----

/** One job's extraction service: the ExtractWorkerHost in production, in-process in tests (04 §10.4). */
export interface ExtractRunner {
  /** Never throws; sources of one runner may be serialized. */
  extract(
    source: ResolvedSource,
    o: { signal: AbortSignal; limits: ExtractLimits; budget: JobImageBudget },
  ): Promise<ExtractResult>;
  /** Job end: kill the worker, settle anything in flight. */
  dispose(): void;
}

/** The library calls the pipeline makes (09 §9). FsLibrary satisfies it. */
export interface PipelineLibrary {
  readonly root: string;
  readonly readOnly: boolean;
  allocateSlug(title: string, hint?: string): Promise<SlugReservation>;
  /** Takes withDocLock(slug) itself (09 §8.2); callers must not hold it. */
  commitDocument(r: SlugReservation, stagingDir: string, meta: DocumentMeta): Promise<CatalogEntry>;
  /** `<root>/.staging/<jobId>/`, created on demand. */
  stagingDir(jobId: string): Promise<string>;
  withDocLock<T>(slug: string, fn: () => Promise<T>): Promise<T>;
  docPath(slug: string, file?: 'index.html' | 'meta.json'): string;
  getEntry(idOrSlug: string): CatalogEntry | undefined;
  /** Adds catalog entries for committed folders missing from the catalog (09 §7 step 6). */
  reconcile(): Promise<void>;
}

/** Electron powerSaveBlocker, injected (06 §4.3). */
export interface PowerSaveBlocker {
  start(): number;
  stop(id: number): void;
}

/** What a section runner (08, M3) gets: the job in `generating`, its signal, and the saving transition. */
export interface SectionRunContext {
  readonly job: Job;
  readonly signal: AbortSignal;
  /** Moves the job to `saving` (the runner writes under library.withDocLock). */
  enterSaving(): Promise<void>;
  /** After this, cancel is refused (06 §8.1); call it right before the irreversible write. */
  markCommitStarted(): void;
}

/** Runs one section job's generate + save (08). Throw PipelineFailure with a section code to fail it. */
export type SectionRunner = (ctx: SectionRunContext) => Promise<{ result: JobResultRef; tabLabel?: string }>;

/** In-process `done` event (06 §5.7 step 5); bootstrap posts create-job notifications from it. */
export interface JobDoneEvent {
  jobId: JobId;
  kind: JobKind;
  slug: string;
  docId: string;
  title: string;
}

export interface JobIds {
  /** Time-sortable id (ULID) for FIFO order (06 §3.1). */
  jobId(now: Date): JobId;
  /** DocumentMeta.id / CatalogEntry.id (UUID v4). */
  docId(): string;
}

export interface PipelineDeps {
  /** Electron app.getPath('userData'); jobs live in <userData>/jobs/ (06 §9.1). */
  userData: string;
  edition: Edition;
  settings: () => Pick<Settings, 'pipeline' | 'llm'>;
  /** HOOK-PIPE-01 (registry.pipelinePolicy()). */
  policy: PipelinePolicy;
  /** registry.resolvers() in chain order (03 §4). */
  resolvers: () => readonly SourceResolver[];
  laneRouter: () => LaneRouter;
  mcp?: () => McpClient | undefined;
  resolveLimits?: ResolveLimits;
  extractLimits?: ExtractLimits;
  /** 05 fetchUrl, passed to resolvers as ResolveContext.fetchUrl. */
  fetchUrl: ResolveContext['fetchUrl'];
  /** 05 endFetchJob: drop the per-job fetch cache when a job ends. */
  endFetchJob?: (jobId: JobId) => Promise<void>;
  createExtractRunner: (jobId: JobId) => ExtractRunner;
  /** 02 §12 task functions (createTasks). */
  tasks: LlmTasks;
  /** Provider id and model for meta.generation, read when generation starts (06 §12). */
  llmInfo: () => { id: string; model: string };
  /** 06 §7.2 item 2: API key present for the selected provider, checked without a network request. */
  hasApiKey?: () => Promise<boolean>;
  library: PipelineLibrary;
  /** The resolved document theme (07 §11.3): default < skill < overlay. */
  docTheme: () => { theme: DocTheme; source: DocThemeRef['source'] };
  referenceFormatter?: ReferenceFormatter;
  /** 07 §5.6 image normalization (createNativeImageNormalizer in the app). */
  normalizeImage: DocImageNormalizer;
  /** Default: the bundled runtime (07 §2). */
  docRuntime?: DocRuntime;
  /** SectionId randomness (07 §4.2); SeededIdSource in tests. */
  sectionIds?: IdSource;
  /** Section lane executor (08, M3). Absent: section jobs fail INTERNAL. */
  sectionRunner?: SectionRunner;
  /** Post-save merge check (06 §10): library.runMergeCheck in the app; detached, failures swallowed. */
  onMergeCheck?: (docId: string) => Promise<unknown>;
  powerSave?: PowerSaveBlocker;
  clock?: PipelineClock;
  ids?: Partial<JobIds>;
  log?: Logger;
  /** Waits between saving attempts (06 §5.7: 1 retry after 2 s). */
  sleep?: (ms: number) => Promise<void>;
  progressDebounceMs?: number;
  /** fs.copyFile for input snapshots (06 §9.2); injected in tests to simulate a volume without clones. */
  copyFile?: (src: string, dst: string, mode?: number) => Promise<void>;
  /** Unclonable files up to this size are copied inline, larger ones in the background (06 §9.2). */
  snapshotInlineCopyMaxBytes?: number;
}

/** PipelineDeps with every default filled in (queue.ts). */
export type JobDeps = Omit<PipelineDeps, 'clock' | 'log' | 'sleep' | 'ids'> & {
  clock: PipelineClock;
  log: Logger;
  sleep: (ms: number) => Promise<void>;
  ids: JobIds;
};
