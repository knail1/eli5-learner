import { account, effectiveModel, type ProviderId, type Settings } from '../config';
import { log } from '../security';
import { LLMError } from './errors';
import { Limiter, type LimiterPriority } from './limiter';
import { limitsFor } from './models';
import { classifyError, DEFAULT_RETRY, humanMessage, withRetry, type RetryPolicy } from './retry';
import { llmRuntime } from './runtime';
import { DEFAULT_TIMEOUTS, TEST_CONNECTION_TIMEOUT_MS, withTimeouts, type TimeoutOptions } from './timeouts';
import type {
  ConnectionCheck,
  GenerationRequest,
  GenerationResult,
  LLMProvider,
  ModelLimits,
  StreamChunk,
} from './types';

/** Injected collaborators; anything omitted comes from `llmRuntime()` (runtime.ts). */
export interface ProviderDeps {
  /** Returns the API key or null; read on every call so key changes apply without restart. */
  getApiKey?: () => Promise<string | null>;
  fetch?: typeof fetch;
  retry?: RetryPolicy;
  timeouts?: Partial<TimeoutOptions>;
  limiter?: Limiter;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Override the limits row (tests, enterprise model tables). */
  limits?: ModelLimits;
}

/** What one provider round trip yields; the base adds attempts and latency. */
export type SendResult = Omit<GenerationResult, 'attempts' | 'latencyMs'>;

export interface SendContext {
  signal: AbortSignal;
  touch: () => void;
  apiKey: string;
  fetch: typeof fetch;
  /** Total-cap for the SDK's own timeout, so ours always fires first. */
  sdkTimeoutMs: number;
  onDelta?: (text: string) => void;
}

const interactive = (req: GenerationRequest): LimiterPriority =>
  req.taskId.startsWith('section-') ? 'interactive' : 'normal';

/**
 * Shared LLMProvider behaviour (02 §3, §7): image intent check, key lookup, limiter, idle/total
 * timeouts, the single retry policy, and content-free logging (02 §15).
 */
export abstract class BaseProvider implements LLMProvider {
  abstract readonly id: ProviderId;
  abstract readonly label: string;
  readonly model: string;
  protected currentLimits: ModelLimits;
  protected readonly limiter: Limiter;
  private readonly timeouts: TimeoutOptions;

  constructor(
    provider: Exclude<ProviderId, 'bedrock'>,
    protected readonly settings: Settings,
    protected readonly deps: ProviderDeps = {},
  ) {
    this.model = effectiveModel({ ...settings, llm: { ...settings.llm, provider } });
    this.currentLimits = deps.limits ? { ...deps.limits } : limitsFor(provider, this.model);
    this.limiter =
      deps.limiter ??
      new Limiter(settings.llm.maxConcurrency, deps.sleep ? (ms) => deps.sleep?.(ms) ?? Promise.resolve() : undefined);
    const rt = llmRuntime();
    this.timeouts = {
      ...DEFAULT_TIMEOUTS,
      totalMs: settings.llm.timeoutMs,
      ...rt.timeouts,
      ...deps.timeouts,
    };
  }

  get limits(): ModelLimits {
    return this.currentLimits;
  }

  protected abstract send(req: GenerationRequest, ctx: SendContext): Promise<SendResult>;

  generate(req: GenerationRequest): Promise<GenerationResult> {
    if (req.messages.some((m) => (m.images?.length ?? 0) > 0)) {
      return Promise.reject(new LLMError('bad_request', 'generate() does not accept images; use generateWithImages()'));
    }
    return this.execute(req);
  }

  generateWithImages(req: GenerationRequest): Promise<GenerationResult> {
    return this.execute(req);
  }

  async *stream(req: GenerationRequest): AsyncIterable<StreamChunk> {
    const queue: StreamChunk[] = [];
    let wake: (() => void) | undefined;
    let failure: unknown;
    let finished = false;
    const push = (c: StreamChunk): void => {
      queue.push(c);
      wake?.();
    };
    // One attempt only: deltas already emitted cannot be taken back by a retry.
    void this.execute(req, (delta) => push({ type: 'text', delta }), { ...DEFAULT_RETRY, maxRetries: 0 })
      .then((result) => push({ type: 'done', result }))
      .catch((e: unknown) => {
        failure = e;
      })
      .finally(() => {
        finished = true;
        wake?.();
      });
    for (;;) {
      const next = queue.shift();
      if (next) {
        yield next;
        if (next.type === 'done') return;
        continue;
      }
      if (finished) {
        if (failure !== undefined) throw failure;
        return;
      }
      await new Promise<void>((r) => (wake = r));
      wake = undefined;
    }
  }

