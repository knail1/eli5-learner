import { describe, expect, it } from 'vitest';
import { ClaudeProvider } from '../../../../src/main/llm/claude';
import { LLMError } from '../../../../src/main/llm/errors';
import { fallbackLimits, limitsFor } from '../../../../src/main/llm/models';
import { draftJsonSchema } from '../../../../src/main/llm/schemas/draft';
import { generateStructured } from '../../../../src/main/llm/structured';
import type { GenerationRequest, StreamChunk } from '../../../../src/main/llm/types';
import { cassette, fastDeps, settingsFor, TEST_KEY } from './helpers';

const req = (extra: Partial<GenerationRequest> = {}): GenerationRequest => ({
  taskId: 'in-depth',
  system: 'You explain things.',
  messages: [{ role: 'user', text: 'Explain widgets.' }],
  maxOutputTokens: 500_000,
  ...extra,
});

type Body = Record<string, unknown>;

describe('ClaudeProvider (02 §5) against cassettes', () => {
  it('streams text into one GenerationResult with usage and model; ignores thinking blocks', async () => {
    const t = cassette('claude/text.json');
    const p = new ClaudeProvider(settingsFor('claude'), fastDeps(t));
    const r = await p.generate(req({ effort: 'high', temperature: 0.4, cacheSystemPrompt: true }));
    expect(r).toMatchObject({
      text: 'Example Widgets Inc. makes widgets.',
      stopReason: 'end',
      provider: 'claude',
      model: 'claude-opus-5-5',
      attempts: 1,
      usage: { inputTokens: 42, outputTokens: 9 },
    });
    const body = t.requests[0]?.body as Body;
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(128_000); // clamped to the model row
    expect(body.output_config).toEqual({ effort: 'high' });
    expect(body.system).toEqual([{ type: 'text', text: 'You explain things.', cache_control: { type: 'ephemeral' } }]);
    // (b) supportsTemperature false -> no sampling params at all
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
    expect(body).not.toHaveProperty('thinking');
    expect(t.requests[0]?.headers['x-api-key']).toBe(TEST_KEY);
  });

  it('(b) unknown model ids use the fallback row: no temperature, output_config', async () => {
    const t = cassette('claude/structured.json');
    const p = new ClaudeProvider(settingsFor('claude', 'claude-future-9'), fastDeps(t));
    expect(p.limits).toEqual(fallbackLimits('claude'));
    await p.generate(
      req({ temperature: 0.4, jsonSchema: { name: 'summary_draft', schema: draftJsonSchema('SummaryDraft') } }),
    );
    const body = t.requests[0]?.body as Body;
    expect(body).not.toHaveProperty('temperature');
    expect(body.max_tokens).toBe(8_000);
  });

  it('sends temperature only for rows that support it', async () => {
    const t = cassette('claude/text.json');
    const p = new ClaudeProvider(settingsFor('claude', 'claude-haiku-4-5'), fastDeps(t));
    await p.generate(req({ temperature: 0.4, effort: 'high' }));
    const body = t.requests[0]?.body as Body;
    expect(body.temperature).toBe(0.4);
    expect(body).not.toHaveProperty('output_config'); // haiku row: no effort
  });

  it('places labelled images before the text block', async () => {
    const t = cassette('claude/image.json');
    const p = new ClaudeProvider(settingsFor('claude'), fastDeps(t));
    const image = {
      mediaType: 'image/png' as const,
      data: Buffer.from('png-bytes'),
      label: 'diagram.png',
      sourceRef: 'diagram.png',
    };
    const r = await p.generateWithImages(req({ messages: [{ role: 'user', text: 'Describe.', images: [image] }] }));
    expect(r.text).toContain('two boxes');
    const content = ((t.requests[0]?.body as Body).messages as { content: Body[] }[])[0]?.content ?? [];
    expect(content.map((c) => c.type)).toEqual(['text', 'image', 'text']);
    expect(content[1]).toMatchObject({ source: { data: Buffer.from('png-bytes').toString('base64') } });
  });

  it('structured output via output_config.format parses json and reports cached tokens', async () => {
    const t = cassette('claude/structured.json');
    const p = new ClaudeProvider(settingsFor('claude'), fastDeps(t));
    const r = await p.generate(req({ jsonSchema: { name: 'summary_draft', schema: draftJsonSchema('SummaryDraft') } }));
    expect(r.json).toMatchObject({ topicSlugHint: 'widget-supply' });
    expect(r.usage).toEqual({ inputTokens: 500, outputTokens: 40, cachedInputTokens: 200 });
    const body = t.requests[0]?.body as Body;
    expect(body).not.toHaveProperty('output_format');
    expect(body).not.toHaveProperty('tools');
  });

  it('schema rejection then one repair call', async () => {
    const t = cassette('claude/repair.json');
    const p = new ClaudeProvider(settingsFor('claude'), fastDeps(t));
    const r = await generateStructured({
      provider: p,
      schema: 'SummaryDraft',
      request: { taskId: 'summary', system: 's', messages: [{ role: 'user', text: 'x' }], maxOutputTokens: 100 },
    });
    expect(r.repaired).toBe(true);
    expect(r.data.summary).toBe('Now valid.');
    const repairMsgs = (t.requests[1]?.body as Body).messages as { role: string; content: string }[];
    expect(repairMsgs[2]?.content).toContain('topicSlugHint');
    expect(repairMsgs[2]?.content).toContain('Return corrected JSON only.');
    t.assertDone();
  });

  it('(a) forced_tool 400 is bad_request, not retried, and triggers the output_config resend', async () => {
    const t = cassette('claude/forced-tool-fallback.json');
    const deps = fastDeps(t, { limits: { ...fallbackLimits('claude'), structuredMode: 'forced_tool' } });
    const p = new ClaudeProvider(settingsFor('claude', 'claude-legacy-test'), deps);
    const r = await p.generate(req({ jsonSchema: { name: 'summary_draft', schema: draftJsonSchema('SummaryDraft') } }));
    expect(r.json).toMatchObject({ summary: 'Fallback worked.' });
    expect(r.attempts).toBe(1);
    expect(deps.sleeps).toEqual([]);
    expect(p.limits.structuredMode).toBe('output_config');
    t.assertDone();
  });

  it('strict_tool_auto mode reads the tool input as json', async () => {
    const t = cassette('claude/tool-auto.json');
    const p = new ClaudeProvider(
      settingsFor('claude'),
      fastDeps(t, { limits: { ...limitsFor('claude', 'claude-opus-5-5'), structuredMode: 'strict_tool_auto' } }),
    );
    const r = await p.generate(req({ jsonSchema: { name: 'summary_draft', schema: draftJsonSchema('SummaryDraft') } }));
    expect(r.json).toMatchObject({ summary: 'Via strict tool.' });
    expect(r.stopReason).toBe('end');
    expect((t.requests[0]?.body as Body).system).toEqual([
      expect.objectContaining({ text: expect.stringContaining('summary_draft') as unknown }),
    ]);
  });

  it('maps max_tokens and accumulates a raw streamed response; stream() emits deltas', async () => {
    const t = cassette('claude/stream.json');
    const p = new ClaudeProvider(settingsFor('claude'), fastDeps(t));
    const r = await p.generate(req());
    expect(r.text).toBe('Widgets are made in batches.');
    expect(r.stopReason).toBe('max_tokens');
    const chunks: StreamChunk[] = [];
    for await (const c of p.stream(req())) chunks.push(c);
    expect(chunks.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.delta : ''))).toEqual([
      'Widgets ',
      'are made ',
      'in batches.',
    ]);
    expect(chunks.at(-1)?.type).toBe('done');
  });

  it('honours retry-after (max with backoff) and records attempts', async () => {
    const t = cassette('claude/rate-limit-then-ok.json');
    const deps = fastDeps(t);
    const retries: number[] = [];
    const p = new ClaudeProvider(settingsFor('claude'), deps);
    const r = await p.generate(req({ onRetry: (_a, w) => retries.push(w) }));
    expect(r.attempts).toBe(3);
    expect(deps.sleeps).toEqual([45_000, 8_000]); // retry-after 45 s beats 2 s backoff; then 8 s backoff
    expect(retries).toEqual(deps.sleeps);
  });

  it('idle timeout aborts a stalled stream with kind timeout', async () => {
    const t = cassette('claude/stall.json');
    const p = new ClaudeProvider(settingsFor('claude'), fastDeps(t, { timeouts: { idleMs: 30, totalMs: 5_000 } }));
    const e = await p.generate(req()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LLMError);
    expect((e as LLMError).kind).toBe('timeout');
    expect((e as LLMError).message).toContain('idle');
    expect(t.requests.length).toBe(4); // timeout is retried 3 times
  });

  it('missing key is auth at call time; testConnection reports it without throwing', async () => {
    const t = cassette('claude/text.json');
    const p = new ClaudeProvider(settingsFor('claude'), { fetch: t.fetch, getApiKey: () => Promise.resolve(null) });
    await expect(p.generate(req())).rejects.toMatchObject({ kind: 'auth', message: 'No API key set' });
    const c = await p.testConnection();
    expect(c.ok).toBe(false);
    expect(t.requests).toEqual([]);
    const ok = await new ClaudeProvider(settingsFor('claude'), fastDeps(t)).testConnection();
    expect(ok).toEqual({ ok: true, model: 'claude-opus-5-5' });
    expect((t.requests[0]?.body as Body).max_tokens).toBe(16);
  });
});
