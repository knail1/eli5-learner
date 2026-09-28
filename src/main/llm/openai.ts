import OpenAI from 'openai';
import type { Settings } from '../config';
import { BaseProvider, type ProviderDeps, type SendContext, type SendResult } from './base';
import type { ChatMessage, GenerationRequest, GenerationResult, LLMProvider, ModelLimits } from './types';

type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
type ChatMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

function mapStop(r: string | null | undefined): GenerationResult['stopReason'] {
  switch (r) {
    case 'stop':
    case 'tool_calls':
      return 'end';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

/** Effort mapping (02 §6): xhigh/max collapse to high. */
function mapEffort(e: NonNullable<GenerationRequest['effort']>): 'low' | 'medium' | 'high' {
  return e === 'xhigh' || e === 'max' ? 'high' : e;
}

/** Text label part before each image part, then the message text (02 §6). */
export function toOpenAIMessage(m: ChatMessage): ChatMessageParam {
  if (m.role === 'assistant') return { role: 'assistant', content: m.text };
  if (!m.images?.length) return { role: 'user', content: m.text };
  const content: ContentPart[] = [];
  for (const img of m.images) {
    content.push({ type: 'text', text: `[Image: ${img.label}]` });
    content.push({
      type: 'image_url',
      image_url: { url: `data:${img.mediaType};base64,${img.data.toString('base64')}`, detail: 'high' },
    });
  }
  content.push({ type: 'text', text: m.text });
  return { role: 'user', content };
}

/**
 * OpenAIProvider (02 §6): Chat Completions via the official SDK, SDK retries off, always streamed
 * with usage, `fetch: llmFetch`, json_schema strict structured output.
 */
export class OpenAIProvider extends BaseProvider implements LLMProvider {
  readonly id = 'openai' as const;
  readonly label = 'OpenAI';

  constructor(settings: Settings, deps: ProviderDeps = {}) {
    super('openai', settings, deps);
  }

  buildParams(req: GenerationRequest, limits: ModelLimits = this.limits): ChatParams {
    const messages: ChatMessageParam[] = [];
    if (req.system.trim() !== '') {
      messages.push(
        limits.systemRole === 'developer'
          ? { role: 'developer', content: req.system }
          : { role: 'system', content: req.system },
      );
    }
    messages.push(...req.messages.map(toOpenAIMessage));
    const params: ChatParams = {
      model: this.model,
      messages,
      max_completion_tokens: Math.min(req.maxOutputTokens, limits.maxOutputTokens),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.temperature !== undefined && limits.supportsTemperature) params.temperature = req.temperature;
    if (req.effort && limits.supportsEffort) params.reasoning_effort = mapEffort(req.effort);
    if (req.jsonSchema) {
      params.response_format = {
        type: 'json_schema',
        json_schema: {
          name: req.jsonSchema.name,
          schema: req.jsonSchema.schema as Record<string, unknown>,
          strict: true,
        },
      };
    }
    return params;
  }

  protected async send(req: GenerationRequest, ctx: SendContext): Promise<SendResult> {
    const client = new OpenAI({ apiKey: ctx.apiKey, fetch: ctx.fetch, maxRetries: 0, timeout: ctx.sdkTimeoutMs });
    const stream = await client.chat.completions.create(this.buildParams(req), { signal: ctx.signal });
    let text = '';
    let refusal = '';
    let finish: string | null | undefined;
    let model = this.model;
    let usage: OpenAI.CompletionUsage | undefined;
    for await (const chunk of stream) {
      ctx.touch();
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta.content) {
        text += delta.content;
        ctx.onDelta?.(delta.content);
      }
      if (delta.refusal) refusal += delta.refusal;
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    const stopReason = refusal ? 'refusal' : mapStop(finish);
    let json: unknown;
    if (req.jsonSchema && stopReason === 'end') {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = undefined;
      }
    }
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      text,
      ...(json !== undefined ? { json } : {}),
      stopReason,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        ...(cached > 0 ? { cachedInputTokens: cached } : {}),
      },
      model,
      provider: 'openai',
    };
  }
}

export function createOpenAIProvider(settings: Settings, deps?: ProviderDeps): LLMProvider {
  return new OpenAIProvider(settings, deps);
}
