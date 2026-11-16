import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import {
  ClaudeProvider,
  MAX_PAUSE_CONTINUATIONS,
  WEB_SEARCH_TOOL_TYPE,
  webSourcesOf,
} from '../../../../src/main/llm/claude';
import { fallbackLimits, limitsFor, MODEL_LIMITS } from '../../../../src/main/llm/models';
import { OpenAIProvider, webSourcesOfResponse } from '../../../../src/main/llm/openai';
import { draftJsonSchema } from '../../../../src/main/llm/schemas/draft';
import {
  cassetteFetch,
  type Cassette,
  type CassetteInteraction,
  type CassetteSseEvent,
} from '../../../../src/main/llm/testing/cassette';
import { FakeProvider } from '../../../../src/main/llm/testing/fake';
import type { GenerationRequest } from '../../../../src/main/llm/types';
import { BedrockProvider } from '../../../../src/main/llm/bedrock.stub';
import { fastDeps, settingsFor } from './helpers';

/** Provider web search for Ask deeper (02 §3, §5, §6, §16), all offline. */

type Body = Record<string, unknown>;
const schema = { name: 'section_deeper_answer_draft', schema: draftJsonSchema('SectionDeeperAnswerDraft') };
const req = (extra: Partial<GenerationRequest> = {}): GenerationRequest => ({
  taskId: 'section-ask-deeper',
  system: 'You answer questions.',
  messages: [{ role: 'user', text: 'How long do widgets last?' }],
  maxOutputTokens: 3000,
  jsonSchema: schema,
  webSearch: { maxUses: 3 },
  ...extra,
});
const answer = { topic: 'Widget lifetime', paragraphs: ['From the web, about five years.'], reach: 'web', web: [] };

// ---- Claude SSE builders (raw events, so server tool blocks can be replayed) ----

type Block =
  | { type: 'text'; text: string; citations?: unknown[] }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'server_tool_use'; query: string }
  | { type: 'web_search_tool_result'; content: unknown };

function claudeEvents(
  blocks: Block[],
  stop: string,
  usage: { input: number; output: number; searches?: number },
): CassetteSseEvent[] {
  const ev = (event: string, data: Record<string, unknown>): CassetteSseEvent => ({
    event,
    data: { type: event, ...data },
  });
  const out: CassetteSseEvent[] = [
    ev('message_start', {
      message: {
        id: 'msg_web',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input, output_tokens: 1 },
      },
    }),
  ];
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      out.push(
        ev('content_block_start', { index, content_block: { type: 'text', text: '', citations: b.citations ?? null } }),
      );
      out.push(ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } }));
    } else if (b.type === 'tool_use') {
      out.push(
        ev('content_block_start', {
          index,
          content_block: { type: 'tool_use', id: `toolu_${index}`, name: b.name, input: {} },
        }),
      );
      out.push(
        ev('content_block_delta', {
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
        }),
      );
    } else if (b.type === 'server_tool_use') {
      out.push(
        ev('content_block_start', {
          index,
          content_block: { type: 'server_tool_use', id: `srvtoolu_${index}`, name: 'web_search', input: {} },
        }),
      );
      out.push(
        ev('content_block_delta', {
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query: b.query }) },
        }),
      );
    } else {
      out.push(
        ev('content_block_start', {
          index,
          content_block: { type: 'web_search_tool_result', tool_use_id: `srvtoolu_${index - 1}`, content: b.content },
        }),
      );
    }
    out.push(ev('content_block_stop', { index }));
  });
  out.push(
    ev('message_delta', {
      delta: { stop_reason: stop, stop_sequence: null },
      usage: {
        output_tokens: usage.output,
        ...(usage.searches !== undefined ? { server_tool_use: { web_search_requests: usage.searches } } : {}),
      },
    }),
  );
  out.push(ev('message_stop', {}));
  return out;
}

const result = (url: string, title: string): Record<string, unknown> => ({
  type: 'web_search_result',
  url,
  title,
  encrypted_content: 'enc',
  page_age: null,
});

function transport(interactions: CassetteInteraction[]) {
  const c: Cassette = { name: 'web-search', interactions };
  return cassetteFetch(c);
}

const opus = (): ReturnType<typeof limitsFor> => limitsFor('claude', 'claude-opus-5-5');

