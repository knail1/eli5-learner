import Anthropic from '@anthropic-ai/sdk';
import type { Settings } from '../config';
import { BaseProvider, type ProviderDeps, type SendContext, type SendResult } from './base';
import { classifyError } from './retry';
import type {
  ChatMessage,
  GenerationRequest,
  GenerationResult,
  LLMProvider,
  ModelLimits,
  TokenUsage,
  WebSource,
} from './types';

/** Tool-mode system instruction (02 §5 `strict_tool_auto`). */
const TOOL_INSTRUCTION = (name: string): string =>
  `\n\nAnswer only by calling the \`${name}\` tool exactly once with the complete result. Do not write prose.`;

const FORCED_TOOL_REJECTED = /tool_choice/i;
/** A 400 that names web search: the tool is not enabled for this organisation (02 §5). */
const WEB_SEARCH_REJECTED = /web[_ ]?search/i;
/** 02 §5: at most this many `pause_turn` continuations per call. */
export const MAX_PAUSE_CONTINUATIONS = 3;
/** The server web search tool (02 §5); the dynamic-filtering variant, no separate code execution tool. */
export const WEB_SEARCH_TOOL_TYPE = 'web_search_20260209';

/** The full message of a raw SDK error (the classified one is cut to 160 characters). */
function rawMessage(e: unknown): string {
  const m = typeof e === 'object' && e !== null ? (e as { message?: unknown }).message : undefined;
  return typeof m === 'string' ? m : '';
}

/**
 * 02 §5: the pages a response reports, from `web_search_tool_result` blocks whose `content` is a
 * result list (an error object means that search found nothing) and from web citations on text.
 */
export function webSourcesOf(content: readonly Anthropic.ContentBlock[]): WebSource[] {
  const out: WebSource[] = [];
  for (const b of content) {
    if (b.type === 'web_search_tool_result') {
      if (!Array.isArray(b.content)) continue;
      for (const r of b.content) {
        if (r.type === 'web_search_result' && typeof r.url === 'string') {
          out.push({ url: r.url, ...(typeof r.title === 'string' && r.title ? { title: r.title } : {}) });
        }
      }
    } else if (b.type === 'text' && Array.isArray(b.citations)) {
      for (const c of b.citations) {
        if (c.type === 'web_search_result_location' && typeof c.url === 'string') {
          out.push({ url: c.url, ...(c.title ? { title: c.title } : {}) });
        }
      }
    }
  }
  return out;
}

function usageOfMessage(u: Anthropic.Usage): TokenUsage {
  const cached = u.cache_read_input_tokens ?? 0;
  return {
    inputTokens: u.input_tokens + cached + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const cached = (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

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
    // 02 §5: web search only when the model supports it. Its structured output is always the strict
    // tool with auto choice: forced tool_choice is rejected and output_config.format is not safe with it.
    const web = req.webSearch !== undefined && limits.supportsWebSearch;
    const toolMode = schema !== undefined && (web || mode === 'strict_tool_auto' || mode === 'forced_tool');
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
    const tools: Anthropic.ToolUnion[] = [];
    if (toolMode && schema) {
      tools.push({
        name: schema.name,
        description: 'Return the result.',
        input_schema: schema.schema as Anthropic.Tool.InputSchema,
        strict: true,
      });
      params.tool_choice = mode === 'forced_tool' && !web ? { type: 'tool', name: schema.name } : { type: 'auto' };
    }
    if (web && req.webSearch) {
      const tool: Anthropic.WebSearchTool20260209 = {
        type: WEB_SEARCH_TOOL_TYPE,
        name: 'web_search',
        max_uses: Math.max(1, Math.floor(req.webSearch.maxUses)),
      };
      tools.push(tool);
      params.tool_choice ??= { type: 'auto' };
    }
    if (tools.length > 0) params.tools = tools;
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
      // 02 §5: web search not available for this account: resend once without the tool (not a
      // retry); the answer then falls back to the model's own knowledge.
      if (
        req.webSearch &&
        this.limits.supportsWebSearch &&
        err.kind === 'bad_request' &&
        (WEB_SEARCH_REJECTED.test(rawMessage(e)) || WEB_SEARCH_REJECTED.test(err.message))
      ) {
        const { webSearch: _drop, ...plain } = req;
        const r = await this.sendOnce(plain, ctx);
        return { ...r, webSources: [], webSearches: 0 };
      }
      throw err;
    }
  }

  /** One streamed Messages call; touches the idle timer on every event. */
  private async streamMessage(params: Anthropic.MessageStreamParams, ctx: SendContext): Promise<Anthropic.Message> {
    const stream = this.client(ctx).messages.stream(params, { signal: ctx.signal });
    stream.on('streamEvent', (event) => {
      ctx.touch();
      if (ctx.onDelta && event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        ctx.onDelta(event.delta.text);
      }
    });
    return stream.finalMessage();
  }

  private async sendOnce(req: GenerationRequest, ctx: SendContext): Promise<SendResult> {
    const params = this.buildParams(req);
    const toolName = params.tools?.some((t) => 'input_schema' in t) ? req.jsonSchema?.name : undefined;
    const web = params.tools?.some((t) => t.type === WEB_SEARCH_TOOL_TYPE) ?? false;
    // 02 §5: a long server-tool turn stops with pause_turn; the assistant content goes back unchanged
    // and the same request continues, at most MAX_PAUSE_CONTINUATIONS times.
    const content: Anthropic.ContentBlock[] = [];
    let messages = params.messages;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let searches = 0;
    let msg: Anthropic.Message;
    for (let turn = 0; ; turn++) {
      msg = await this.streamMessage({ ...params, messages }, ctx);
      content.push(...msg.content);
      usage = sumUsage(usage, usageOfMessage(msg.usage));
      searches += msg.usage.server_tool_use?.web_search_requests ?? 0;
      if (msg.stop_reason !== 'pause_turn' || turn >= MAX_PAUSE_CONTINUATIONS) break;
      messages = [...messages, { role: 'assistant', content: msg.content }];
    }
    let text = '';
    let json: unknown;
    if (toolName) {
      const call = content.findLast((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === toolName);
      if (call) {
        json = call.input;
        text = JSON.stringify(call.input);
      }
    } else {
      text = content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (req.jsonSchema) json = tryParse(text);
    }
    const stopReason = mapStop(msg.stop_reason);
    return {
      text,
      ...(json !== undefined && stopReason === 'end' ? { json } : {}),
      stopReason,
      usage,
      model: msg.model,
      provider: 'claude',
      ...(web ? { webSources: webSourcesOf(content), webSearches: searches } : {}),
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
