import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetGuardProvider, BudgetLedger, estimateInputTokens } from '../../../../src/main/devtools';
import { DEFAULT_RETRY, fallbackLimits, LLMError, resetLlmRuntime } from '../../../../src/main/llm';
import type { GenerationRequest, GenerationResult, LLMProvider, RetryPolicy } from '../../../../src/main/llm';
import { FakeProvider, type FakeScript } from '../../../../src/main/llm/testing/fake';
import { FakeClock } from '../../../helpers/clock';

// claude-opus-5: $5 in / $25 out per MTok.
const IN = 5 / 1e6;
const OUT = 25 / 1e6;

let dir: string;
let ledgerPath: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'eli5-guard-'));
  ledgerPath = path.join(dir, 'ledger.jsonl');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A guard whose inner provider makes at most `attempts` attempts per call (1 = no retries). */
const guard = (inner: LLMProvider, l: BudgetLedger, attempts = 1): BudgetGuardProvider =>
  new BudgetGuardProvider(inner, l, { retry: () => ({ ...DEFAULT_RETRY, maxRetries: attempts - 1 }) });

let seq = 0;
const ledger = (capUsd: number): BudgetLedger =>
  new BudgetLedger({ path: ledgerPath, capUsd, clock: new FakeClock(), newId: () => `r${++seq}` });

const script = (over: Partial<FakeScript> = {}): FakeScript => ({
  responses: { 'in-depth': JSON.stringify('x'.repeat(398)) }, // 400 chars → 100 output tokens
  ...over,
});
const fake = (over: Partial<FakeScript> = {}, model = 'claude-opus-5'): FakeProvider =>
  new FakeProvider(script(over), { model });

/** 400 chars → FakeProvider.countTokens = 100 tokens. */
const req = (over: Partial<GenerationRequest> = {}): GenerationRequest => ({
  taskId: 'in-depth',
  system: 's'.repeat(100),
  messages: [{ role: 'user', text: 'u'.repeat(300) }],
  maxOutputTokens: 16_000,
  ...over,
});

/** Captures the request the inner provider received. */
function spyReq(p: LLMProvider): () => GenerationRequest | undefined {
  const spy = vi.spyOn(p, 'generate');
  return () => spy.mock.calls.at(-1)?.[0];
}

const usageResult = (usage: GenerationResult['usage'], attempts = 1): GenerationResult => ({
  text: '{}',
  stopReason: 'end',
  usage,
  model: 'claude-opus-5',
  provider: 'claude',
  latencyMs: 1,
  attempts,
});

/** A provider with no countTokens, to exercise the estimate path. */
class BareProvider implements LLMProvider {
  readonly id = 'claude' as const;
  readonly model = 'claude-opus-5';
  readonly limits = fallbackLimits('claude');
  last: GenerationRequest | undefined;
  generate(r: GenerationRequest): Promise<GenerationResult> {
    this.last = r;
    return Promise.resolve(usageResult({ inputTokens: 10, outputTokens: 10 }));
  }
  generateWithImages(r: GenerationRequest): Promise<GenerationResult> {
    return this.generate(r);
  }
  testConnection(): ReturnType<LLMProvider['testConnection']> {
    return Promise.resolve({ ok: true, model: this.model });
  }
}

describe('estimateInputTokens', () => {
  it('is ceil(chars/3)*1.1 over system and messages plus 1600 per image', () => {
    const r = req();
    expect(estimateInputTokens(r)).toBe(Math.ceil(Math.ceil(400 / 3) * 1.1));
    const img = { mediaType: 'image/png' as const, data: Buffer.alloc(4), label: 'a.png', sourceRef: 'a.png' };
    const withImages = req({ messages: [{ role: 'user', text: 'u'.repeat(300), images: [img, img] }] });
    expect(estimateInputTokens(withImages)).toBe(Math.ceil(Math.ceil(400 / 3) * 1.1) + 3200);
  });
});

