import { LLMError } from '../llm';
import type {
  ConnectionCheck,
  GenerationRequest,
  GenerationResult,
  LLMErrorKind,
  LLMProvider,
  ModelLimits,
  ProviderId,
} from '../llm';
import type { BudgetLedger, Charge } from './ledger';
import { CACHE_WRITE_MULTIPLIER, costOf, ratesFor } from './rates';

/**
 * Dev-only LLMProvider wrapper that enforces a hard USD cap for real-run tooling. Before each call it
 * counts input, clamps maxOutputTokens so the worst case (input + full output) fits the remaining
 * budget, and reserves that worst case in the ledger. After the call it records the actual cost.
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

export class BudgetGuardProvider implements LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  readonly limits: ModelLimits;

  constructor(
    private readonly inner: LLMProvider,
    private readonly ledger: BudgetLedger,
  ) {
    this.id = inner.id;
    this.model = inner.model;
    this.limits = inner.limits;
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
    const rates = ratesFor(this.inner.model);
    if (!rates) throw new LLMError('cancelled', `budget guard: unknown model ${this.inner.model} has no price`);
    const inRate = rates.inputPerMTok / 1e6;
    const outRate = rates.outputPerMTok / 1e6;
    const input = await this.inputTokens(req);

    // From here to reserve() is synchronous, so concurrent calls are serialized on the ledger.
    const inputCost = input * inRate * (req.cacheSystemPrompt ? CACHE_WRITE_MULTIPLIER : 1);
    const fits = Math.floor((this.ledger.remainingUsd - inputCost) / outRate + 1e-9);
    const maxOut = Math.min(req.maxOutputTokens, fits);
    if (maxOut < MIN_OUTPUT_TOKENS) throw new LLMError('cancelled', 'budget exhausted');
    const worst = inputCost + maxOut * outRate;
    const res = this.ledger.reserve({ maxCostUsd: worst, model: this.inner.model, taskId: req.taskId });

    let result: GenerationResult;
    try {
      result = await send({ ...req, maxOutputTokens: maxOut });
    } catch (err) {
      const unbilled = err instanceof LLMError && UNBILLED.includes(err.kind);
      this.ledger.settle(res, { ...ZERO, costUsd: unbilled ? 0 : worst, outcome: 'error' });
      throw err;
    }
    this.ledger.settle(res, this.charge(req, result, rates));
    return result;
  }

  private charge(
    req: GenerationRequest,
    result: GenerationResult,
    rates: NonNullable<ReturnType<typeof ratesFor>>,
  ): Charge {
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
    // Retries inside the provider may each have been billed for input; charge them at the input rate.
    const retries = Math.max(0, result.attempts - 1) * u.inputTokens * (rates.inputPerMTok / 1e6);
    return { ...tokens, costUsd: costOf(rates, tokens) + retries, outcome: 'ok' };
  }
}

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
