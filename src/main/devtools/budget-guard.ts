import { DEFAULT_RETRY, LLMError, llmRuntime } from '../llm';
import type {
  ConnectionCheck,
  GenerationRequest,
  GenerationResult,
  LLMErrorKind,
  LLMProvider,
  ModelLimits,
  ProviderId,
  RetryPolicy,
} from '../llm';
import type { BudgetLedger, Charge } from './ledger';
import { CACHE_WRITE_MULTIPLIER, costOf, ratesFor, type ModelRates } from './rates';

/**
 * Dev-only LLMProvider wrapper that enforces a hard USD cap for real-run tooling. Before each call it
 * counts input, clamps maxOutputTokens so the worst case (input + full output) fits the remaining
 * budget, and reserves that worst case in the ledger. After the call it records the actual cost.
 * The inner provider may retry internally (02 §7.1) and each attempt may be billed, so the worst case
 * is reserved once per attempt the retry policy allows.
 */

/** Fewer output tokens than this cannot produce a useful draft; refuse instead. */
export const MIN_OUTPUT_TOKENS = 2048;
/** Conservative per-image input cost (02 §8.1 caps one image at 1600 tokens). */
export const IMAGE_TOKENS = 1600;

/** Errors raised before the model generated anything (nothing billed). */
const UNBILLED: readonly LLMErrorKind[] = ['auth', 'bad_request', 'context_overflow', 'not_available'];

// Integer arithmetic for the 1.1 factor: 100 * 1.1 is 110.00000000000001 in floating point.
const estimateChars = (chars: number): number => Math.ceil((Math.ceil(chars / 3) * 11) / 10);

/** ceil(chars/3)*1.1 over system and messages, plus 1600 tokens per image. */
export function estimateInputTokens(req: Pick<GenerationRequest, 'system' | 'messages'>): number {
  const chars = req.messages.reduce((n, m) => n + m.text.length, req.system.length);
  const images = req.messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
  return estimateChars(chars) + images * IMAGE_TOKENS;
}

/** Most attempts one call can make under `policy`: the first plus the largest retry allowance. */
export function maxAttempts(policy: RetryPolicy): number {
  const byKind = Object.values(policy.maxRetriesByKind ?? {}).filter((n): n is number => typeof n === 'number');
  return 1 + Math.max(0, policy.maxRetries, ...byKind);
}

export interface BudgetGuardOptions {
  /** The retry policy the inner provider uses, read per call. Default: the process LLM runtime's. */
  retry?: () => RetryPolicy;
  /**
   * Price for a model missing from MODEL_RATES (the eval runner's ELI5_EVAL_RATES, 13 §9.6). Ignored
   * for a priced model, so an override can never make the cap under-count.
   */
  rates?: ModelRates;
}

