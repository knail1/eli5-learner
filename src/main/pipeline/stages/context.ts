// What every stage receives (06 §5): the job, its signal, persistence and event hooks.
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { SlugReservation } from '../../library';
import { LOG_FIELD_ALLOWLIST, type Logger, type LogFields } from '../../security';
import type { JobStore } from '../store';
import type { Job, JobCheckpoint, JobDeps, JobStep, JobWarning } from '../types';

export interface StageContext {
  readonly job: Job;
  readonly signal: AbortSignal;
  readonly deps: JobDeps;
  readonly store: JobStore;
  /** Immediate write + change event. */
  persist(): Promise<void>;
  /** Debounced write + change event (progress only, 06 §9.1). */
  progress(): void;
  /** Generation sub-steps now running (06 §5.4 rule 4). */
  setRunningSteps(steps: readonly JobStep[]): void;
  /** Called right before library.commitDocument(); cancel is refused from then on (06 §8.1). */
  setCommitStarted(started: boolean): void;
  /** Resolves when the job's background snapshot copies have settled (06 §9.2). */
  inputsReady(): Promise<void>;
  /** The slug reservation held by saving, released on failure or cancel (06 §5.7 step 4). */
  reservation?: SlugReservation;
}

/** Throws an AbortError when the job was cancelled (stages check between units of work, 06 §5). */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Job cancelled', 'AbortError');
}

export function emptyCheckpoint(): JobCheckpoint {
  return { stage: 'reading', resolvedRefs: [], extractedIndexes: [], completedSteps: [] };
}

export function checkpointOf(job: Job): JobCheckpoint {
  job.checkpoint ??= emptyCheckpoint();
  return job.checkpoint;
}

const STAGE_ORDER = ['reading', 'extracting', 'generating', 'saving'] as const;
export function stageIndex(stage: JobCheckpoint['stage'] | undefined): number {
  return stage ? STAGE_ORDER.indexOf(stage) : 0;
}

/** Adds a warning once (same kind and message). */
export function addWarning(job: Job, w: JobWarning): void {
  if (!job.warnings.some((x) => x.kind === w.kind && x.message === w.message)) job.warnings.push(w);
}

/** `src-07` -> 7: the stable key of an extracted artifact (06 §9.3 extractedIndexes). */
export function sourceIndex(sourceId: string): number {
  const n = Number(/^src-(\d+)$/.exec(sourceId)?.[1]);
  return Number.isInteger(n) ? n : -1;
}

/** Forget every staged artifact after reading (Retry of URL sources, invalid checkpoints; 06 §7.3, §9.3). */
export async function resetToReading(job: Job, store: JobStore): Promise<void> {
  job.resolved = [];
  job.skipped = [];
  job.warnings = [];
  job.progress = { ...job.progress, sourcesDone: 0 };
  delete job.progress.step;
  job.checkpoint = emptyCheckpoint();
  const dir = store.stagingDir(job.id);
  for (const sub of ['extracted', 'gen', 'downloads']) {
    await rm(path.join(dir, sub), { recursive: true, force: true });
  }
}

/** Resolver/extractor debug logs go through the security logger with allowlisted fields only (12 §11). */
export function debugLog(log: Logger, event: string): (msg: string, data?: Record<string, unknown>) => void {
  return (msg, data) => {
    const fields: LogFields = { kind: msg.slice(0, 80) };
    for (const [k, v] of Object.entries(data ?? {})) {
      if (!LOG_FIELD_ALLOWLIST.has(k)) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) fields[k] = v;
    }
    log.debug(event, fields);
  };
}