describe('model rows (02 §3)', () => {
  it('current Claude rows and every OpenAI row support web search; haiku 4.5, unknown ids and Bedrock do not', () => {
    for (const [id, row] of Object.entries(MODEL_LIMITS.claude)) {
      expect(row.supportsWebSearch, id).toBe(id !== 'claude-haiku-4-5');
    }
    for (const row of Object.values(MODEL_LIMITS.openai)) expect(row.supportsWebSearch).toBe(true);
    expect(fallbackLimits('claude').supportsWebSearch).toBe(false);
    expect(fallbackLimits('openai').supportsWebSearch).toBe(false);
    expect(new BedrockProvider().limits.supportsWebSearch).toBe(false);
  });
});

describe('ClaudeProvider web search (02 §5)', () => {
  const provider = (t = transport([]), limits = opus()) =>
    new ClaudeProvider(settingsFor('claude'), fastDeps(t, { limits }));

  it('buildParams adds web_search_20260209 with max_uses and the strict output tool with auto choice', () => {
    const body = provider().buildParams(req()) as unknown as Body;
    const tools = body.tools as Body[];
    expect(tools).toEqual([
      expect.objectContaining({ name: schema.name, strict: true, input_schema: schema.schema }),
      { type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', max_uses: 3 },
    ]);
    expect(WEB_SEARCH_TOOL_TYPE).toBe('web_search_20260209');
    expect(body.tool_choice).toEqual({ type: 'auto' });
    // No output_config.format with web search; no separate code execution tool.
    expect((body.output_config as Body | undefined)?.format).toBeUndefined();
    expect(tools.some((t) => String(t.type ?? '').startsWith('code_execution'))).toBe(false);
    expect(JSON.stringify(body.system)).toContain(schema.name);
  });

  it('uses auto tool choice even on a forced_tool row, and never forces the web tool', () => {
    const p = provider(transport([]), { ...opus(), structuredMode: 'forced_tool' });
    const body = p.buildParams(req()) as unknown as Body;
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  it('sends nothing web-related without supportsWebSearch or without req.webSearch', () => {
    const off = provider(transport([]), { ...opus(), supportsWebSearch: false }).buildParams(req()) as unknown as Body;
    expect(off.tools).toBeUndefined();
    expect((off.output_config as Body).format).toBeDefined();
    const { webSearch: _w, ...plain } = req();
    const none = provider().buildParams(plain) as unknown as Body;
    expect(none.tools).toBeUndefined();
  });

  it('collects webSources and webSearches from one response', async () => {
    const t = transport([
      {
        request: { path: '/v1/messages', match: { tools: [{ name: schema.name }, { type: WEB_SEARCH_TOOL_TYPE }] } },
        response: {
          status: 200,
          sse: claudeEvents(
            [
              { type: 'server_tool_use', query: 'widget lifetime' },
              {
                type: 'web_search_tool_result',
                content: [result('https://example.org/a', 'Page A'), result('https://example.net/b', 'Page B')],
              },
              { type: 'tool_use', name: schema.name, input: answer },
            ],
            'tool_use',
            { input: 100, output: 40, searches: 1 },
          ),
        },
      },
    ]);
    const r = await provider(t).generate(req());
    expect(r.json).toEqual(answer);
    expect(r.stopReason).toBe('end');
    expect(r.webSources).toEqual([
      { url: 'https://example.org/a', title: 'Page A' },
      { url: 'https://example.net/b', title: 'Page B' },
    ]);
    expect(r.webSearches).toBe(1);
    t.assertDone();
  });

  it('an error-object content means no results for that search and never throws', async () => {
    const t = transport([
      {
        request: { path: '/v1/messages' },
        response: {
          status: 200,
          sse: claudeEvents(
            [
              { type: 'server_tool_use', query: 'widget lifetime' },
              {
                type: 'web_search_tool_result',
                content: { type: 'web_search_tool_result_error', error_code: 'unavailable' },
              },
              { type: 'tool_use', name: schema.name, input: { ...answer, reach: 'general' } },
            ],
            'tool_use',
            { input: 100, output: 40, searches: 1 },
          ),
        },
      },
    ]);
    const r = await provider(t).generate(req());
    expect(r.webSources).toEqual([]);
    expect(r.webSearches).toBe(1);
    expect(r.json).toMatchObject({ reach: 'general' });
  });

  it('continues a pause_turn with the assistant content, summing usage and searches', async () => {
    const t = transport([
      {
        request: { path: '/v1/messages', match: { messages: [{ role: 'user' }] } },
        response: {
          status: 200,
          sse: claudeEvents(
            [
              { type: 'server_tool_use', query: 'widget lifetime' },
              { type: 'web_search_tool_result', content: [result('https://example.org/a', 'Page A')] },
            ],
            'pause_turn',
            { input: 100, output: 10, searches: 1 },
          ),
        },
      },
      {
        request: {
          path: '/v1/messages',
          match: {
            messages: [
              { role: 'user' },
              { role: 'assistant', content: [{ type: 'server_tool_use' }, { type: 'web_search_tool_result' }] },
            ],
          },
        },
        response: {
          status: 200,
          sse: claudeEvents(
            [
              { type: 'server_tool_use', query: 'widget wear' },
              { type: 'web_search_tool_result', content: [result('https://example.net/b', 'Page B')] },
              { type: 'tool_use', name: schema.name, input: answer },
            ],
            'tool_use',
            { input: 150, output: 30, searches: 1 },
          ),
        },
      },
    ]);
    const r = await provider(t).generate(req());
    expect(t.requests).toHaveLength(2);
    expect(r.json).toEqual(answer);
    expect(r.usage).toMatchObject({ inputTokens: 250, outputTokens: 40 });
    expect(r.webSearches).toBe(2);
    expect(r.webSources?.map((w) => w.url)).toEqual(['https://example.org/a', 'https://example.net/b']);
    expect(r.attempts).toBe(1);
    t.assertDone();
  });

  it(`stops after ${String(MAX_PAUSE_CONTINUATIONS)} continuations`, async () => {
    const t = transport([
      {
        request: { path: '/v1/messages' },
        repeat: true,
        response: {
          status: 200,
          sse: claudeEvents([{ type: 'server_tool_use', query: 'again' }], 'pause_turn', {
            input: 10,
            output: 1,
            searches: 1,
          }),
        },
      },
    ]);
    const r = await provider(t).generate(req());
    expect(t.requests).toHaveLength(1 + MAX_PAUSE_CONTINUATIONS);
    expect(r.stopReason).toBe('other');
    expect(r.json).toBeUndefined();
    expect(r.webSearches).toBe(1 + MAX_PAUSE_CONTINUATIONS);
  });

  it('a 400 naming web search resends once without the tool and reports no searches', async () => {
    const t = transport([
      {
        request: { path: '/v1/messages', match: { tools: [{ name: schema.name }, { type: WEB_SEARCH_TOOL_TYPE }] } },
        response: {
          status: 400,
          body: {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'tools.1: the web_search tool is not enabled for this organization',
            },
          },
        },
      },
      {
        request: { path: '/v1/messages' },
        response: {
          status: 200,
          sse: claudeEvents([{ type: 'text', text: JSON.stringify({ ...answer, reach: 'general' }) }], 'end_turn', {
            input: 90,
            output: 20,
          }),
        },
      },
    ]);
    const deps = fastDeps(t, { limits: opus() });
    const r = await new ClaudeProvider(settingsFor('claude'), deps).generate(req());
    expect(t.requests).toHaveLength(2);
    const second = t.requests[1]?.body as Body;
    expect(second.tools).toBeUndefined();
    expect((second.output_config as Body).format).toBeDefined();
    expect(r.json).toMatchObject({ reach: 'general' });
    expect(r.webSearches).toBe(0);
    expect(r.webSources).toEqual([]);
    expect(deps.sleeps).toEqual([]); // not a retry
    t.assertDone();
  });

  it('another 400 is not a web search fallback', async () => {
    const t = transport([
      {
        request: { path: '/v1/messages' },
        response: {
          status: 400,
          body: { type: 'error', error: { type: 'invalid_request_error', message: 'messages: roles must alternate' } },
        },
      },
    ]);
    await expect(provider(t).generate(req())).rejects.toMatchObject({ kind: 'bad_request' });
    expect(t.requests).toHaveLength(1);
  });

  it('webSourcesOf also reads web citations on text blocks and skips other citations', () => {
    const blocks = [
      {
        type: 'text',
        text: 'x',
        citations: [
          {
            type: 'web_search_result_location',
            url: 'https://example.org/c',
            title: 'Page C',
            cited_text: 'x',
            encrypted_index: 'e',
          },
          {
            type: 'char_location',
            cited_text: 'y',
            document_index: 0,
            document_title: null,
            start_char_index: 0,
            end_char_index: 1,
            file_id: null,
          },
        ],
      },
    ] as unknown as Anthropic.ContentBlock[];
    expect(webSourcesOf(blocks)).toEqual([{ url: 'https://example.org/c', title: 'Page C' }]);
  });
});

describe('OpenAIProvider web search (02 §6)', () => {
  const p = (t = transport([]), limits = limitsFor('openai', 'gpt-5')) =>
    new OpenAIProvider(settingsFor('openai'), fastDeps(t, { limits }));

  it('buildParams adds the web_search tool and the sources include; text.format stays strict', () => {
    const body = p().buildParams(req()) as unknown as Body;
    expect(body.tools).toEqual([{ type: 'web_search' }]);
    expect(body.include).toEqual(['web_search_call.action.sources']);
    expect((body.text as { format: Body }).format).toMatchObject({ type: 'json_schema', strict: true });
  });

  it('sends no tool without supportsWebSearch or without req.webSearch', () => {
    const off = p(transport([]), { ...limitsFor('openai', 'gpt-5'), supportsWebSearch: false }).buildParams(
      req(),
    ) as unknown as Body;
    expect(off.tools).toBeUndefined();
    expect(off.include).toBeUndefined();
    const { webSearch: _w, ...plain } = req();
    expect((p().buildParams(plain) as unknown as Body).tools).toBeUndefined();
  });

  const output = [
    {
      type: 'web_search_call',
      id: 'ws_1',
      status: 'completed',
      action: {
        type: 'search',
        query: 'widget lifetime',
        sources: [
          { type: 'url', url: 'https://example.org/a' },
          { type: 'url', url: 'https://example.net/b' },
        ],
      },
    },
    {
      type: 'web_search_call',
      id: 'ws_2',
      status: 'completed',
      action: { type: 'open_page', url: 'https://example.org/a' },
    },
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: JSON.stringify(answer),
          annotations: [
            { type: 'url_citation', url: 'https://example.com/c', title: 'Page C', start_index: 0, end_index: 1 },
          ],
        },
      ],
    },
  ];

  it('webSourcesOfResponse reads search sources and url citations; counts searches only', () => {
    const r = webSourcesOfResponse({ output } as unknown as OpenAI.Responses.Response);
    expect(r.sources).toEqual([
      { url: 'https://example.org/a' },
      { url: 'https://example.net/b' },
      { url: 'https://example.com/c', title: 'Page C' },
    ]);
    expect(r.searches).toBe(1);
    expect(webSourcesOfResponse(undefined)).toEqual({ sources: [], searches: 0 });
  });

  it('a streamed response reports webSources and webSearches', async () => {
    const text = JSON.stringify(answer);
    const base = { id: 'resp_web', object: 'response', created_at: 1_700_000_000, model: 'gpt-5' };
    const t = transport([
      {
        request: { path: '/v1/responses', match: { tools: [{ type: 'web_search' }] } },
        response: {
          status: 200,
          sse: [
            {
              event: 'response.created',
              data: {
                type: 'response.created',
                sequence_number: 0,
                response: { ...base, status: 'in_progress', output: [] },
              },
            },
            {
              event: 'response.output_text.delta',
              data: {
                type: 'response.output_text.delta',
                sequence_number: 1,
                item_id: 'msg_1',
                output_index: 2,
                content_index: 0,
                delta: text,
              },
            },
            {
              event: 'response.completed',
              data: {
                type: 'response.completed',
                sequence_number: 2,
                response: {
                  ...base,
                  status: 'completed',
                  output,
                  usage: {
                    input_tokens: 50,
                    output_tokens: 20,
                    total_tokens: 70,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens_details: { reasoning_tokens: 0 },
                  },
                },
              },
            },
          ],
        },
      },
    ]);
    const r = await p(t).generate(req());
    expect(r.json).toEqual(answer);
    expect(r.webSearches).toBe(1);
    expect(r.webSources?.map((w) => w.url)).toEqual([
      'https://example.org/a',
      'https://example.net/b',
      'https://example.com/c',
    ]);
    t.assertDone();
  });
});

describe('FakeProvider web search (02 §16)', () => {
  it('reports the scripted pages and one search only for webSearch requests', async () => {
    const fake = new FakeProvider({
      responses: { 'section-ask-deeper': answer },
      webSources: [{ url: 'https://example.org/a', title: 'A' }],
    });
    expect(fake.limits.supportsWebSearch).toBe(true);
    const on = await fake.generate(req());
    expect(on.webSources).toEqual([{ url: 'https://example.org/a', title: 'A' }]);
    expect(on.webSearches).toBe(1);
    expect(fake.calls[0]?.webSearch).toEqual({ maxUses: 3 });
    const { webSearch: _w, ...plain } = req();
    const off = await fake.generate(plain);
    expect(off.webSources).toBeUndefined();
    expect(off.webSearches).toBeUndefined();
    expect(new FakeProvider({ responses: {} }).limits.supportsWebSearch).toBe(false);
  });
});
