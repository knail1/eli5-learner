/**
 * Price table for the dev-only real-run budget guard (not part of the product spec). Rates are USD
 * per million tokens. A model missing from the table is refused, so an unpriced model can never
 * spend money unmetered.
 */
export interface ModelRates {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_RATES: Readonly<Record<string, ModelRates>> = {
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

/** Prompt-cache multipliers on the input rate. */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** Exact id, or the id plus a dated snapshot suffix (`-YYYYMMDD`). */
export function ratesFor(model: string): ModelRates | undefined {
  const exact = MODEL_RATES[model];
  if (exact) return exact;
  const m = /^(.+)-(\d{8})$/.exec(model);
  return m?.[1] !== undefined ? MODEL_RATES[m[1]] : undefined;
}

export interface CostTokens {
  /** Total input, including cache reads and writes. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/** USD cost of one call. */
export function costOf(rates: ModelRates, t: CostTokens): number {
  const inRate = rates.inputPerMTok / 1e6;
  const outRate = rates.outputPerMTok / 1e6;
  const uncached = Math.max(0, t.inputTokens - t.cacheReadTokens - t.cacheWriteTokens);
  return (
    uncached * inRate +
    t.cacheWriteTokens * inRate * CACHE_WRITE_MULTIPLIER +
    t.cacheReadTokens * inRate * CACHE_READ_MULTIPLIER +
    t.outputTokens * outRate
  );
}
