import { describe, expect, it } from 'vitest';
import {
  GD_CUTOFF,
  clampSim,
  gdFrame,
  loss,
  minima,
  outcomeRows,
  runGD,
  slope,
  type GdSim,
  type Surface,
} from '../../../../src/shared/explorable';

/** The owner's example (design §3.3): bowl, scale 1.5, start -4. */
const OWNER: GdSim = {
  kind: 'gradient-descent',
  surface: 'bowl',
  scale: 1.5,
  start: -4,
  lr: { min: 0.001, max: 2, value: 0.1 },
  steps: 60,
  presets: [0.001, 0.1, 1.5],
};

describe('surfaces (07 §7.1)', () => {
  it.each<Surface>(['bowl', 'ravine', 'double-well', 'plateau'])('%s: slope is the derivative of loss', (s) => {
    for (const x of [-7.3, -2.1, -0.4, 0.3, 1.7, 5.2]) {
      const h = 1e-5;
      const numeric = (loss(s, 1.3, x + h) - loss(s, 1.3, x - h)) / (2 * h);
      expect(slope(s, 1.3, x)).toBeCloseTo(numeric, 4);
    }
    for (const m of minima(s)) {
      expect(slope(s, 1.3, m)).toBeCloseTo(0, 12);
      expect(loss(s, 1.3, m)).toBeCloseTo(0, 12);
    }
  });
});

describe('runGD (07 §7.1)', () => {
  it('owner example: 0.001 crawls, 0.1 converges, 1.5 diverges (factor 1 - 1.5 lr = -1.25)', () => {
    expect(runGD(OWNER, 0.001).outcome).toBe('crawls');
    const ok = runGD(OWNER, 0.1);
    expect(ok.outcome).toBe('converges');
    expect(ok.steps).toBeLessThan(60);
    const bad = runGD(OWNER, 1.5);
    expect(bad.outcome).toBe('diverges');
    // |x| = 4 * 1.25^n passes the cutoff at n = 12.
    expect(bad.steps).toBe(12);
    expect(Math.abs(bad.xs[bad.xs.length - 1] ?? 0)).toBe(GD_CUTOFF);
    expect(outcomeRows(OWNER).map((r) => r.label)).toEqual([
      'lr 0.001: crawls',
      'lr 0.1: converges in 37 steps',
      'lr 1.5: diverges after 12 steps',
    ]);
  });

  it('a step that flips direction at least six times oscillates', () => {
    expect(runGD(OWNER, 1.3).outcome).toBe('oscillates'); // factor -0.95: never settles
    expect(runGD(OWNER, 1.0).outcome).toBe('oscillates'); // factor -0.5: zig-zags in
  });

  it('a plateau start far out crawls (the slope is almost zero), a well start settles in its own well', () => {
    expect(runGD({ ...OWNER, surface: 'plateau', start: 9 }, 0.1).outcome).toBe('crawls');
    const well = runGD({ ...OWNER, surface: 'double-well', start: 3 }, 0.05);
    expect(well.outcome).toBe('converges');
    expect(well.xs[well.xs.length - 1]).toBeCloseTo(2, 1);
  });

  it('is deterministic and bounded by steps', () => {
    for (const lr of [0.001, 0.02, 0.1, 0.7, 1.5, 3]) {
      const a = runGD(OWNER, lr);
      expect(runGD(OWNER, lr)).toEqual(a);
      expect(a.xs.length).toBeLessThanOrEqual(OWNER.steps + 1);
      expect(a.xs.every(Number.isFinite)).toBe(true);
    }
  });

  it('starting on a minimum converges in zero steps', () => {
    expect(runGD({ ...OWNER, start: 0 }, 0.1)).toEqual({ xs: [0], outcome: 'converges', steps: 0 });
  });

  it('frames the start and the minima inside the plot', () => {
    const f = gdFrame(OWNER);
    expect(f.x0).toBeLessThan(-4);
    expect(f.x1).toBeGreaterThan(4);
    expect(f.px(-1000)).toBe(f.px(f.x0));
    expect(f.py(1e9)).toBe(f.py(f.yMax));
    const sim = clampSim({ ...OWNER, surface: 'double-well', start: 0 });
    expect(sim && gdFrame(sim as GdSim).x1).toBeGreaterThanOrEqual(3);
  });
});
