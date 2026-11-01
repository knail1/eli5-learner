import { describe, expect, it } from 'vitest';
import { LLMError } from '../../../../src/main/llm/errors';
import { fallbackLimits } from '../../../../src/main/llm/models';
import { OpenAIProvider } from '../../../../src/main/llm/openai';
import { draftJsonSchema } from '../../../../src/main/llm/schemas/draft';
import { generateStructured } from '../../../../src/main/llm/structured';
import type { GenerationRequest } from '../../../../src/main/llm/types';
import { Limiter } from '../../../../src/main/llm/limiter';
import { DEFAULT_RETRY } from '../../../../src/main/llm/retry';
import { cassette, fastDeps, settingsFor, TEST_KEY } from './helpers';

const req = (extra: Partial<GenerationRequest> = {}): GenerationRequest => ({
  taskId: 'eli5',
  system: 'You explain things.',
  messages: [{ role: 'user', text: 'Explain widgets.' }],
  maxOutputTokens: 500_000,
  ...extra,
});

type Body = Record<string, unknown>;

describe('OpenAIProvider / ChatGPT on the Responses API (02 §6) against cassettes', () => {
  it('(c) reasoning row: instructions, no temperature, reasoning effort mapped, streamed usage, store off', async () => {
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
    expect(t.requests[0]?.path).toBe('/v1/responses');
    const body = t.requests[0]?.body as Body;
    expect(body.instructions).toBe('You explain things.');
    expect(body.input).toEqual([{ role: 'user', content: 'Explain widgets.' }]);
    expect(body).not.toHaveProperty('temperature');
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.max_output_tokens).toBe(128_000);
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(t.requests[0]?.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it('unknown models get fallback limits: no temperature and no reasoning effort', async () => {
    expect(new OpenAIProvider(settingsFor('openai', 'o3-pro-future'), {}).limits.systemRole).toBe('developer');
    const t = cassette('openai/text.json');
    const p = new OpenAIProvider(settingsFor('openai', 'custom-model'), fastDeps(t));
    expect(p.limits).toEqual(fallbackLimits('openai', 'custom-model'));
    await p.generate(req({ temperature: 0.4, effort: 'low' }));
    const body = t.requests[0]?.body as Body;
    expect(body.instructions).toBe('You explain things.');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('reasoning');
  });

  it('chat rows send temperature; the system prompt is always instructions', async () => {
    const t = cassette('openai/text.json');
    await new OpenAIProvider(settingsFor('openai', 'gpt-4.1'), fastDeps(t)).generate(req({ temperature: 0.4 }));
    const body = t.requests[0]?.body as Body;
    expect(body.temperature).toBe(0.4);
    expect(body.instructions).toBe('You explain things.');
  });

  it('an empty system prompt sends no instructions; assistant turns stay in the input', async () => {
    const t = cassette('openai/text.json');
    await new OpenAIProvider(settingsFor('openai'), fastDeps(t)).generate(
      req({
        system: '  ',
        messages: [
          { role: 'user', text: 'a' },
          { role: 'assistant', text: 'b' },
          { role: 'user', text: 'c' },
        ],
      }),
    );
    const body = t.requests[0]?.body as Body;
    expect(body).not.toHaveProperty('instructions');
    expect(body.input).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
  });

  it('encodes images as labelled input_image data-URI parts', async () => {
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
    const content = ((t.requests[0]?.body as Body).input as { content: Body[] }[])[0]?.content;
    expect(content).toEqual([
      { type: 'input_text', text: '[Image: diagram.png]' },
      {
        type: 'input_image',
        image_url: `data:image/png;base64,${Buffer.from('png').toString('base64')}`,
        detail: 'high',
      },
      { type: 'input_text', text: 'Describe.' },
    ]);
  });

  it('structured output uses text.format json_schema strict', async () => {
    const t = cassette('openai/structured.json');
    const p = new OpenAIProvider(settingsFor('openai'), fastDeps(t));
    const schema = draftJsonSchema('SummaryDraft');
    const r = await p.generate(req({ jsonSchema: { name: 'summary_draft', schema } }));
    expect(r.json).toMatchObject({ topicSlugHint: 'widget-supply' });
    const text = (t.requests[0]?.body as Body).text as Body;
    expect(text).toEqual({ format: { type: 'json_schema', name: 'summary_draft', schema, strict: true } });
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

  it('accumulates a raw event stream and maps an incomplete max_output_tokens response to max_tokens', async () => {
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

  it('the provider-wide pause after a 429 is capped at maxRetryAfterMs (02 §7.3)', async () => {
    const t = cassette('openai/retry-after-cap.json');
    const pauses: number[] = [];
    const deps = fastDeps(t, {
      limiter: new Limiter(2, (ms) => {
        pauses.push(ms);
        return Promise.resolve();
      }),
    });
    await new OpenAIProvider(settingsFor('openai'), deps).generate(req()).catch(() => undefined);
    expect(pauses).toEqual([DEFAULT_RETRY.maxRetryAfterMs]);
  });

  it('a mid-stream error event is classified by its code, never shown with the server text', async () => {
    const { kindForStreamCode } = await import('../../../../src/main/llm/openai');
    expect(kindForStreamCode('rate_limit_exceeded')).toBe('rate_limited');
    expect(kindForStreamCode('context_length_exceeded')).toBe('context_overflow');
    expect(kindForStreamCode('invalid_api_key')).toBe('auth');
    expect(kindForStreamCode('server_is_overloaded')).toBe('overloaded');
    expect(kindForStreamCode(null)).toBe('server');
  });
});
