import { describe, expect, it } from 'vitest';
import { clampSim, outcomeRow, outcomeRows, settingName } from '../../../../src/shared/explorable';

const MH = clampSim({
  kind: 'metropolis-walk',
  target: 'normal',
  start: 0,
  stepSize: { min: 0.01, max: 50, value: 1 },
  steps: 300,
  seed: 7,
  presets: [0.05, 1, 20],
});

describe('outcome rows (design D8: computed by code)', () => {
  it('labels each walk preset with its outcome and acceptance', () => {
    if (!MH) throw new Error('fixture');
    expect(settingName(MH)).toBe('step size');
    const rows = outcomeRows(MH);
    expect(rows.map((r) => r.outcome)).toEqual(['sticks', 'mixes', 'stuck']);
    expect(rows[1]?.label).toMatch(/^step 1: mixes \(\d+% accepted\)$/);
    expect(rows[1]?.result).toMatch(/^\d+% accepted$/);
    expect(rows.every((r) => r.steps === 300)).toBe(true);
  });

  it('is identical on every call (main and runtime agree)', () => {
    if (!MH) throw new Error('fixture');
    expect(outcomeRow(MH, 3.7)).toEqual(outcomeRow(MH, 3.7));
  });
});
