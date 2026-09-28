import type { ProviderId } from '../config';
import type { LLMError } from './errors';

/** Provider ids are owned by the settings schema (12 §3); re-exported here (02 §3). */
export type { ProviderId };
/** IPC-facing shapes for eli5:llm:* channels (02 §14) live in the preload contract. */
export type { TestConnectionResult, ModelsResult } from '../../preload/contract';

/** Catalogue prompt ids (02 §9). */
export type PromptId =
  | 'in-depth'
  | 'eli5'
  | 'glossary'
  | 'chunk-notes'
  | 'section-expand'
  | 'section-reexplain'
  | 'section-analogy'
  | 'section-deeper'
  | 'section-eli5-tab'
  | 'selection-eli5-tab'
  | 'summary'
  | 'merge-match'
  | 'photo-pick'
  | 'merge-weave';

export const PROMPT_IDS: readonly PromptId[] = [
  'in-depth',
  'eli5',
  'glossary',
  'chunk-notes',
  'section-expand',
  'section-reexplain',
  'section-analogy',
  'section-deeper',
  'section-eli5-tab',
  'selection-eli5-tab',
  'summary',
  'merge-match',
  'photo-pick',
  'merge-weave',
];

/** Image content part of a user message (02 §3). */
export interface ImageInput {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: Buffer; // raw bytes; providers encode as needed
  label: string; // e.g. "screenshot-1.png" or "deck.pdf p.4"
  sourceRef: string; // ResolvedSource.ref this image came from
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  images?: ImageInput[]; // only on role 'user'
}

export interface GenerationRequest {
  taskId: PromptId;
  system: string; // fully rendered system prompt (skills already injected)
  messages: ChatMessage[];
  maxOutputTokens: number;
  temperature?: number; // sent only if limits.supportsTemperature
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; // sent only if limits.supportsEffort
  jsonSchema?: {
    name: string;
    schema: object; // JSON Schema draft 2020-12
  };
  cacheSystemPrompt?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number; // overrides llm.timeoutMs for this call
  /** Called before each retry wait (02 §7.1 step 6); 06 shows " (retrying)" while it runs. */
  onRetry?: (attempt: number, waitMs: number) => void;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface GenerationResult {
  text: string; // for jsonSchema requests, the JSON string
  json?: unknown; // parsed, not yet zod-validated
  stopReason: 'end' | 'max_tokens' | 'refusal' | 'other';
  usage: TokenUsage;
  model: string;
  provider: ProviderId;
  latencyMs: number;
  attempts: number; // 1 + retries performed
}

export type StreamChunk = { type: 'text'; delta: string } | { type: 'done'; result: GenerationResult };

export interface ModelLimits {
  contextTokens: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  maxImagesPerRequest: number;
  maxImageBytes: number;
  supportsTemperature: boolean; // unknown models: false
  supportsEffort: boolean;
  thinkingReserveTokens: number;
  systemRole: 'system' | 'developer'; // OpenAI only
  structuredMode: 'output_config' | 'strict_tool_auto' | 'forced_tool' | 'json_schema_strict';
}

/** Result of LLMProvider.testConnection; never thrown (02 §3, §13). */
export type ConnectionCheck = { ok: true; model: string } | { ok: false; error: LLMError };

export interface LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  readonly limits: ModelLimits;
  generate(req: GenerationRequest): Promise<GenerationResult>;
  generateWithImages(req: GenerationRequest): Promise<GenerationResult>;
  stream?(req: GenerationRequest): AsyncIterable<StreamChunk>;
  /** Callers pass the request through PromptPolicy.preSendFilter first (HOOK-LLM-02). */
  countTokens?(req: Pick<GenerationRequest, 'system' | 'messages' | 'signal'>): Promise<number>;
  testConnection(): Promise<ConnectionCheck>;
}

/**
 * HOOK-LLM-02 prompt policy (02 §13, 01 §6 `{preamble, overridesDir, skills, preSendFilter}`).
 * Public default: `defaultPromptPolicy` in policy.ts.
 */
export interface PromptPolicy {
  /** Organization system-prompt preamble prepended to every system prompt; null = none. */
  readonly preamble: string | null;
  /** Overlay prompt overrides directory (same format and ids as 02 §9; overlay copy wins); null = none. */
  readonly overridesDir: string | null;
  /** Organization-approved default skill directories (02 §11); empty = bundled/user skills only. */
  readonly skills: readonly string[];
  /**
   * Runs before every provider send(). Returns the (possibly redacted) request, or throws
   * LLMError('bad_request') to block content that must never reach the model.
   */
  preSendFilter(req: GenerationRequest): GenerationRequest | Promise<GenerationRequest>;
}

/** 02 §3.1 */
export type LLMErrorKind =
  | 'auth' // 401/403, missing or invalid key: not retried
  | 'bad_request' // 400, schema rejected, too many images: not retried
  | 'context_overflow' // input exceeds window: not retried, caller re-budgets
  | 'rate_limited' // 429: retried with backoff, honors retry-after
  | 'overloaded' // 529 / 503: retried
  | 'server' // 500/502/504: retried
  | 'timeout' // client-side timeout: retried once
  | 'network' // DNS, TLS, reset: retried
  | 'refusal' // model declined: not retried
  | 'invalid_output' // JSON failed validation after repair: not retried
  | 'cancelled' // AbortSignal fired
  | 'not_available'; // NotAvailableInEdition (stub provider)
