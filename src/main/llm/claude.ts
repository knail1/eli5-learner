import Anthropic from '@anthropic-ai/sdk';
import type { Settings } from '../config';
import { BaseProvider, type ProviderDeps, type SendContext, type SendResult } from './base';
import { classifyError } from './retry';
import type { ChatMessage, GenerationRequest, GenerationResult, LLMProvider, ModelLimits } from './types';

/** Tool-mode system instruction (02 §5 `strict_tool_auto`). */
const TOOL_INSTRUCTION = (name: string): string =>
  `\n\nAnswer only by calling the \`${name}\` tool exactly once with the complete result. Do not write prose.`;

const FORCED_TOOL_REJECTED = /tool_choice/i;

function mapStop(r: Anthropic.StopReason | null): GenerationResult['stopReason'] {
  switch (r) {
    case 'end_turn':
    case 'tool_use':
    case 'stop_sequence':
      return 'end';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

/** Images first, each preceded by a `[Image: <label>]` text block, then the message text (02 §5). */
export function toClaudeMessage(m: ChatMessage): Anthropic.MessageParam {
  if (m.role === 'assistant' || !m.images?.length) return { role: m.role, content: m.text };
  const content: Anthropic.ContentBlockParam[] = [];
  for (const img of m.images) {
    content.push({ type: 'text', text: `[Image: ${img.label}]` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data.toString('base64') },
    });
  }
  content.push({ type: 'text', text: m.text });
  return { role: 'user', content };
}

/**
 * ClaudeProvider (02 §5): Messages API via @anthropic-ai/sdk, SDK retries off, always streamed,
 * `fetch: llmFetch`. Structured output per `limits.structuredMode`; forced tool use is a per-model
 * fallback whose 400 switches the model to `output_config` for the session.
 */
export class ClaudeProvider extends BaseProvider implements LLMProvider {
  readonly id = 'claude' as const;
  readonly label = 'Claude';

  constructor(settings: Settings, deps: ProviderDeps = {}) {
    super('claude', settings, deps);
  }

  private client(ctx: Pick<SendContext, 'apiKey' | 'fetch' | 'sdkTimeoutMs'>): Anthropic {
    return new Anthropic({ apiKey: ctx.apiKey, fetch: ctx.fetch, maxRetries: 0, timeout: ctx.sdkTimeoutMs });
  }

  /** Request body for the current limits row; exported through a method for cassette tests. */
  buildParams(req: GenerationRequest, limits: ModelLimits = this.limits): Anthropic.MessageStreamParams {
    const mode = limits.structuredMode;
    const schema = req.jsonSchema;
    const toolMode = schema !== undefined && (mode === 'strict_tool_auto' || mode === 'forced_tool');
    const systemText = req.system + (toolMode && schema ? TOOL_INSTRUCTION(schema.name) : '');
    const outputConfig: Anthropic.OutputConfig = {};
    if (req.effort && limits.supportsEffort) outputConfig.effort = req.effort;
    if (schema && !toolMode)
      outputConfig.format = { type: 'json_schema', schema: schema.schema as Record<string, unknown> };
    const params: Anthropic.MessageStreamParams = {
      model: this.model,
      max_tokens: Math.min(req.maxOutputTokens, limits.maxOutputTokens),
      messages: req.messages.map(toClaudeMessage),
    };
    if (systemText.trim() !== '') {
      params.system = [
        {
          type: 'text',
          text: systemText,
          ...(req.cacheSystemPrompt ? { cache_control: { type: 'ephemeral' as const } } : {}),
        },
      ];
    }
    if (req.temperature !== undefined && limits.supportsTemperature) params.temperature = req.temperature;
    if (Object.keys(outputConfig).length > 0) params.output_config = outputConfig;
    if (toolMode && schema) {
      params.tools = [
        {
          name: schema.name,
          description: 'Return the result.',
          input_schema: schema.schema as Anthropic.Tool.InputSchema,
          strict: true,
        },
      ];
      params.tool_choice = mode === 'forced_tool' ? { type: 'tool', name: schema.name } : { type: 'auto' };
    }
    return params;
  }

  protected async send(req: GenerationRequest, ctx: SendContext): Promise<SendResult> {
    try {
      return await this.sendOnce(req, ctx);
    } catch (e) {
      const err = classifyError(e, this.label);
      // 02 §5: a forced-tool 400 switches this model to output_config and resends once (not a retry).
      if (
        req.jsonSchema &&
        this.limits.structuredMode === 'forced_tool' &&
        err.kind === 'bad_request' &&
        FORCED_TOOL_REJECTED.test(err.message)
      ) {
        this.currentLimits = { ...this.currentLimits, structuredMode: 'output_config' };
        return this.sendOnce(req, ctx);
      }
      throw err;
    }
  }

  private async sendOnce(req: GenerationRequest, ctx: SendContext): Promise<SendResult> {
    const params = this.buildParams(req);
    const toolName = params.tools ? req.jsonSchema?.name : undefined;
    const stream = this.client(ctx).messages.stream(params, { signal: ctx.signal });
    stream.on('streamEvent', (event) => {
      ctx.touch();
      if (ctx.onDelta && event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        ctx.onDelta(event.delta.text);
      }
    });
    const msg = await stream.finalMessage();
    let text = '';
    let json: unknown;
    if (toolName) {
      const call = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === toolName);
      if (call) {
        json = call.input;
        text = JSON.stringify(call.input);
      }
    } else {
      text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (req.jsonSchema) json = tryParse(text);
    }
    const stopReason = mapStop(msg.stop_reason);
    const u = msg.usage;
    const cached = u.cache_read_input_tokens ?? 0;
    return {
      text,
      ...(json !== undefined && stopReason === 'end' ? { json } : {}),
      stopReason,
      usage: {
        inputTokens: u.input_tokens + cached + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens,
        ...(cached > 0 ? { cachedInputTokens: cached } : {}),
      },
      model: msg.model,
      provider: 'claude',
    };
  }

  async countTokens(req: Pick<GenerationRequest, 'system' | 'messages' | 'signal'>): Promise<number> {
    const apiKey = await this.apiKey();
    const fetchImpl = this.resolveFetch();
    return this.limited(async () => {
      const r = await this.client({ apiKey, fetch: fetchImpl, sdkTimeoutMs: 30_000 }).messages.countTokens(
        {
          model: this.model,
          messages: req.messages.map(toClaudeMessage),
          ...(req.system ? { system: req.system } : {}),
        },
        req.signal ? { signal: req.signal } : {},
      );
      return r.input_tokens;
    }, req.signal);
  }
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function createClaudeProvider(settings: Settings, deps?: ProviderDeps): LLMProvider {
  return new ClaudeProvider(settings, deps);
}
