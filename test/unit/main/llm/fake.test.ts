import { describe, expect, it } from 'vitest';
import { LLMError } from '../../../../src/main/llm/errors';
import { FakeProvider, loadFakeScript } from '../../../../src/main/llm/testing/fake';
import type { GenerationRequest, PromptId } from '../../../../src/main/llm/types';

function req(taskId: PromptId, extra: Partial<GenerationRequest> = {}): GenerationRequest {
  return { taskId, system: 'sys!', messages: [{ role: 'user', text: 'abcd' }], maxOutputTokens: 1000, ...extra };
}

async function errOf(p: Promise<unknown>): Promise<LLMError> {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(LLMError);
  return e as LLMError;
}

describe('FakeProvider (13 §6.1)', () => {
  it('returns fixture JSON with ceil(chars/4) usage and parsed json', async () => {
    const body = '{"title":"T"}'; // 13 chars -> 4 tokens
    const fake = new FakeProvider({ responses: { summary: body } });
    const r = await fake.generate(req('summary', { jsonSchema: { name: 'x', schema: {} } }));
    expect(r.text).toBe(body);
    expect(r.json).toEqual({ title: 'T' });
    expect(r.stopReason).toBe('end');
    expect(r.usage).toEqual({ inputTokens: 2, outputTokens: 4 }); // 'sys!'+'abcd' = 8 chars
    expect(r.attempts).toBe(1);
    expect(r.provider).toBe('claude');
  });

  it('serves successive array responses and repeats the last', async () => {
    const fake = new FakeProvider({ responses: { eli5: ['"a"', '"b"'] } });
    const texts = [];
    for (let i = 0; i < 3; i++) texts.push((await fake.generate(req('eli5'))).text);
    expect(texts).toEqual(['"a"', '"b"', '"b"']);
  });

  it('unknown task throws bad_request naming the task', async () => {
    const fake = new FakeProvider({ responses: {} });
    const e = await errOf(fake.generate(req('glossary')));
    expect(e.kind).toBe('bad_request');
    expect(e.message).toContain('glossary');
  });

  it('injects errors per call index', async () => {
    const fake = new FakeProvider({
      responses: { 'in-depth': '{}' },
      errors: { 'in-depth': ['rate_limited', 'server'] },
    });
    expect((await errOf(fake.generate(req('in-depth')))).kind).toBe('rate_limited');
    expect((await errOf(fake.generate(req('in-depth')))).kind).toBe('server');
    expect((await fake.generate(req('in-depth'))).text).toBe('{}');
  });

  it('a single error kind applies to every call, even without a fixture', async () => {
    const fake = new FakeProvider({ responses: {}, errors: { summary: 'auth' } });
    expect((await errOf(fake.generate(req('summary')))).kind).toBe('auth');
    expect((await errOf(fake.generate(req('summary')))).kind).toBe('auth');
  });

  it('simulates max_tokens truncation for truncateTask', async () => {
    const fake = new FakeProvider({ responses: { 'in-depth': '{"a":1234}' }, truncateTask: 'in-depth' });
    const r = await fake.generate(req('in-depth', { jsonSchema: { name: 'x', schema: {} } }));
    expect(r.stopReason).toBe('max_tokens');
    expect(r.text.length).toBeLessThan(10);
    expect(r.json).toBeUndefined();
  });

  it('records calls with image counts and sizes; generate() rejects images', async () => {
    const fake = new FakeProvider({ responses: { eli5: '{}' } });
    const images = [1, 2, 3].map((n) => ({
      mediaType: 'image/png' as const,
      data: Buffer.alloc(n * 10),
      label: `p${n}`,
      sourceRef: 'src',
    }));
    const withImgs = req('eli5', { messages: [{ role: 'user', text: 'clarify: X', images }] });
    expect((await errOf(fake.generate(withImgs))).kind).toBe('bad_request');
    await fake.generateWithImages(withImgs);
    const last = fake.calls.at(-1);
    expect(last).toMatchObject({ taskId: 'eli5', imageCount: 3, imageBytes: [10, 20, 30], withImages: true });
    expect(last?.messages[0]?.text).toContain('clarify: X');
  });

  it('reads path fixtures through the injected reader and loads scripts', async () => {
    const files: Record<string, string> = {
      'script.json': JSON.stringify({ responses: { summary: 'fixtures/summary.json' } }),
      'fixtures/summary.json': '{"summary":"s"}',
    };
    const read = (p: string): string => {
      const v = files[p];
      if (v === undefined) throw new Error(`missing ${p}`);
      return v;
    };
    const fake = new FakeProvider(loadFakeScript('script.json', read), { readFile: read });
    expect((await fake.generate(req('summary'))).text).toBe('{"summary":"s"}');
  });

  it('honours cancellation and testConnection succeeds', async () => {
    const ac = new AbortController();
    ac.abort();
    const fake = new FakeProvider({ responses: { summary: '{}' } });
    expect((await errOf(fake.generate(req('summary', { signal: ac.signal })))).kind).toBe('cancelled');
    await expect(fake.testConnection()).resolves.toEqual({ ok: true, model: 'fake-model' });
  });
});
