import type { KeyStore } from '../config';
import type { RetryPolicy } from './retry';
import type { TimeoutOptions } from './timeouts';

/**
 * Process-wide LLM wiring set once at bootstrap (02 §4 step 3, §7.4). Registry factories receive
 * only Settings, so the key store, the `eli5-llm` session fetch and the PipelinePolicy numbers are
 * supplied here. Until configured, calls fail with `auth` ("No API key set") at call time and the
 * app still opens.
 */
export interface LlmRuntime {
  keys?: Pick<KeyStore, 'get'>;
  /** llmFetch (net.ts); tests inject cassetteFetch. */
  fetch?: typeof fetch;
  retry?: RetryPolicy;
  timeouts?: Partial<TimeoutOptions>;
}

let runtime: LlmRuntime = {};

export function configureLlmRuntime(r: LlmRuntime): void {
  runtime = { ...runtime, ...r };
}

export function llmRuntime(): LlmRuntime {
  return runtime;
}

/** Test helper: forget everything configured so far. */
export function resetLlmRuntime(): void {
  runtime = {};
}
