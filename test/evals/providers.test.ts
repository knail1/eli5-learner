import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BudgetLedger } from '../../src/main/devtools';
import type { GenerationRequest } from '../../src/main/llm';
import { FakeProvider } from '../../src/main/llm/testing/fake';
import { EVAL_RETRY, JUDGE_TASK_ID, RecordingProvider, guard, judgeFnFor } from './lib/providers';

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'eli5-evalprov-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const req = (taskId: GenerationRequest['taskId'], text: string, images = 0): GenerationRequest => ({
  taskId,
  system: 'sys',
  messages: [
    {
      role: 'user',
      text,
      ...(images
        ? {
            images: Array.from({ length: images }, (_, i) => ({
              mediaType: 'image/png' as const,
              data: Buffer.from([i]),
              label: `img-${i}`,
              sourceRef: 'x.png',
            })),
          }
        : {}),
    },
  ],
  maxOutputTokens: 4096,
});

describe('budget guard for evals (13 §9.6 via src/main/devtools)', () => {
  it('refuses an unpriced model unless ELI5_EVAL_RATES supplies a price, then charges at that price', async () => {
    const ledger = new BudgetLedger({ path: path.join(tmp, 'a.jsonl'), capUsd: 1 });
    const fake = new FakeProvider({ responses: { summary: '{"ok":true}' } }, { model: 'unpriced-model' });
    await expect(guard(fake, ledger).generate(req('summary', 'x'))).rejects.toThrow(/no price/);
    const priced = guard(fake, ledger, { inputPerMTok: 100, outputPerMTok: 200 });
    await priced.generate(req('summary', 'x'.repeat(400)));
    // FakeProvider usage is ceil(chars/4): 101 input tokens ("sys" + 400 chars), 3 output tokens.
    expect(ledger.spentUsd).toBeCloseTo((101 * 100 + 3 * 200) / 1e6, 9);
    expect(EVAL_RETRY.maxRetries).toBe(1);
  });
});

describe('RecordingProvider', () => {
  it('returns the in-depth user message as source material, or every chunk-notes input when chunked', async () => {
    const fake = new FakeProvider({ responses: { 'in-depth': '{}', 'chunk-notes': '{}', eli5: '{}' } });
    const rec = new RecordingProvider(fake);
    await rec.generateWithImages(req('in-depth', 'SOURCES', 2));
    await rec.generate(req('eli5', 'NOT-SOURCES'));
    expect(rec.sourceMaterial()).toEqual({ text: 'SOURCES', images: expect.any(Array) });
    expect(rec.sourceMaterial().images).toHaveLength(2);
    await rec.generate(req('chunk-notes', 'PART-1'));
    await rec.generate(req('chunk-notes', 'PART-2'));
    expect(rec.sourceMaterial().text).toBe('PART-1\n\nPART-2');
    rec.reset();
    expect(rec.sourceMaterial()).toEqual({ text: '', images: [] });
  });
});

describe('judgeFnFor', () => {
  it('sends prompted JSON requests, with images through generateWithImages only when present', async () => {
    const fake = new FakeProvider({ responses: { [JUDGE_TASK_ID]: '{"scores":{}}' } });
    const judge = judgeFnFor(fake);
    expect(await judge({ system: 'S', user: 'U' })).toBe('{"scores":{}}');
    await judge({ system: 'S', user: 'U', images: req('in-depth', '', 3).messages[0]?.images ?? [] });
    expect(fake.calls.map((c) => [c.taskId, c.withImages, c.imageCount, c.jsonSchema])).toEqual([
      [JUDGE_TASK_ID, false, 0, undefined],
      [JUDGE_TASK_ID, true, 3, undefined],
    ]);
    expect(fake.calls[0]?.system).toBe('S');
  });
});
