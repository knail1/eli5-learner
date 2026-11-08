import { describe, expect, it } from 'vitest';
import { logDensity, mhOutcome, rng, runMH, type MhSim, type Target } from '../../../../src/shared/explorable';

const BASE: MhSim = {
  kind: 'metropolis-walk',
  target: 'normal',
  start: 0,
  stepSize: { min: 0.01, max: 50, value: 1 },
  steps: 500,
  seed: 7,
  presets: [0.05, 1, 20],
};

describe('rng', () => {
  it('is seeded: same seed, same stream; different seeds differ; values in (0, 1)', () => {
    const a = rng(42);
    const b = rng(42);
    const c = rng(43);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(xs);
    expect(Array.from({ length: 1000 }, () => c())).not.toEqual(xs);
    expect(xs.every((x) => x > 0 && x < 1)).toBe(true);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });

  it('seed 0 still produces numbers', () => {
    const r = rng(0);
    expect(new Set([r(), r(), r()]).size).toBe(3);
  });
});

describe('runMH (07 §7.1)', () => {
  it('is deterministic for a seed and changes with it', () => {
    expect(runMH(BASE, 1)).toEqual(runMH(BASE, 1));
    expect(runMH({ ...BASE, seed: 8 }, 1).xs).not.toEqual(runMH(BASE, 1).xs);
    expect(runMH(BASE, 1).xs).toHaveLength(BASE.steps + 1);
  });

  it.each<Target>(['normal', 'bimodal', 'skewed'])(
    '%s: tiny steps stick, moderate steps mix, huge steps get stuck',
    (target) => {
      for (const seed of [1, 7, 12345]) {
        const sim = { ...BASE, target, seed };
        const tiny = runMH(sim, 0.05);
        const mid = runMH(sim, 1);
        const huge = runMH(sim, 20);
        expect(tiny.rate).toBeGreaterThan(0.85);
        expect(tiny.outcome).toBe('sticks');
        expect(mid.rate).toBeGreaterThan(0.4);
        expect(mid.rate).toBeLessThan(0.85);
        expect(mid.outcome).toBe('mixes');
        expect(huge.rate).toBeLessThan(0.15);
        expect(huge.outcome).toBe('stuck');
      }
    },
  );

  it('a start where the target is zero begins at its mode', () => {
    expect(Number.isFinite(logDensity('skewed', -5))).toBe(false);
    const run = runMH({ ...BASE, target: 'skewed', start: -5 }, 1);
    expect(run.xs[0]).toBe(-1.5);
    expect(run.xs.every((x) => x > -3)).toBe(true);
  });

  it('outcome bands', () => {
    expect(mhOutcome(0.9)).toBe('sticks');
    expect(mhOutcome(0.85)).toBe('mixes');
    expect(mhOutcome(0.15)).toBe('mixes');
    expect(mhOutcome(0.1)).toBe('stuck');
  });
});