export class BudgetGuardProvider implements LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  readonly limits: ModelLimits;
  private readonly retry: () => RetryPolicy;
  private readonly rates: ModelRates | undefined;

  constructor(
    private readonly inner: LLMProvider,
    private readonly ledger: BudgetLedger,
    o: BudgetGuardOptions = {},
  ) {
    this.id = inner.id;
    this.model = inner.model;
    this.limits = inner.limits;
    this.retry = o.retry ?? (() => llmRuntime().retry ?? DEFAULT_RETRY);
    this.rates = o.rates;
  }

  generate(req: GenerationRequest): Promise<GenerationResult> {
    return this.guarded(req, (r) => this.inner.generate(r));
  }

  generateWithImages(req: GenerationRequest): Promise<GenerationResult> {
    return this.guarded(req, (r) => this.inner.generateWithImages(r));
  }

  countTokens(req: Pick<GenerationRequest, 'system' | 'messages' | 'signal'>): Promise<number> {
    return this.inner.countTokens ? this.inner.countTokens(req) : Promise.resolve(estimateInputTokens(req));
  }

  testConnection(): Promise<ConnectionCheck> {
    return this.inner.testConnection();
  }

  private async inputTokens(req: GenerationRequest): Promise<number> {
    let n: number | undefined;
    if (this.inner.countTokens) {
      try {
        n = await this.inner.countTokens({ system: req.system, messages: req.messages, signal: req.signal });
      } catch {
        n = undefined;
      }
    }
    const schema = req.jsonSchema ? estimateChars(JSON.stringify(req.jsonSchema).length) : 0;
    return (n ?? estimateInputTokens(req)) + schema;
  }

  private async guarded(
    req: GenerationRequest,
    send: (r: GenerationRequest) => Promise<GenerationResult>,
  ): Promise<GenerationResult> {
    if (req.signal?.aborted) throw new LLMError('cancelled', 'Request cancelled');
    const rates = ratesFor(this.inner.model) ?? this.rates;
    if (!rates) throw new LLMError('cancelled', `budget guard: unknown model ${this.inner.model} has no price`);
    const inRate = rates.inputPerMTok / 1e6;
    const outRate = rates.outputPerMTok / 1e6;
    const input = await this.inputTokens(req);
    const attempts = maxAttempts(this.retry());

    const inputCost = input * inRate * (req.cacheSystemPrompt ? CACHE_WRITE_MULTIPLIER : 1);
    // While other calls are in flight, wait for them to settle rather than clamping or refusing:
    // their reservations are worst cases and settle far lower, so a concurrent step (in-depth and
    // ELI5 run together) is not starved by its sibling's reservation. Clamp only when alone.
    while (
      (inputCost + req.maxOutputTokens * outRate) * attempts > this.ledger.remainingUsd + 1e-12 &&
      this.ledger.openCount > 0
    ) {
      await abortable(this.ledger.whenSettled(), req.signal);
    }
    // From here to reserve() is synchronous, so concurrent calls are serialized on the ledger.
    // Output tokens one attempt may use so that every allowed attempt fits the remaining budget.
    const fits = Math.floor((this.ledger.remainingUsd / attempts - inputCost) / outRate + 1e-9);
    // Refuse only when the budget (not the request's own smaller maxOutputTokens) is the limit.
    if (fits < MIN_OUTPUT_TOKENS) throw new LLMError('cancelled', 'budget exhausted');
    const maxOut = Math.min(req.maxOutputTokens, fits);
    const perAttempt = inputCost + maxOut * outRate;
    const res = this.ledger.reserve({
      maxCostUsd: perAttempt * attempts,
      model: this.inner.model,
      taskId: req.taskId,
    });

    let result: GenerationResult;
    try {
      result = await send({ ...req, maxOutputTokens: maxOut });
    } catch (err) {
      // The attempt count is unknown on failure: charge every allowed attempt, except the last when
      // it failed before generating anything.
      const unbilled = err instanceof LLMError && UNBILLED.includes(err.kind);
      this.ledger.settle(res, {
        ...ZERO,
        costUsd: perAttempt * (unbilled ? attempts - 1 : attempts),
        outcome: 'error',
      });
      throw err;
    }
    this.ledger.settle(res, this.charge(req, result, rates, perAttempt));
    return result;
  }

  private charge(req: GenerationRequest, result: GenerationResult, rates: ModelRates, perAttempt: number): Charge {
    const u = result.usage;
    const read = u.cachedInputTokens ?? 0;
    // TokenUsage folds cache writes into inputTokens; use an explicit count when a provider reports
    // one, else assume the system prompt was written when caching was requested and nothing was read.
    const explicit = (u as { cacheWriteInputTokens?: unknown }).cacheWriteInputTokens;
    const write =
      typeof explicit === 'number'
        ? explicit
        : req.cacheSystemPrompt && read === 0
          ? Math.min(estimateChars(req.system.length), u.inputTokens)
          : 0;
    const tokens = {
      inputTokens: u.inputTokens,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      outputTokens: u.outputTokens,
    };
    // A failed attempt retried inside the provider may have been billed up to its worst case.
    const retries = Math.max(0, result.attempts - 1) * perAttempt;
    return { ...tokens, costUsd: costOf(rates, tokens) + retries, outcome: 'ok' };
  }
}

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Waits for `p`, but rejects with a cancelled LLMError as soon as `signal` aborts. */
function abortable(p: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new LLMError('cancelled', 'Request cancelled'));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new LLMError('cancelled', 'Request cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, reject);
  });
}
