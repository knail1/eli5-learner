import type { ProviderId } from '../../config';
import { LLMError } from '../errors';
import { fallbackLimits } from '../models';
import type {
  ChatMessage,
  ConnectionCheck,
  GenerationRequest,
  GenerationResult,
  LLMErrorKind,
  LLMProvider,
  ModelLimits,
  PromptId,
  StreamChunk,
} from '../types';

/** Test-only scripted provider (13 §6.1, 02 §16). Never registered in package builds. */
/** Inline JSON text, a fixture path read via `readFile`, or an inline JSON object. */
export type FakeResponse = string | { [key: string]: unknown };

export interface FakeScript {
  /** Responses keyed by PromptId; an array lists successive calls (the last one repeats). */
  responses: Partial<Record<PromptId, FakeResponse | FakeResponse[]>>;
  /** Inject per task; a single kind applies to every call, an array applies per call index. */
  errors?: Partial<Record<PromptId, LLMErrorKind | LLMErrorKind[]>>;
  latencyMs?: number; // default 0
  truncateTask?: PromptId; // simulate max_tokens truncation for one task
}

export interface FakeCall {
  taskId: PromptId;
  system: string;
  messages: ChatMessage[];
  imageCount: number;
  imageBytes: number[];
  withImages: boolean;
}

export interface FakeProviderOptions {
  /** Provider id to impersonate (the fake replaces the active llm.provider, 13 §6.1). */
  id?: ProviderId;
  model?: string;
  limits?: ModelLimits;
  /** Reads fixture files for non-inline responses; paths are passed through unchanged. */
  readFile?: (path: string) => string;
}

const tokens = (chars: number): number => Math.ceil(chars / 4);

function looksInline(s: string): boolean {
  const t = s.trimStart();
  return t.startsWith('{') || t.startsWith('[') || t.startsWith('"');
}

/** Parse a FakeScript JSON file through an injected reader (ELI5_LLM_FAKE_SCRIPT, 13 §6.1). */
export function loadFakeScript(path: string, readFile: (path: string) => string): FakeScript {
  const parsed: unknown = JSON.parse(readFile(path));
  if (typeof parsed !== 'object' || parsed === null || !('responses' in parsed)) {
    throw new Error(`Fake LLM script ${path} has no "responses" object`);
  }
  return parsed as FakeScript;
}

export class FakeProvider implements LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  readonly limits: ModelLimits;
  /** Every request, in order (13 §6.1 step 4). */
  readonly calls: FakeCall[] = [];
  private readonly callIndex = new Map<PromptId, number>();
  private readonly readFile: ((path: string) => string) | undefined;

  constructor(
    private readonly script: FakeScript,
    opts: FakeProviderOptions = {},
  ) {
    this.id = opts.id ?? 'claude';
    this.model = opts.model ?? 'fake-model';
    this.limits = opts.limits ?? fallbackLimits(this.id);
    this.readFile = opts.readFile;
  }

  generate(req: GenerationRequest): Promise<GenerationResult> {
    return this.send(req, false);
  }

  generateWithImages(req: GenerationRequest): Promise<GenerationResult> {
    return this.send(req, true);
  }

  async *stream(req: GenerationRequest): AsyncIterable<StreamChunk> {
    const result = await this.send(req, true);
    yield { type: 'text', delta: result.text };
    yield { type: 'done', result };
  }

  countTokens(req: Pick<GenerationRequest, 'system' | 'messages'>): Promise<number> {
    return Promise.resolve(tokens(inputChars(req)));
  }

  /** Real providers test with a tiny "summary" call; a scripted "summary" error fails the test too. */
  testConnection(): Promise<ConnectionCheck> {
    const spec = this.script.errors?.summary;
    const kind = Array.isArray(spec) ? spec[0] : spec;
    if (kind !== undefined)
      return Promise.resolve({ ok: false, error: new LLMError(kind, `FakeProvider injected ${kind}`) });
    return Promise.resolve({ ok: true, model: this.model });
  }

  private async send(req: GenerationRequest, withImages: boolean): Promise<GenerationResult> {
    const started = Date.now();
    const images = req.messages.flatMap((m) => m.images ?? []);
    if (!withImages && images.length > 0) {
      throw new LLMError('bad_request', 'generate() does not accept images; use generateWithImages()');
    }
    const taskId = req.taskId;
    const index = this.callIndex.get(taskId) ?? 0;
    this.callIndex.set(taskId, index + 1);
    this.calls.push({
      taskId,
      system: req.system,
      messages: req.messages,
      imageCount: images.length,
      imageBytes: images.map((i) => i.data.byteLength),
      withImages,
    });

    // 1. Unknown task fails loudly.
    const response = this.script.responses[taskId];
    const errorSpec = this.script.errors?.[taskId];
    if (response === undefined && errorSpec === undefined) {
      throw new LLMError('bad_request', `FakeProvider has no fixture for task "${taskId}"`);
    }

    if ((this.script.latencyMs ?? 0) > 0) await delay(this.script.latencyMs ?? 0, req.signal);
    if (req.signal?.aborted) throw new LLMError('cancelled', 'Request cancelled');

    // 2. Injected error for this call index.
    const kind = Array.isArray(errorSpec) ? errorSpec[index] : errorSpec;
    if (kind !== undefined) throw new LLMError(kind, `FakeProvider injected ${kind} for "${taskId}" (call ${index})`);

    if (response === undefined) {
      throw new LLMError('bad_request', `FakeProvider has no response for task "${taskId}" call ${index}`);
    }
    // 3. Fixture as GenerationResult; arrays repeat their last entry once exhausted.
    const raw = Array.isArray(response) ? response[Math.min(index, response.length - 1)] : response;
    if (raw === undefined) throw new LLMError('bad_request', `FakeProvider response list for "${taskId}" is empty`);
    let text = this.resolve(raw, taskId);
    let stopReason: GenerationResult['stopReason'] = 'end';
    if (this.script.truncateTask === taskId) {
      text = text.slice(0, Math.floor(text.length / 2));
      stopReason = 'max_tokens';
    }
    let json: unknown;
    if (req.jsonSchema && stopReason === 'end') {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return {
      text,
      ...(json !== undefined ? { json } : {}),
      stopReason,
      usage: { inputTokens: tokens(inputChars(req)), outputTokens: tokens(text.length) },
      model: this.model,
      provider: this.id,
      latencyMs: Date.now() - started,
      attempts: 1,
    };
  }

  private resolve(raw: FakeResponse, taskId: PromptId): string {
    if (typeof raw !== 'string') return JSON.stringify(raw);
    if (looksInline(raw)) return raw;
    if (!this.readFile) {
      throw new LLMError('bad_request', `FakeProvider fixture for "${taskId}" is a path but no readFile was given`);
    }
    return this.readFile(raw);
  }
}

function inputChars(req: Pick<GenerationRequest, 'system' | 'messages'>): number {
  return req.messages.reduce((n, m) => n + m.text.length, req.system.length);
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new LLMError('cancelled', 'Request cancelled'));
      },
      { once: true },
    );
  });
}
