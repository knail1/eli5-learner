import OpenAI from 'openai';
import type { Settings } from '../config';
import { BaseProvider, type ProviderDeps, type SendContext, type SendResult } from './base';
import { LLMError } from './errors';
import { humanMessage } from './retry';
import type {
  ChatMessage,
  GenerationRequest,
  GenerationResult,
  LLMErrorKind,
  LLMProvider,
  ModelLimits,
  WebSource,
} from './types';

type ResponseParams = OpenAI.Responses.ResponseCreateParamsStreaming;
type InputItem = OpenAI.Responses.ResponseInputItem;
type InputContent = OpenAI.Responses.ResponseInputContent;
type ResponseObject = OpenAI.Responses.Response;

/** Effort mapping (02 §6): xhigh/max collapse to high, the highest every reasoning model accepts. */
function mapEffort(e: NonNullable<GenerationRequest['effort']>): 'low' | 'medium' | 'high' {
  return e === 'xhigh' || e === 'max' ? 'high' : e;
}

/** A mid-stream `error` event's code (not an HTTP status), mapped to the shared error kinds. */
export function kindForStreamCode(code: string | null | undefined): LLMErrorKind {
  const c = (code ?? '').toLowerCase();
  if (c === 'invalid_api_key' || c === 'unauthorized') return 'auth';
  if (c.includes('rate_limit')) return 'rate_limited';
  if (c === 'insufficient_quota') return 'rate_limited';
  if (c.includes('context_length') || c.includes('too_large')) return 'context_overflow';
  if (c === 'server_is_overloaded' || c === 'overloaded') return 'overloaded';
  if (c === 'invalid_request_error' || c.startsWith('invalid_')) return 'bad_request';
  return 'server';
}

/** A finished (or cut-short) response's status, mapped to the shared stop reasons. */
function mapStop(r: ResponseObject | undefined): GenerationResult['stopReason'] {
  if (!r) return 'other';
  if (r.status === 'completed') return 'end';
  if (r.status === 'incomplete') {
    const why = r.incomplete_details?.reason;
    if (why === 'max_output_tokens') return 'max_tokens';
    if (why === 'content_filter') return 'refusal';
  }
  return 'other';
}

/**
 * 02 §6: the pages a response reports, from `web_search_call` items with a `search` action
 * (`action.sources`, requested with `include`) and from `url_citation` annotations on output text;
 * `searches` counts the search actions.
 */
export function webSourcesOfResponse(r: ResponseObject | undefined): { sources: WebSource[]; searches: number } {
  const sources: WebSource[] = [];
  let searches = 0;
  for (const item of r?.output ?? []) {
    if (item.type === 'web_search_call') {
      if (item.action.type !== 'search') continue;
      searches++;
      for (const src of item.action.sources ?? []) if (typeof src.url === 'string') sources.push({ url: src.url });
    } else if (item.type === 'message') {
      for (const part of item.content) {
        if (part.type !== 'output_text') continue;
        for (const a of part.annotations) {
          if (a.type === 'url_citation' && typeof a.url === 'string') {
            sources.push({ url: a.url, ...(a.title ? { title: a.title } : {}) });
          }
        }
      }
    }
  }
  return { sources, searches };
}

/** Text label part before each image part, then the message text (02 §6). */
export function toOpenAIInput(m: ChatMessage): InputItem {
  if (m.role === 'assistant') return { role: 'assistant', content: m.text };
  if (!m.images?.length) return { role: 'user', content: m.text };
  const content: InputContent[] = [];
  for (const img of m.images) {
    content.push({ type: 'input_text', text: `[Image: ${img.label}]` });
    content.push({
      type: 'input_image',
      image_url: `data:${img.mediaType};base64,${img.data.toString('base64')}`,
      detail: 'high',
    });
  }
  content.push({ type: 'input_text', text: m.text });
  return { role: 'user', content };
}

/**
 * OpenAIProvider, shown as ChatGPT (02 §6): the Responses API (`POST /v1/responses`) via the
 * official SDK, SDK retries off, always streamed, `fetch: llmFetch`. The system prompt goes in
 * `instructions`; structured output is `text.format` json_schema strict; `store: false` keeps
 * prompts and sources off OpenAI's stored-response history.
 */
export class OpenAIProvider extends BaseProvider implements LLMProvider {
  readonly id = 'openai' as const;
  readonly label = 'OpenAI';

  constructor(settings: Settings, deps: ProviderDeps = {}) {
    super('openai', settings, deps);
  }

  buildParams(req: GenerationRequest, limits: ModelLimits = this.limits): ResponseParams {
    const params: ResponseParams = {
      model: this.model,
      input: req.messages.map(toOpenAIInput),
      max_output_tokens: Math.min(req.maxOutputTokens, limits.maxOutputTokens),
      stream: true,
      store: false,
    };
    if (req.system.trim() !== '') params.instructions = req.system;
    if (req.temperature !== undefined && limits.supportsTemperature) params.temperature = req.temperature;
    if (req.effort && limits.supportsEffort) params.reasoning = { effort: mapEffort(req.effort) };
    if (req.jsonSchema) {
      params.text = {
        format: {
          type: 'json_schema',
          name: req.jsonSchema.name,
          schema: req.jsonSchema.schema as Record<string, unknown>,
          strict: true,
        },
      };
    }
    // 02 §6: the Responses API's own web search; `include` asks for the sources of each search.
    if (req.webSearch && limits.supportsWebSearch) {
      params.tools = [{ type: 'web_search' }];
      params.include = ['web_search_call.action.sources'];
    }
    return params;
  }

  protected async send(req: GenerationRequest, ctx: SendContext): Promise<SendResult> {
    const client = new OpenAI({ apiKey: ctx.apiKey, fetch: ctx.fetch, maxRetries: 0, timeout: ctx.sdkTimeoutMs });
    const params = this.buildParams(req);
    const web = params.tools !== undefined;
    const stream = await client.responses.create(params, { signal: ctx.signal });
    let text = '';
    let refusal = '';
    let final: ResponseObject | undefined;
    for await (const event of stream) {
      ctx.touch();
      switch (event.type) {
        case 'response.output_text.delta':
          text += event.delta;
          ctx.onDelta?.(event.delta);
          break;
        case 'response.refusal.delta':
          refusal += event.delta;
          break;
        case 'response.completed':
        case 'response.incomplete':
          final = event.response;
          break;
        case 'response.failed': {
          // Failed after the stream started: classified by its code; the server's text is never shown.
          const kind = kindForStreamCode(event.response.error?.code);
          throw new LLMError(kind, humanMessage(kind, this.label), undefined, undefined, event);
        }
        case 'error': {
          const kind = kindForStreamCode(event.code);
          throw new LLMError(kind, humanMessage(kind, this.label), undefined, undefined, event);
        }
        default:
          break;
      }
    }
    const stopReason = refusal ? 'refusal' : mapStop(final);
    let json: unknown;
    if (req.jsonSchema && stopReason === 'end') {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = undefined;
      }
    }
    const found = web ? webSourcesOfResponse(final) : undefined;
    const usage = final?.usage;
    const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
    return {
      text,
      ...(json !== undefined ? { json } : {}),
      stopReason,
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        ...(cached > 0 ? { cachedInputTokens: cached } : {}),
      },
      model: final?.model ?? this.model,
      provider: 'openai',
      ...(found ? { webSources: found.sources, webSearches: found.searches } : {}),
    };
  }
}

export function createOpenAIProvider(settings: Settings, deps?: ProviderDeps): LLMProvider {
  return new OpenAIProvider(settings, deps);
}
