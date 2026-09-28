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
import type { ResolvedSource, SkippedSource } from '../sources';
import type { LLMErrorKind } from '../llm';
import type { SectionJobPayload } from '../document';

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
