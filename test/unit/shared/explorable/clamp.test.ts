import { describe, expect, it } from 'vitest';
import { LIMITS, clampSim, fmtNum, fromSlider, sig, toSlider } from '../../../../src/shared/explorable';

const gd = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'gradient-descent',
  surface: 'bowl',
  scale: 1.5,
  start: -4,
  lr: { min: 0.001, max: 2, value: 0.1 },
  steps: 60,
  presets: [0.001, 0.1, 1.5],
  ...over,
});
const mh = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'metropolis-walk',
  target: 'normal',
  start: 0,
  stepSize: { min: 0.01, max: 50, value: 1 },
  steps: 300,
  seed: 7,
  presets: [0.05, 1, 20],
  ...over,
});

describe('clampSim (07 §5.2)', () => {
  it('keeps valid parameters unchanged', () => {
    expect(clampSim(gd())).toEqual(gd());
    expect(clampSim(mh())).toEqual(mh());
  });

  it('clamps every number into its range', () => {
    const g = clampSim(
      gd({ scale: 99, start: -1e6, steps: 1e9, lr: { min: 1e-9, max: 40, value: 77 }, presets: [1e-12, 5] }),
    );
    expect(g).toMatchObject({
      scale: LIMITS.scale[1],
      start: LIMITS.start[0],
      steps: LIMITS.gdSteps[1],
      lr: { min: LIMITS.lr[0], max: LIMITS.lr[1], value: LIMITS.lr[1] },
      presets: [LIMITS.lr[0], LIMITS.lr[1]],
    });
    const m = clampSim(mh({ steps: 2, seed: -5.7, stepSize: { min: 0, max: 1e5, value: 1 }, start: 30 }));
    expect(m).toMatchObject({
      steps: LIMITS.mhSteps[0],
      seed: 0,
      start: 10,
      stepSize: { min: LIMITS.stepSize[0], max: LIMITS.stepSize[1], value: 1 },
    });
    expect(clampSim(mh({ seed: 2 ** 40 }))).toMatchObject({ seed: LIMITS.seed[1] });
  });

  it('orders a reversed range, widens a collapsed one, rounds to four significant digits', () => {
    expect(clampSim(gd({ lr: { min: 2, max: 0.01, value: 0.1 } }))).toMatchObject({ lr: { min: 0.01, max: 2 } });
    expect(clampSim(gd({ lr: { min: 0.1, max: 0.1, value: 0.1 } }))).toMatchObject({
      lr: { min: 0.01, max: 1, value: 0.1 },
    });
    expect(clampSim(gd({ start: -3.14159265 }))).toMatchObject({ start: -3.142 });
    expect(sig(-0.00001)).toBe(-0.00001);
    expect(Object.is(sig(-0), 0)).toBe(true);
  });

  it('sorts and dedupes presets, keeps at most three, never empty', () => {
    expect(clampSim(gd({ presets: [1.5, 0.1, 0.1, 0.001] }))).toMatchObject({ presets: [0.001, 0.1, 1.5] });
    expect(clampSim(gd({ presets: [0.002, 0.003, 0.004, 0.005] }))).toMatchObject({
      presets: [0.002, 0.003, 0.004],
    });
    expect(clampSim(gd({ presets: [] }))).toMatchObject({ presets: [0.1] });
  });

  it.each([
    ['unknown kind', { ...gd(), kind: 'script' }],
    ['unknown surface', gd({ surface: 'saddle' })],
    ['unknown target', mh({ target: 'cauchy' })],
    ['NaN', gd({ scale: Number.NaN })],
    ['Infinity', gd({ lr: { min: 0.001, max: Infinity, value: 0.1 } })],
    ['string number', gd({ steps: '60' })],
    ['non-numeric preset', gd({ presets: [0.1, '0.2'] })],
    ['missing range', mh({ stepSize: undefined })],
    ['not an object', 'gradient-descent'],
    ['null', null],
    ['array', [gd()]],
  ])('rejects %s', (_name, raw) => {
    expect(clampSim(raw)).toBeNull();
  });
});

describe('log-mapped slider', () => {
  const r = { min: 0.001, max: 2, value: 0.1 };
  it('maps the ends to the range and round-trips', () => {
    expect(fromSlider(r, 0)).toBe(0.001);
    expect(fromSlider(r, 1)).toBe(2);
    expect(fromSlider(r, -5)).toBe(0.001);
    for (const v of [0.001, 0.01, 0.1, 1.5]) expect(fromSlider(r, toSlider(r, v))).toBeCloseTo(v, 6);
    // Log mapping: the midpoint is the geometric mean.
    expect(fromSlider(r, 0.5)).toBeCloseTo(Math.sqrt(0.002), 4);
  });

  it('formats numbers without exponents for ordinary values', () => {
    expect(fmtNum(0.0001)).toBe('0.0001');
    expect(fmtNum(0.123456)).toBe('0.1235');
    expect(fmtNum(1e-7)).toBe('1e-7');
    expect(fmtNum(-3.655)).toBe('-3.655');
  });
});
