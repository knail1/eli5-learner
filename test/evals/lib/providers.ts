/**
 * Providers for eval runs (13 §9.3, §9.6): real Claude/OpenAI providers built from env keys, every
 * one wrapped in the devtools BudgetGuardProvider over one shared BudgetLedger, a recorder that keeps
 * the generator's requests in memory (the judge's source text), and the judge call itself.
 */
import { DEFAULTS, type Settings } from '../../../src/main/config/schema';
import { BudgetGuardProvider, type BudgetLedger, type ModelRates } from '../../../src/main/devtools';
import {
  DEFAULT_RETRY,
  createClaudeProvider,
  createOpenAIProvider,
  type ChatMessage,
  type ConnectionCheck,
  type GenerationRequest,
  type GenerationResult,
  type ImageInput,
  type LLMProvider,
  type ModelLimits,
  type PromptId,
  type ProviderId,
  type RetryPolicy,
} from '../../../src/main/llm';
import type { EvalProvider } from './config';
import type { JudgeFn } from './judge';

/** One retry per call: transient 429/5xx should not sink a case; the guard reserves both attempts. */
export const EVAL_RETRY: RetryPolicy = Object.freeze({ ...DEFAULT_RETRY, maxRetries: 1, maxRetriesByKind: {} });

/** Judge replies are small JSON objects; room for reasoning models' thinking as well. */
export const JUDGE_MAX_OUTPUT_TOKENS = 8_000;
/** The judge is not a catalogue prompt; its ledger lines carry this PromptId. */
export const JUDGE_TASK_ID: PromptId = 'summary';

export function evalSettings(provider: EvalProvider, model: string): Settings {
  return { ...DEFAULTS, llm: { ...DEFAULTS.llm, provider, model } };
}

export function realProvider(provider: EvalProvider, model: string, apiKey: string): LLMProvider {
  const s = evalSettings(provider, model);
  const deps = { getApiKey: async () => apiKey, fetch: globalThis.fetch, retry: EVAL_RETRY };
  return provider === 'claude' ? createClaudeProvider(s, deps) : createOpenAIProvider(s, deps);
}

export function guard(inner: LLMProvider, ledger: BudgetLedger, rates?: ModelRates): BudgetGuardProvider {
  return new BudgetGuardProvider(inner, ledger, { retry: () => EVAL_RETRY, ...(rates ? { rates } : {}) });
}

export interface RecordedCall {
  taskId: PromptId;
  messages: ChatMessage[];
}

/** Keeps the generator's requests for the case in memory; nothing is logged or written. */
export class RecordingProvider implements LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  calls: RecordedCall[] = [];

  constructor(private readonly inner: LLMProvider) {
    this.id = inner.id;
    this.model = inner.model;
  }

  get limits(): ModelLimits {
    return this.inner.limits;
  }

  reset(): void {
    this.calls = [];
  }

  generate(req: GenerationRequest): Promise<GenerationResult> {
    this.calls.push({ taskId: req.taskId, messages: req.messages });
    return this.inner.generate(req);
  }

  generateWithImages(req: GenerationRequest): Promise<GenerationResult> {
    this.calls.push({ taskId: req.taskId, messages: req.messages });
    return this.inner.generateWithImages(req);
  }

  countTokens(req: Pick<GenerationRequest, 'system' | 'messages' | 'signal'>): Promise<number> {
    return this.inner.countTokens ? this.inner.countTokens(req) : Promise.reject(new Error('countTokens unsupported'));
  }

  testConnection(): Promise<ConnectionCheck> {
    return this.inner.testConnection();
  }

  /**
   * The extracted source material exactly as the generator saw it (13 §9.3 step 3): the chunk-notes
   * inputs when the job was chunked (02 §8.4), else the in-depth request's user message.
   */
  sourceMaterial(): { text: string; images: ImageInput[] } {
    const chunks = this.calls.filter((c) => c.taskId === 'chunk-notes');
    const picked = chunks.length ? chunks : this.calls.filter((c) => c.taskId === 'in-depth').slice(0, 1);
    const users = picked.flatMap((c) => c.messages.filter((m) => m.role === 'user'));
    return {
      text: users.map((m) => m.text).join('\n\n'),
      images: users.flatMap((m) => m.images ?? []),
    };
  }
}

/** The judge call on a (budget-guarded) provider: prompted JSON, images only when the case had any. */
export function judgeFnFor(p: LLMProvider): JudgeFn {
  return async (r) => {
    const images = r.images?.slice(0, p.limits.maxImagesPerRequest);
    const req: GenerationRequest = {
      taskId: JUDGE_TASK_ID,
      system: r.system,
      messages: [{ role: 'user', text: r.user, ...(images?.length ? { images } : {}) }],
      maxOutputTokens: Math.min(JUDGE_MAX_OUTPUT_TOKENS, p.limits.maxOutputTokens),
    };
    const res = images?.length ? await p.generateWithImages(req) : await p.generate(req);
    return res.text;
  };
}
