/**
 * Memory (13 §13): extracting every hostile fixture (zip bomb, lying sizes, XML entity expansion,
 * huge image dimensions) keeps RSS growth under 200 MB. Several rounds, so a per-file leak shows up
 * as growth too. Integration-level: the real extractors with the fake page renderer and image
 * normalizer from the extractor contract (13 §6).
 */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractSource } from '../../src/main/extract';
import { FIXTURES_DIR, fixtureSource, testContext } from '../contracts/extractor.contract';

const MB = 1024 * 1024;
/** 13 §13 budget; ELI5_RSS_BUDGET_MB overrides it only to prove the check can fail. */
const BUDGET_MB = Number(process.env.ELI5_RSS_BUDGET_MB ?? 200);
const ROUNDS = 5;
const HOSTILE = readdirSync(resolve(FIXTURES_DIR, 'sources/hostile'))
  .filter((f) => !f.startsWith('.'))
  .sort()
  .map((f) => `sources/hostile/${f}`);

const gc = (): void => (globalThis as { gc?: () => void }).gc?.();

describe('hostile extraction memory (13 §13)', () => {
  it('covers every hostile fixture', () => {
    expect(HOSTILE.length).toBeGreaterThanOrEqual(7);
  });

  it(`keeps RSS growth under ${BUDGET_MB} MB across ${ROUNDS} rounds`, { timeout: 120_000 }, async () => {
    gc();
    const before = process.memoryUsage().rss;
    let peak = before;
    for (let round = 0; round < ROUNDS; round++) {
      for (const rel of HOSTILE) {
        const r = await extractSource(fixtureSource(rel), testContext());
        // Every hostile input is refused (04 resource limits), never extracted.
        expect(r.ok, rel).toBe(false);
        peak = Math.max(peak, process.memoryUsage().rss);
      }
    }
    gc();
    const after = process.memoryUsage().rss;
    const growth = { peakMb: (peak - before) / MB, retainedMb: (after - before) / MB };
    expect(growth.peakMb, JSON.stringify(growth)).toBeLessThan(BUDGET_MB);
    expect(growth.retainedMb, JSON.stringify(growth)).toBeLessThan(BUDGET_MB);
  });
});
