import type { PipelinePolicy } from '../pipeline';
import { LLMError } from './errors';
import type { LLMErrorKind } from './types';

/**
 * The single LLM retry policy (02 §7.1). PipelinePolicy (HOOK-PIPE-01) may override only the numbers.
 */
export interface RetryPolicy {
  /** Retries after the first attempt, per retryable kind (default 3, i.e. 4 attempts). */
  maxRetries: number;
  maxRetriesByKind?: Partial<Record<LLMErrorKind, number>>;
  backoffMs: readonly number[];
  maxRetryAfterMs: number;
  /** Uniform jitter range applied to backoff (default ±20%). */
  jitter: readonly [number, number];
}

export const DEFAULT_RETRY: RetryPolicy = Object.freeze({
  maxRetries: 3,
  backoffMs: Object.freeze([2000, 8000, 30000]),
  maxRetryAfterMs: 120_000,
  jitter: Object.freeze([0.8, 1.2] as const),
});

/** Maps the PipelinePolicy override shape (06) onto RetryPolicy; absent fields keep 02's defaults. */
export function retryPolicyFromPipeline(p: Pick<PipelinePolicy, 'llmRetryOverride'> | undefined): RetryPolicy {
  const o = p?.llmRetryOverride;
  if (!o) return DEFAULT_RETRY;
  const byKind: Partial<Record<LLMErrorKind, number>> = {};
  for (const [kind, attempts] of Object.entries(o.maxAttempts ?? {})) {
    if (typeof attempts === 'number') byKind[kind as LLMErrorKind] = Math.max(0, attempts - 1);
  }
  const base = o.baseMs;
  return {
    ...DEFAULT_RETRY,
    maxRetriesByKind: byKind,
    // Keep the 1 : 4 : 15 shape of the default schedule when only the base changes.
    backoffMs: base !== undefined ? [base, base * 4, base * 15] : DEFAULT_RETRY.backoffMs,
    maxRetryAfterMs: o.maxRetryAfterMs ?? DEFAULT_RETRY.maxRetryAfterMs,
  };
}

export interface RetryHooks {
  signal?: AbortSignal;
  onRetry?: (attempt: number, waitMs: number) => void;
  /** Injected for tests; default setTimeout-based and abortable. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(cancelled());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const cancelled = (): LLMError => new LLMError('cancelled', 'Request cancelled');

/**
 * Runs `fn` with 02 §7.1 retries. `fn` receives the 1-based attempt number. Errors are classified
 * with `classify` (defaults to `classifyError`). Returns the value and the number of attempts made.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  hooks: RetryHooks = {},
  classify: (e: unknown) => LLMError = (e) => classifyError(e),
): Promise<{ value: T; attempts: number }> {
  const sleep = hooks.sleep ?? abortableSleep;
  const random = hooks.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    if (hooks.signal?.aborted) throw cancelled();
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (e) {
      if (hooks.signal?.aborted) throw cancelled();
      const err = classify(e);
      if (!err.retryable) throw err;
      const retry = attempt; // retries performed so far + 1
      const max = policy.maxRetriesByKind?.[err.kind] ?? policy.maxRetries;
      if (retry > max) throw err;
      const base = policy.backoffMs[Math.min(retry - 1, policy.backoffMs.length - 1)] ?? 0;
      const [lo, hi] = policy.jitter;
      let wait = Math.round(base * (lo + (hi - lo) * random()));
      if (err.retryAfterMs !== undefined) {
        if (err.retryAfterMs > policy.maxRetryAfterMs) throw err; // above the cap: stop (step 3)
        wait = Math.max(wait, err.retryAfterMs);
      }
      hooks.onRetry?.(attempt, wait);
      await sleep(wait, hooks.signal);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Classification (02 §3.1, §7.1 step 1)
// ---------------------------------------------------------------------------------------------

const OVERFLOW_RE =
  /prompt is too long|context[ _-]?(window|length)|maximum context length|too many tokens|context_length_exceeded|input is too long/i;
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

type HeaderBag = Headers | Record<string, string | null | undefined> | undefined | null;

function header(h: HeaderBag, name: string): string | undefined {
  if (!h) return undefined;
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name) ?? undefined;
  const rec = h as Record<string, string | null | undefined>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  return key ? (rec[key] ?? undefined) : undefined;
}

/** `retry-after-ms`, or `retry-after` in seconds or as an HTTP date (02 §7.1 step 3). */
export function parseRetryAfter(h: HeaderBag, now: () => number = Date.now): number | undefined {
  const ms = header(h, 'retry-after-ms');
  if (ms !== undefined && ms.trim() !== '' && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const ra = header(h, 'retry-after');
  if (ra === undefined || ra.trim() === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(ra.trim())) return Math.max(0, Number(ra) * 1000);
  const date = Date.parse(ra);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now());
}

export function kindForStatus(status: number, message: string, code?: string | null): LLMErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 413) return 'context_overflow';
  if (status === 429) return 'rate_limited';
  if (status === 529 || status === 503) return 'overloaded';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server';
  if (OVERFLOW_RE.test(message) || OVERFLOW_RE.test(code ?? '')) return 'context_overflow';
  return 'bad_request';
}