describe('BudgetGuardProvider', () => {
  it('exposes the inner provider id, model and limits', () => {
    const inner = fake();
    const g = guard(inner, ledger(1));
    expect([g.id, g.model, g.limits]).toEqual([inner.id, inner.model, inner.limits]);
  });

  it('passes maxOutputTokens through when the budget covers it', async () => {
    const inner = fake();
    const last = spyReq(inner);
    await guard(inner, ledger(10)).generate(req());
    expect(last()?.maxOutputTokens).toBe(16_000);
  });

  it('clamps maxOutputTokens so input + max output fits the remaining budget', async () => {
    const inner = fake();
    const last = spyReq(inner);
    // 100 input tokens cost 0.0005; (0.1 - 0.0005) / 25e-6 = 3980 output tokens.
    await guard(inner, ledger(0.1)).generate(req());
    expect(last()?.maxOutputTokens).toBe(3980);
  });

  it('refuses without calling the provider when fewer than 2048 output tokens fit', async () => {
    const inner = fake();
    const g = guard(inner, ledger(0.05));
    const err = await g.generate(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err).toMatchObject({ kind: 'cancelled', message: 'budget exhausted' });
    expect(inner.calls).toEqual([]);
  });

  it('refuses an unknown model without calling the provider', async () => {
    const inner = fake({}, 'fake-model');
    const err = await guard(inner, ledger(10))
      .generate(req())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'cancelled' });
    expect((err as Error).message).toMatch(/unknown model/);
    expect(inner.calls).toEqual([]);
  });

  it('records the actual cost from usage after each call', async () => {
    const l = ledger(10);
    await guard(fake(), l).generate(req());
    // FakeProvider usage: input ceil(400/4)=100, output ceil(400/4)=100.
    expect(l.spentUsd).toBeCloseTo(100 * IN + 100 * OUT, 12);
    expect(l.reservedUsd).toBe(0);
  });

  it('prices cache reads at 0.1x and explicit cache writes at 1.25x', async () => {
    const inner = fake();
    vi.spyOn(inner, 'generate').mockResolvedValue(
      usageResult({ inputTokens: 10_000, outputTokens: 1_000, cachedInputTokens: 4_000 }),
    );
    const l = ledger(10);
    await guard(inner, l).generate(req({ cacheSystemPrompt: true }));
    // A cache read means the system prompt came from cache: no write.
    expect(l.spentUsd).toBeCloseTo(6_000 * IN + 4_000 * IN * 0.1 + 1_000 * OUT, 12);

    const l2 = new BudgetLedger({ path: path.join(dir, 'b.jsonl'), capUsd: 10 });
    const usage = { inputTokens: 10_000, outputTokens: 0, cacheWriteInputTokens: 3_000 };
    vi.spyOn(inner, 'generate').mockResolvedValue(usageResult(usage as GenerationResult['usage']));
    await guard(inner, l2).generate(req({ cacheSystemPrompt: true }));
    expect(l2.spentUsd).toBeCloseTo(7_000 * IN + 3_000 * IN * 1.25, 12);
  });

  it('assumes the system prompt was written to cache when caching was requested and nothing was read', async () => {
    const inner = fake();
    vi.spyOn(inner, 'generate').mockResolvedValue(usageResult({ inputTokens: 1_000, outputTokens: 0 }));
    const l = ledger(10);
    const system = 's'.repeat(300); // estimate ceil(100*1.1) = 110 tokens
    await guard(inner, l).generate(req({ system, cacheSystemPrompt: true }));
    expect(l.spentUsd).toBeCloseTo(890 * IN + 110 * IN * 1.25, 12);
  });

  it('prices the worst case of a cached request at the cache-write rate', async () => {
    const inner = fake();
    const last = spyReq(inner);
    // 100 input tokens at 1.25x = 0.000625; (0.1 - 0.000625) / 25e-6 = 3975.
    await guard(inner, ledger(0.1)).generate(req({ cacheSystemPrompt: true }));
    expect(last()?.maxOutputTokens).toBe(3975);
  });

  it('charges each extra attempt (retried inside the provider) at its worst case', async () => {
    const inner = fake();
    vi.spyOn(inner, 'generate').mockResolvedValue(usageResult({ inputTokens: 1_000, outputTokens: 10 }, 3));
    const l = ledger(10);
    await guard(inner, l, 3).generate(req());
    // Per attempt worst case: 100 counted input tokens + 16000 output tokens.
    const perAttempt = 100 * IN + 16_000 * OUT;
    expect(l.spentUsd).toBeCloseTo(1_000 * IN + 10 * OUT + 2 * perAttempt, 12);
  });

  it('passes a small maxOutputTokens (below 2048) through unchanged when the budget covers it', async () => {
    const inner = fake();
    const last = spyReq(inner);
    await guard(inner, ledger(10)).generate(req({ maxOutputTokens: 2_000 }));
    expect(last()?.maxOutputTokens).toBe(2_000);
    expect(inner.calls).toHaveLength(1);
  });

  it('clamps and reserves for every attempt the retry policy allows', async () => {
    const inner = fake();
    const l = ledger(0.4);
    let reservedDuringCall = 0;
    const spy = vi.spyOn(inner, 'generate').mockImplementation(() => {
      reservedDuringCall = l.reservedUsd;
      return Promise.resolve(usageResult({ inputTokens: 100, outputTokens: 10 }));
    });
    await guard(inner, l, 4).generate(req());
    // 0.4 / 4 attempts = 0.1 per attempt → 3980 output tokens, as with a 0.1 cap and no retries.
    expect(spy.mock.calls[0]?.[0].maxOutputTokens).toBe(3980);
    expect(reservedDuringCall).toBeCloseTo(4 * (100 * IN + 3980 * OUT), 12);
  });

  it('charges a failed call at the worst case of every attempt it may have made', async () => {
    const l = ledger(10);
    const g = guard(fake({ errors: { 'in-depth': 'timeout' } }), l, 4);
    await expect(g.generate(req({ maxOutputTokens: 4_000 }))).rejects.toMatchObject({ kind: 'timeout' });
    expect(l.spentUsd).toBeCloseTo(4 * (100 * IN + 4_000 * OUT), 12);

    // An error raised before generation leaves only the earlier (retried) attempts billable.
    const l2 = new BudgetLedger({ path: path.join(dir, 'e.jsonl'), capUsd: 10 });
    const g2 = guard(fake({ errors: { 'in-depth': 'auth' } }), l2, 4);
    await expect(g2.generate(req({ maxOutputTokens: 4_000 }))).rejects.toMatchObject({ kind: 'auth' });
    expect(l2.spentUsd).toBeCloseTo(3 * (100 * IN + 4_000 * OUT), 12);
  });

  it('reads the process retry policy by default, counting per-kind overrides', async () => {
    resetLlmRuntime();
    const inner = fake();
    const last = spyReq(inner);
    // No runtime policy: DEFAULT_RETRY (3 retries) → 4 attempts share 0.4.
    await new BudgetGuardProvider(inner, ledger(0.4)).generate(req());
    expect(last()?.maxOutputTokens).toBe(3980);

    const byKind: RetryPolicy = { ...DEFAULT_RETRY, maxRetries: 0, maxRetriesByKind: { timeout: 2 } };
    const l = new BudgetLedger({ path: path.join(dir, 'f.jsonl'), capUsd: 0.3 });
    await new BudgetGuardProvider(inner, l, { retry: () => byKind }).generate(req());
    expect(last()?.maxOutputTokens).toBe(3980);
  });

  it('adds the JSON schema to the input count', async () => {
    const inner = fake();
    const last = spyReq(inner);
    const schema = { name: 'draft', schema: { description: 'd'.repeat(2_998) } };
    await guard(inner, ledger(0.1)).generate(req({ jsonSchema: schema }));
    const schemaTokens = Math.ceil(Math.ceil(JSON.stringify(schema).length / 3) * 1.1);
    expect(last()?.maxOutputTokens).toBe(Math.floor((0.1 - (100 + schemaTokens) * IN) / OUT + 1e-9));
  });

  it('estimates input when the provider has no countTokens, or countTokens fails', async () => {
    const bare = new BareProvider();
    await guard(bare, ledger(0.1)).generate(req());
    const est = Math.ceil(Math.ceil(400 / 3) * 1.1);
    expect(bare.last?.maxOutputTokens).toBe(Math.floor((0.1 - est * IN) / OUT + 1e-9));

    const inner = fake();
    vi.spyOn(inner, 'countTokens').mockRejectedValue(new LLMError('network', 'down'));
    const last = spyReq(inner);
    const fresh = new BudgetLedger({ path: path.join(dir, 'd.jsonl'), capUsd: 0.1 });
    await guard(inner, fresh).generate(req());
    expect(last()?.maxOutputTokens).toBe(Math.floor((0.1 - est * IN) / OUT + 1e-9));
  });

  it('guards generateWithImages the same way, counting 1600 tokens per image when estimating', async () => {
    const bare = new BareProvider();
    const img = { mediaType: 'image/png' as const, data: Buffer.alloc(4), label: 'a.png', sourceRef: 'a.png' };
    const r = req({ messages: [{ role: 'user', text: 'u'.repeat(300), images: [img] }] });
    await guard(bare, ledger(0.1)).generateWithImages(r);
    const est = Math.ceil(Math.ceil(400 / 3) * 1.1) + 1600;
    expect(bare.last?.maxOutputTokens).toBe(Math.floor((0.1 - est * IN) / OUT + 1e-9));
  });

  it('charges nothing for errors raised before generation, and the worst case for others', async () => {
    const l = ledger(10);
    const g = guard(fake({ errors: { 'in-depth': 'auth' } }), l);
    await expect(g.generate(req())).rejects.toMatchObject({ kind: 'auth' });
    expect(l.spentUsd).toBe(0);
    expect(l.reservedUsd).toBe(0);

    const l2 = new BudgetLedger({ path: path.join(dir, 'c.jsonl'), capUsd: 10 });
    const g2 = guard(fake({ errors: { 'in-depth': 'timeout' } }), l2);
    await expect(g2.generate(req({ maxOutputTokens: 4_000 }))).rejects.toMatchObject({ kind: 'timeout' });
    expect(l2.spentUsd).toBeCloseTo(100 * IN + 4_000 * OUT, 12);
    expect(l2.reservedUsd).toBe(0);
  });

  it('refuses at the cap once earlier calls have spent it, across ledger instances', async () => {
    const cap = 0.2;
    const inner = fake();
    vi.spyOn(inner, 'generate').mockResolvedValue(usageResult({ inputTokens: 1_000, outputTokens: 6_000 }));
    // 1000*5e-6 + 6000*25e-6 = 0.155; the 0.045 left fits only 1780 output tokens.
    await guard(inner, ledger(cap)).generate(req({ maxOutputTokens: 2_048 }));
    const again = guard(inner, ledger(cap));
    await expect(again.generate(req({ maxOutputTokens: 2_048 }))).rejects.toMatchObject({
      kind: 'cancelled',
      message: 'budget exhausted',
    });
    expect(ledger(cap).spentUsd).toBeCloseTo(0.155, 12);
  });

  it('serializes reservations so concurrent calls cannot overshoot the cap', async () => {
    const inner = fake({ latencyMs: 20 });
    // Each call reserves 100*5e-6 + 4000*25e-6 = 0.1005; two fit in 0.25, the third would not.
    const l = ledger(0.25);
    const g = guard(inner, l);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => g.generate(req({ maxOutputTokens: 4_000 }))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3);
    expect(inner.calls).toHaveLength(2);
    expect(l.spentUsd).toBeLessThanOrEqual(0.25);
    expect(l.reservedUsd).toBe(0);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const inner = fake();
    const ctl = new AbortController();
    ctl.abort();
    await expect(guard(inner, ledger(1)).generate(req({ signal: ctl.signal }))).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(inner.calls).toEqual([]);
  });

  it('delegates countTokens and testConnection', async () => {
    const inner = fake();
    const g = guard(inner, ledger(1));
    await expect(g.countTokens(req())).resolves.toBe(100);
    await expect(g.testConnection()).resolves.toEqual({ ok: true, model: 'claude-opus-5' });
    await expect(guard(new BareProvider(), ledger(1)).countTokens(req())).resolves.toBe(estimateInputTokens(req()));
  });
});