  async testConnection(): Promise<ConnectionCheck> {
    try {
      const r = await this.execute(
        {
          taskId: 'summary',
          system: 'Connection test.',
          messages: [{ role: 'user', text: 'Reply with OK.' }],
          maxOutputTokens: 16,
          timeoutMs: TEST_CONNECTION_TIMEOUT_MS,
        },
        undefined,
        { ...DEFAULT_RETRY, maxRetries: 0 },
      );
      return { ok: true, model: r.model };
    } catch (e) {
      return { ok: false, error: classifyError(e, this.label) };
    }
  }

  protected async apiKey(): Promise<string> {
    const get =
      this.deps.getApiKey ??
      (async (): Promise<string | null> => {
        const keys = llmRuntime().keys;
        return keys ? keys.get(account(this.id === 'openai' ? 'openai' : 'claude')) : null;
      });
    const key = await get();
    if (!key) throw new LLMError('auth', 'No API key set');
    return key;
  }

  protected resolveFetch(): typeof fetch {
    const f = this.deps.fetch ?? llmRuntime().fetch;
    if (!f) throw new LLMError('not_available', 'LLM network path is not initialised');
    return f;
  }

  private checkImages(req: GenerationRequest): void {
    const images = req.messages.flatMap((m) => m.images ?? []);
    if (images.length === 0) return;
    if (!this.limits.supportsImages) throw new LLMError('bad_request', 'The selected model does not accept images');
    if (images.length > this.limits.maxImagesPerRequest) {
      throw new LLMError('bad_request', `Too many images for one request (${images.length})`);
    }
  }

  private async execute(
    req: GenerationRequest,
    onDelta?: (text: string) => void,
    retryOverride?: RetryPolicy,
  ): Promise<GenerationResult> {
    const started = Date.now();
    const fields = { taskId: req.taskId, provider: this.id, model: this.model };
    try {
      this.checkImages(req);
      const apiKey = await this.apiKey();
      const fetchImpl = this.resolveFetch();
      const timeouts: TimeoutOptions = { ...this.timeouts, ...(req.timeoutMs ? { totalMs: req.timeoutMs } : {}) };
      const policy = retryOverride ?? this.deps.retry ?? llmRuntime().retry ?? DEFAULT_RETRY;
      const classify = (e: unknown): LLMError => classifyError(e, this.label);
      const { value, attempts } = await withRetry(
        () =>
          this.limiter.run(
            async () => {
              try {
                return await withTimeouts(req.signal, timeouts, ({ signal, touch }) =>
                  this.send(req, {
                    signal,
                    touch,
                    apiKey,
                    fetch: fetchImpl,
                    sdkTimeoutMs: timeouts.totalMs + 60_000,
                    ...(onDelta ? { onDelta } : {}),
                  }),
                );
              } catch (e) {
                const err = classify(e);
                if (err.kind === 'rate_limited') this.limiter.pauseFor(err.retryAfterMs ?? policy.backoffMs[0] ?? 0);
                throw err;
              }
            },
            interactive(req),
            req.signal,
          ),
        policy,
        {
          ...(req.signal ? { signal: req.signal } : {}),
          ...(req.onRetry ? { onRetry: req.onRetry } : {}),
          ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
          ...(this.deps.random ? { random: this.deps.random } : {}),
        },
        classify,
      );
      const result: GenerationResult = { ...value, latencyMs: Date.now() - started, attempts };
      log.info('llm.call', {
        ...fields,
        attempts,
        latencyMs: result.latencyMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        stopReason: result.stopReason,
      });
      return result;
    } catch (e) {
      const err = req.signal?.aborted ? new LLMError('cancelled', 'Request cancelled') : classifyError(e, this.label);
      log.warn('llm.error', { ...fields, errorKind: err.kind, latencyMs: Date.now() - started });
      throw err;
    }
  }

  /** Short human message for a kind, with this provider's label. */
  protected human(kind: Parameters<typeof humanMessage>[0]): string {
    return humanMessage(kind, this.label);
  }
}