const HUMAN: Record<LLMErrorKind, (label: string) => string> = {
  auth: (l) => `${l} API key rejected. Check Settings.`,
  bad_request: (l) => `${l} rejected the request.`,
  context_overflow: (l) => `The input is too large for the selected ${l} model.`,
  rate_limited: (l) => `${l} rate limit reached.`,
  overloaded: (l) => `${l} is overloaded right now.`,
  server: (l) => `${l} server error.`,
  timeout: (l) => `${l} did not respond in time.`,
  network: (l) => `Could not reach ${l}. Check your network connection.`,
  refusal: (l) => `${l} declined to answer.`,
  invalid_output: (l) => `${l} returned output that could not be used.`,
  cancelled: () => 'Request cancelled',
  not_available: (l) => `${l} is not available in this edition.`,
};

export function humanMessage(kind: LLMErrorKind, label: string): string {
  return HUMAN[kind](label);
}

interface ErrorLike {
  name?: unknown;
  status?: unknown;
  headers?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
}

/**
 * Maps any thrown value to an LLMError: HTTP status and headers from SDK errors, SDK abort and
 * timeout classes, Node network codes. Messages are generic (never source text or keys); a short
 * vendor detail is appended only for 400s so schema problems stay debuggable.
 */
export function classifyError(e: unknown, label = 'The model provider'): LLMError {
  if (e instanceof LLMError) return e;
  const x = (typeof e === 'object' && e !== null ? e : {}) as ErrorLike;
  const name = typeof x.name === 'string' ? x.name : '';
  const message = typeof x.message === 'string' ? x.message : String(e);
  if (name === 'AbortError' || name === 'APIUserAbortError') return new LLMError('cancelled', 'Request cancelled');
  if (name === 'APIConnectionTimeoutError')
    return new LLMError('timeout', humanMessage('timeout', label), undefined, undefined, e);
  if (typeof x.status === 'number') {
    const code = typeof x.code === 'string' ? x.code : null;
    const kind = kindForStatus(x.status, message, code);
    const retryAfter = parseRetryAfter(x.headers as HeaderBag);
    const detail = kind === 'bad_request' ? ` (${message.slice(0, 160)})` : '';
    return new LLMError(kind, humanMessage(kind, label) + detail, x.status, retryAfter, e);
  }
  const causeCode = codeOf(x) ?? codeOf(x.cause);
  if (
    name === 'APIConnectionError' ||
    (causeCode !== undefined && NETWORK_CODES.has(causeCode)) ||
    e instanceof TypeError
  ) {
    return new LLMError('network', humanMessage('network', label), undefined, undefined, e);
  }
  // Unknown non-HTTP failures are not retried: they are bugs or malformed responses.
  return new LLMError('bad_request', `${label} call failed unexpectedly.`, undefined, undefined, e);
}

function codeOf(v: unknown): string | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const c = (v as { code?: unknown }).code;
  return typeof c === 'string' ? c : undefined;
}
