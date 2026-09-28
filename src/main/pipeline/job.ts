// Job records: creation, the persisted-record schema, and the renderer snapshot (06 §3, §9.1).
import { z } from 'zod';
import { statusLine } from './status';
import type {
  Job,
  JobFailureCode,
  JobId,
  JobKind,
  JobOptions,
  JobSnapshot,
  JobStatus,
  JobStep,
  SectionJobPayload,
  SourceInput,
} from './types';

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(['done', 'failed']);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Failure codes that Retry cannot help with (06 §6: no Retry for CANCELLED; section codes, 08 §9). */
const NOT_RETRYABLE: ReadonlySet<JobFailureCode> = new Set<JobFailureCode>([
  'CANCELLED',
  'SECTION_TOO_LARGE',
  'SECTION_GONE',
  'SECTION_CHANGED',
  'DOC_GONE',
  'TOO_MANY_TABS',
]);

export function isRetryable(code: JobFailureCode | undefined): boolean {
  return code !== undefined && !NOT_RETRYABLE.has(code);
}

/** Steps in 06 §5.4 order; glossary only when the per-job toggle is on. */
export function plannedSteps(options: JobOptions): JobStep[] {
  return options.glossary ? ['indepth', 'eli5', 'glossary', 'summary'] : ['indepth', 'eli5', 'summary'];
}

export interface CreateJobInput {
  id: JobId;
  kind: JobKind;
  now: Date;
  inputs: SourceInput[];
  options: JobOptions;
  section?: SectionJobPayload;
}

/** A new `queued` job at attempt 1 (06 §5.1 step 3). */
export function createJob(i: CreateJobInput): Job {
  return {
    id: i.id,
    kind: i.kind,
    status: 'queued',
    createdAt: i.now.toISOString(),
    inputs: i.inputs,
    options: i.options,
    progress: {
      sourcesTotal: i.inputs.length,
      sourcesDone: 0,
      stepsPlanned: i.kind === 'section' ? [] : plannedSteps(i.options),
    },
    resolved: [],
    skipped: [],
    warnings: [],
    attempt: 1,
    ...(i.section ? { section: i.section } : {}),
  };
}

/** Runtime state that is not on the record but shapes the snapshot. */
export interface SnapshotContext {
  queuePosition?: number;
  runningSteps?: readonly JobStep[];
  /** library.commitDocument() has been called: cancel is refused from here on (06 §8.1). */
  commitStarted?: boolean;
}

/** What the renderer receives: no file contents, no failure detail (06 §3.1, §13). */
export function snapshotOf(job: Job, ctx: SnapshotContext = {}): JobSnapshot {
  const terminal = isTerminal(job.status);
  const queued = job.status === 'queued' && ctx.queuePosition !== undefined;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    statusLine: statusLine(job, {
      ...(ctx.queuePosition !== undefined ? { queuePosition: ctx.queuePosition } : {}),
      ...(ctx.runningSteps ? { runningSteps: ctx.runningSteps } : {}),
      ...(job.tabLabel ? { tabLabel: job.tabLabel } : {}),
    }),
    createdAt: job.createdAt,
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(queued ? { queuePosition: ctx.queuePosition } : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.failure ? { failureCode: job.failure.code } : {}),
    skippedCount: job.skipped.length,
    canCancel: !terminal && !ctx.commitStarted,
    canRetry: job.status === 'failed' && isRetryable(job.failure?.code),
    canDismiss: terminal,
  };
}

// ---- persisted record schema (06 §9.1: "each file is validated with a schema") ----

const STATUSES = ['queued', 'reading', 'extracting', 'generating', 'saving', 'done', 'failed'] as const;
const STEPS = ['indepth', 'eli5', 'glossary', 'summary'] as const;

/**
 * Structural check of a job record. Nested records owned by other modules (SourceInput,
 * ResolvedSource, SkippedSource, SectionJobPayload) are checked for shape only and kept verbatim.
 */
export const JobRecordSchema = z
  .object({
    id: z.string().regex(/^[0-9A-Za-z_-]{1,128}$/),
    kind: z.enum(['create', 'section']),
    status: z.enum(STATUSES),
    createdAt: z.string().min(1),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    inputs: z.array(z.object({ id: z.string(), kind: z.string() }).passthrough()),
    options: z.object({ clarifyingInput: z.string(), glossary: z.boolean() }).passthrough(),
    progress: z
      .object({
        sourcesTotal: z.number().int().nonnegative(),
        sourcesDone: z.number().int().nonnegative(),
        step: z.enum(STEPS).optional(),
        stepsPlanned: z.array(z.enum(STEPS)),
      })
      .passthrough(),
    resolved: z.array(z.object({ id: z.string(), ref: z.string() }).passthrough()),
    skipped: z.array(z.object({ ref: z.string(), reason: z.string(), code: z.string() }).passthrough()),
    warnings: z.array(z.object({ kind: z.string(), message: z.string() }).passthrough()),
    attempt: z.number().int().positive(),
    checkpoint: z
      .object({
        stage: z.enum(['reading', 'extracting', 'generating', 'saving']),
        resolvedRefs: z.array(z.string()),
        extractedIndexes: z.array(z.number().int().nonnegative()),
        completedSteps: z.array(z.enum(STEPS)),
        topicSlug: z.string().optional(),
      })
      .passthrough()
      .optional(),
    failure: z
      .object({ code: z.string(), message: z.string(), detail: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Parses one record; null when it is not a valid Job. */
export function parseJobRecord(raw: unknown): Job | null {
  const r = JobRecordSchema.safeParse(raw);
  return r.success ? (r.data as unknown as Job) : null;
}
