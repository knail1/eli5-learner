// Metropolis random walk over a fixed target density (07 §7.1): seeded xorshift32, Gaussian
// proposals (Box-Muller), log densities. Same seed, same chain, in main and in the doc-runtime.
import { FRAME } from './gd';
import type { MhSim, Target } from './clamp';

export type MhOutcome = 'sticks' | 'mixes' | 'stuck';

/** Acceptance above this: tiny steps that barely move; below MH_LOW: the walker rarely moves. */
export const MH_HIGH = 0.85;
export const MH_LOW = 0.15;

/** Unnormalized log density of each target. */
export function logDensity(t: Target, x: number): number {
  switch (t) {
    case 'normal':
      return (-x * x) / 2;
    case 'bimodal': {
      const a = (-(x + 2.5) * (x + 2.5)) / 2;
      const b = (-(x - 2.5) * (x - 2.5)) / 2;
      const m = Math.max(a, b);
      return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
    }
    case 'skewed':
      // A shifted gamma (shape 2, scale 1.5): zero at and below -3, a long right tail.
      return x > -3 ? Math.log(x + 3) - (x + 3) / 1.5 : -Infinity;
  }
}

/** Where each target peaks; a walker that starts where the density is zero starts here. */
const MODE: Record<Target, number> = { normal: 0, bimodal: 2.5, skewed: -1.5 };

/** xorshift32 uniform in (0, 1). Seed 0 is remapped (xorshift never leaves 0). */
export function rng(seed: number): () => number {
  let s = (seed ^ 0x9e3779b9) >>> 0 || 0x6d2b79f5;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s + 1) / 4294967297;
  };
}

export interface MhRun {
  /** Positions, start first: steps + 1 values. */
  xs: number[];
  accepted: number;
  rate: number;
  outcome: MhOutcome;
}

export function mhOutcome(rate: number): MhOutcome {
  return rate > MH_HIGH ? 'sticks' : rate < MH_LOW ? 'stuck' : 'mixes';
}

/** Runs the chain for `sim.steps` proposals of size `stepSize`; three uniforms per step. */
export function runMH(sim: MhSim, stepSize: number): MhRun {
  const rand = rng(sim.seed);
  let x = Number.isFinite(logDensity(sim.target, sim.start)) ? sim.start : MODE[sim.target];
  let lp = logDensity(sim.target, x);
  const xs = [x];
  let accepted = 0;
  for (let i = 0; i < sim.steps; i++) {
    const z = Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());
    const prop = x + stepSize * z;
    const lq = logDensity(sim.target, prop);
    if (Math.log(rand()) < lq - lp) {
      x = prop;
      lp = lq;
      accepted++;
    }
    xs.push(x);
  }
  const rate = sim.steps > 0 ? accepted / sim.steps : 0;
  return { xs, accepted, rate, outcome: mhOutcome(rate) };
}

/** The x range of the plot. */
export const MH_X: readonly [number, number] = [-8, 8];
/** Height of one rug row (one preset's visited positions) under the curve. */
export const MH_ROW = 16;

export interface MhFrame {
  /** Peak of the density over the plot, for scaling. */
  peak: number;
  /** Baseline of the curve (rug rows start below it). */
  base: number;
  px(x: number): number;
  py(density: number): number;
  /** Middle of rug row i. */
  rowY(i: number): number;
}

/** Curve on top, `rows` rug rows below it. */
export function mhFrame(sim: MhSim, rows: number): MhFrame {
  const [x0, x1] = MH_X;
  let peak = 0;
  for (let i = 0; i <= 160; i++) peak = Math.max(peak, Math.exp(logDensity(sim.target, x0 + ((x1 - x0) * i) / 160)));
  if (!(peak > 0)) peak = 1;
  const { W, H, top, bottom, left, right } = FRAME;
  const base = H - bottom - rows * MH_ROW - 6;
  const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
  return {
    peak,
    base,
    px: (x) => left + ((clamp(x, x0, x1) - x0) / (x1 - x0)) * (W - left - right),
    py: (d) => base - (clamp(d, 0, peak) / peak) * (base - top),
    rowY: (i) => base + 6 + i * MH_ROW + MH_ROW / 2,
  };
}
