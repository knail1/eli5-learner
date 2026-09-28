import { describe, expect, it } from 'vitest';
import { LLMError } from '../../../../src/main/llm/errors';
import { fallbackLimits } from '../../../../src/main/llm/models';
import { OpenAIProvider } from '../../../../src/main/llm/openai';
import { draftJsonSchema } from '../../../../src/main/llm/schemas/draft';
import { generateStructured } from '../../../../src/main/llm/structured';
import type { GenerationRequest } from '../../../../src/main/llm/types';
import { cassette, fastDeps, settingsFor, TEST_KEY } from './helpers';

const req = (extra: Partial<GenerationRequest> = {}): GenerationRequest => ({
  taskId: 'eli5',
  system: 'You explain things.',
  messages: [{ role: 'user', text: 'Explain widgets.' }],
  maxOutputTokens: 500_000,
  ...extra,
});

type Body = Record<string, unknown>;

describe('OpenAIProvider (02 §6) against cassettes', () => {
  it('(c) reasoning row: developer role, no temperature, reasoning_effort mapped, streamed usage', async () => {
    const t = cassette('openai/text.json');
    const p = new OpenAIProvider(settingsFor('openai'), fastDeps(t));
    const r = await p.generate(req({ temperature: 0.4, effort: 'max' }));
    expect(r).toMatchObject({
      text: 'Example Widgets Inc. makes widgets.',
      stopReason: 'end',
      provider: 'openai',
      model: 'gpt-5-2026-01-01',
      usage: { inputTokens: 42, outputTokens: 9, cachedInputTokens: 10 },
    });
    const body = t.requests[0]?.body as Body;
    expect((body.messages as Body[])[0]).toEqual({ role: 'developer', content: 'You explain things.' });
    expect(body).not.toHaveProperty('temperature');
    expect(body.reasoning_effort).toBe('high');
    expect(body.max_completion_tokens).toBe(128_000);
    expect(t.requests[0]?.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it('unknown reasoning-prefixed ids fall back to developer role; others to system with no temperature', async () => {
    expect(new OpenAIProvider(settingsFor('openai', 'o3-pro-future'), {}).limits.systemRole).toBe('developer');
    const t = cassette('openai/text.json');
    const p = new OpenAIProvider(settingsFor('openai', 'custom-model'), fastDeps(t));
    expect(p.limits).toEqual(fallbackLimits('openai', 'custom-model'));
    await p.generate(req({ temperature: 0.4, effort: 'low' }));
    const body = t.requests[0]?.body as Body;
    expect((body.messages as Body[])[0]?.role).toBe('system');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('chat rows send temperature and the system role', async () => {
    const t = cassette('openai/text.json');
    await new OpenAIProvider(settingsFor('openai', 'gpt-4.1'), fastDeps(t)).generate(req({ temperature: 0.4 }));
    const body = t.requests[0]?.body as Body;
    expect(body.temperature).toBe(0.4);
    expect((body.messages as Body[])[0]?.role).toBe('system');
  });

  it('encodes images as labelled data-URI parts', async () => {
    const t = cassette('openai/image.json');
    const p = new OpenAIProvider(settingsFor('openai'), fastDeps(t));
    const image = {
      mediaType: 'image/png' as const,
      data: Buffer.from('png'),
      label: 'diagram.png',
      sourceRef: 'diagram.png',
    };
    const r = await p.generateWithImages(req({ messages: [{ role: 'user', text: 'Describe.', images: [image] }] }));
    expect(r.text).toContain('two boxes');
    const part = ((t.requests[0]?.body as Body).messages as { content: Body[] }[])[1]?.content[1];
    expect(part).toMatchObject({
      image_url: { url: `data:image/png;base64,${Buffer.from('png').toString('base64')}` },
    });
  });

  it('structured output uses response_format json_schema strict', async () => {
    const t = cassette('openai/structured.json');
    const p = new OpenAIProvider(settingsFor('openai'), fastDeps(t));
    const schema = draftJsonSchema('SummaryDraft');
    const r = await p.generate(req({ jsonSchema: { name: 'summary_draft', schema } }));
    expect(r.json).toMatchObject({ topicSlugHint: 'widget-supply' });
    const rf = (t.requests[0]?.body as Body).response_format as Body;
    expect(rf).toEqual({ type: 'json_schema', json_schema: { name: 'summary_draft', schema, strict: true } });
  });

  it('schema rejection (null for a required field) then one repair', async () => {
    const t = cassette('openai/repair.json');
    const r = await generateStructured({
      provider: new OpenAIProvider(settingsFor('openai'), fastDeps(t)),
      schema: 'SummaryDraft',
      request: { taskId: 'summary', system: 's', messages: [{ role: 'user', text: 'x' }], maxOutputTokens: 100 },
    });
    expect(r).toMatchObject({
      repaired: true,
      data: { summary: 'Now valid.' },
      usage: { inputTokens: 650, outputTokens: 45 },
    });
    t.assertDone();
  });

  it('accumulates a raw stream and maps finish_reason length to max_tokens', async () => {
    const t = cassette('openai/stream.json');
    const r = await new OpenAIProvider(settingsFor('openai'), fastDeps(t)).generate(req());
    expect(r.text).toBe('Widgets are made in batches.');
    expect(r.stopReason).toBe('max_tokens');
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 7 });
  });

  it('maps a refusal delta to stopReason refusal', async () => {
    const t = cassette('openai/refusal.json');
    const r = await new OpenAIProvider(settingsFor('openai'), fastDeps(t)).generate(req());
    expect(r.stopReason).toBe('refusal');
  });

  it('a retry-after beyond the cap ends retrying with rate_limited', async () => {
    const t = cassette('openai/retry-after-cap.json');
    const deps = fastDeps(t);
    const e = await new OpenAIProvider(settingsFor('openai'), deps).generate(req()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LLMError);
    expect((e as LLMError).kind).toBe('rate_limited');
    expect(deps.sleeps).toEqual([]);
    expect(t.requests).toHaveLength(1);
  });
});
