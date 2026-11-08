// Gradient descent on a fixed surface (07 §7.1), and the plot frame the static SVG (main) and the
// doc-runtime share, so the animated marker lands exactly on the drawn curve. Pure math.
import type { GdSim } from './clamp';
import { loss, nearestMinimum, slope } from './surfaces';

export type GdOutcome = 'crawls' | 'converges' | 'oscillates' | 'diverges';

/** |x| beyond this (or a non-finite x) ends the run as divergent. */
export const GD_CUTOFF = 50;
/** Within this distance of a minimum the run has converged. */
export const GD_TOLERANCE = 0.01;
/** Step direction changes at or above which a run oscillates. */
export const GD_FLIPS = 6;

export interface GdRun {
  /** Positions, start first; a divergent run ends at ±GD_CUTOFF. */
  xs: number[];
  outcome: GdOutcome;
  /** Steps taken (the step that converged or escaped, or every step). */
  steps: number;
}

/**
 * Runs `sim.steps` steps of x -= lr · f'(x). Outcomes: diverges (|x| passed GD_CUTOFF);
 * oscillates (the step changed direction GD_FLIPS or more times); converges (came within
 * GD_TOLERANCE of a minimum, or covered at least half the way to it); crawls (otherwise).
 */
export function runGD(sim: GdSim, lr: number): GdRun {
  let x = sim.start;
  const xs = [x];
  const target = nearestMinimum(sim.surface, x);
  const d0 = Math.abs(x - target);
  if (d0 < GD_TOLERANCE) return { xs, outcome: 'converges', steps: 0 };
  let flips = 0;
  let prev = 0;
  let converged = false;
  let steps = sim.steps;
  for (let i = 1; i <= sim.steps; i++) {
    const delta = -lr * slope(sim.surface, sim.scale, x);
    const nx = x + delta;
    if (!Number.isFinite(nx) || Math.abs(nx) > GD_CUTOFF) {
      xs.push(nx > 0 ? GD_CUTOFF : -GD_CUTOFF);
      return { xs, outcome: 'diverges', steps: i };
    }
    if (delta * prev < 0) flips++;
    if (delta !== 0) prev = delta;
    x = nx;
    xs.push(x);
    if (Math.abs(x - nearestMinimum(sim.surface, x)) < GD_TOLERANCE) {
      converged = true;
      steps = i;
      break;
    }
  }
  if (flips >= GD_FLIPS) return { xs, outcome: 'oscillates', steps };
  if (converged) return { xs, outcome: 'converges', steps };
  const moved = d0 - Math.abs(x - target);
  return { xs, outcome: moved >= d0 / 2 ? 'converges' : 'crawls', steps };
}

/** Shared plot geometry (viewBox units). */
export const FRAME = { W: 480, H: 280, top: 66, bottom: 30, left: 14, right: 14 } as const;

export interface GdFrame {
  x0: number;
  x1: number;
  yMax: number;
  /** Data -> viewBox, clipped to the plot area. */
  px(x: number): number;
  py(y: number): number;
}

/** The x range shows the start and every minimum; y runs from 0 to the curve's highest point. */
export function gdFrame(sim: GdSim): GdFrame {
  const r = Math.min(11.5, Math.max(3, Math.abs(sim.start) * 1.15));
  const x0 = -r;
  const x1 = r;
  let yMax = 0;
  for (let i = 0; i <= 120; i++) yMax = Math.max(yMax, loss(sim.surface, sim.scale, x0 + ((x1 - x0) * i) / 120));
  if (!(yMax > 0)) yMax = 1;
  const { W, H, top, bottom, left, right } = FRAME;
  const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
  return {
    x0,
    x1,
    yMax,
    px: (x) => left + ((clamp(x, x0, x1) - x0) / (x1 - x0)) * (W - left - right),
    py: (y) => H - bottom - (clamp(y, 0, yMax) / yMax) * (H - bottom - top),
  };
}

/** The point of the curve at x, in viewBox units. */
export function gdPoint(sim: GdSim, f: GdFrame, x: number): [number, number] {
  return [f.px(x), f.py(loss(sim.surface, sim.scale, x))];
}
