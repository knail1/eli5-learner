/**
 * Public API of the generation pipeline (06).
 *
 * - JobQueue: the scheduler and runner. `init()` recovers and starts; `start`, `list`, `cancel`, `retry`,
 *   `dismiss` back the `eli5:jobs:*` handlers; `enqueueSection` backs 08's channels; events `changed`
 *   (JobSnapshot, for `eli5:jobs:changed`) and `done` (JobDoneEvent, for notifications).
 * - createPipelineDeps (deps.ts): assembles production dependencies from the registry and Electron.
 * - PipelineRequestError: synchronous request errors carrying an IpcErrorCode.
 * - PipelineFailure: thrown by section runners (08) to end a job with a JobFailureCode.
 */
export type {
  Job,
  JobCheckpoint,
  JobDeps,
  JobDoneEvent,
  JobIds,
  ExtractRunner,
  PipelineDeps,
  PipelinePhotos,
  PipelineLibrary,
  PowerSaveBlocker,
  SectionRunContext,
  SectionRunner,
  JobFailure,
  JobFailureCode,
  JobId,
  JobKind,
  JobOptions,
  JobProgress,
  JobResultRef,
  JobSnapshot,
  JobStatus,
  JobStep,
  JobWarning,
  PipelineClock,
  PipelinePolicy,
  SectionJobPayload,
  SourceInput,
  StartJobRequest,
} from './types';
export type { StatusLineContext, StatusLineJob } from './status';
export {
  GENERATING_DETAIL,
  IllegalTransitionError,
  STATUS_LINES,
  assertTransition,
  canTransition,
  statusLine,
  truncateTitle,
} from './status';
export { defaultPipelinePolicy } from './policy';
export { registerPublic } from './register';
export { createJob, snapshotOf, isTerminal, isRetryable, plannedSteps, parseJobRecord, JobRecordSchema } from './job';
export type { CreateJobInput, SnapshotContext } from './job';
export { JobStore, PROGRESS_DEBOUNCE_MS } from './store';
export type { JobStoreOptions } from './store';
export { JobQueue, DONE_LINE_MS, MAX_ATTEMPTS } from './queue';
export { PipelineFailure, PipelineRequestError, failureFromError, failureMessage, llmFailureCode } from './errors';
export { inProcessExtractRunner } from './runner';
export type { InProcessExtractOptions } from './runner';
export { dedupeInputs, snapshotInputs } from './inputs';
export type { CopyFileFn, PendingCopy, SnapshotOptions, SnapshotResult } from './inputs';
export { fallbackSummary } from './stages/generate';
export { SAVE_RETRY_DELAY_MS } from './stages/save';
export { parseThemeTokens } from './theme';
export { createPipelineDeps } from './deps';
export type { CreatePipelineDepsOptions, PipelineElectron, PipelineRuntime } from './deps';
