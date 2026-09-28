// Job failures (06 §5.4 rule 2, §7.2) and synchronous request errors for the IPC handlers (06 §11).
import type { IpcErrorCode } from '../../preload/contract';
import { DocumentBuildError } from '../document';
import { LibraryError } from '../library';
import { LLMError } from '../llm';
import { IllegalTransitionError, STATUS_LINES } from './status';
import type { JobFailure, JobFailureCode } from './types';

/** The user-facing text after "Failed: " for each code (06 §6). */
export function failureMessage(code: JobFailureCode): string {
  const line = code === 'NO_USABLE_CONTENT' ? 'Failed: no usable content' : STATUS_LINES.failed[code];
  return line.replace(/^Failed: /, '');
}

/** Thrown by stages (and section runners, 08) to end a job with a specific code. */
export class PipelineFailure extends Error {
  constructor(
    readonly code: JobFailureCode,
    readonly detail?: string,
    message?: string,
  ) {
    super(message ?? failureMessage(code));
    this.name = 'PipelineFailure';
  }

  toFailure(): JobFailure {
    return { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) };
  }
}

/** Rejected synchronously by JobQueue; the IPC handler turns it into an IpcResult error (06 §11). */
export class PipelineRequestError extends Error {
  constructor(
    readonly code: Extract<IpcErrorCode, 'E_BAD_REQUEST' | 'E_NOT_FOUND' | 'E_CONFLICT' | 'E_LIBRARY_READ_ONLY'>,
    message: string,
  ) {
    super(message);
    this.name = 'PipelineRequestError';
  }
}

/** 06 §5.4 rule 2: LLMError kind -> JobFailure code. */
export function llmFailureCode(kind: LLMError['kind']): JobFailureCode {
  switch (kind) {
    case 'auth':
      return 'LLM_AUTH';
    case 'bad_request':
      return 'INTERNAL';
    case 'cancelled':
      return 'CANCELLED';
    default:
      return 'LLM_UNAVAILABLE';
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof LLMError && err.kind === 'cancelled') ||
    (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError')
  );
}

/**
 * Maps anything a stage threw to a JobFailure. `aborted` (the job signal fired) wins, so every
 * error caused by cancellation ends as CANCELLED (06 §8.1).
 */
export function failureFromError(err: unknown, aborted: boolean): JobFailure {
  if (aborted || isAbortError(err)) return new PipelineFailure('CANCELLED').toFailure();
  if (err instanceof PipelineFailure) return err.toFailure();
  if (err instanceof LLMError) {
    const code = llmFailureCode(err.kind);
    return new PipelineFailure(code, `llm:${err.kind}`).toFailure();
  }
  if (err instanceof DocumentBuildError) {
    // 07 §5.1 step 3: an unusable in-depth draft counts as invalid output.
    return new PipelineFailure('LLM_UNAVAILABLE', `invalid_output:${err.code}`).toFailure();
  }
  if (err instanceof LibraryError) return new PipelineFailure('SAVE_FAILED', `library:${err.code}`).toFailure();
  if (err instanceof IllegalTransitionError) return new PipelineFailure('INTERNAL', 'illegal-transition').toFailure();
  return new PipelineFailure('INTERNAL', err instanceof Error ? err.name : 'unknown').toFailure();
}
