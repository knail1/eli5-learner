import { describe, expect, it } from 'vitest';
import { costOf, MODEL_RATES, ratesFor } from '../../../../src/main/devtools';

describe('model rates (devtools real run)', () => {
  it('prices the known models per million tokens', () => {
    expect(MODEL_RATES['claude-opus-5']).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
    expect(MODEL_RATES['claude-opus-5-5']).toEqual({ inputPerMTok: 4, outputPerMTok: 20 });
    expect(MODEL_RATES['claude-sonnet-5']).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(MODEL_RATES['claude-haiku-4-5']).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
  });

  it('matches exact ids and dated snapshots, never a longer family id', () => {
    expect(ratesFor('claude-opus-5')?.inputPerMTok).toBe(5);
    expect(ratesFor('claude-opus-5-20260301')?.inputPerMTok).toBe(5);
    // claude-opus-5-5 is its own model, not a snapshot of claude-opus-5.
    expect(ratesFor('claude-opus-5-5')?.inputPerMTok).toBe(4);
    expect(ratesFor('claude-opus-5-5-20260801')?.inputPerMTok).toBe(4);
  });

  it('returns undefined for unknown models (the guard refuses them)', () => {
    expect(ratesFor('fake-model')).toBeUndefined();
    expect(ratesFor('gpt-5')).toBeUndefined();
    expect(ratesFor('claude-opus-5-preview')).toBeUndefined();
    expect(ratesFor('')).toBeUndefined();
  });

  it('costOf prices uncached input, cache writes at 1.25x, cache reads at 0.1x and output', () => {
    const rates = { inputPerMTok: 5, outputPerMTok: 25 };
    const cost = costOf(rates, {
      inputTokens: 10_000,
      cacheReadTokens: 4_000,
      cacheWriteTokens: 2_000,
      outputTokens: 1_000,
    });
    // 4000*5 + 2000*6.25 + 4000*0.5 + 1000*25, per million.
    expect(cost).toBeCloseTo(0.0595, 10);
  });

  it('costOf never prices negative uncached input', () => {
    const rates = { inputPerMTok: 1, outputPerMTok: 5 };
    expect(
      costOf(rates, { inputTokens: 100, cacheReadTokens: 100, cacheWriteTokens: 50, outputTokens: 0 }),
    ).toBeCloseTo((100 * 0.1 + 50 * 1.25) / 1e6, 12);
  });
});
