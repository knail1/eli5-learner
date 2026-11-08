// Explorable parameters (07 §7.1): the types, their limits and the one clamp both the main process
// (build, render) and the doc-runtime (data-params) run, so every number is bounded wherever it is
// read. Pure: no DOM or Node imports.
import { SURFACES, type Surface } from './surfaces';

export const TARGETS = ['normal', 'bimodal', 'skewed'] as const;
export type Target = (typeof TARGETS)[number];
export const KINDS = ['gradient-descent', 'metropolis-walk'] as const;
export type ExplorableKind = (typeof KINDS)[number];

export interface SimRange {
  min: number;
  max: number;
  value: number;
}

export interface GdSim {
  kind: 'gradient-descent';
  surface: Surface;
  /** Curvature. */
  scale: number;
  start: number;
  /** Learning rate slider. */
  lr: SimRange;
  steps: number;
  /** Learning rates compared in the static picture. */
  presets: number[];
}

export interface MhSim {
  kind: 'metropolis-walk';
  target: Target;
  start: number;
  /** Proposal step size slider. */
  stepSize: SimRange;
  steps: number;
  seed: number;
  /** Step sizes compared in the static picture. */
  presets: number[];
}

export type ExplorableSim = GdSim | MhSim;

export const MAX_PRESETS = 3;

/** Closed intervals every number is clamped into (07 §7.1). */
export const LIMITS = {
  scale: [0.1, 10],
  start: [-10, 10],
  lr: [1e-4, 3],
  gdSteps: [10, 200],
  stepSize: [0.01, 50],
  mhSteps: [50, 500],
  seed: [0, 2 ** 31 - 1],
} as const satisfies Record<string, readonly [number, number]>;

/** Four significant digits: short, stable data-params and labels. */
export function sig(n: number): number {
  const r = Number(n.toPrecision(4));
  return Object.is(r, -0) ? 0 : r;
}

function clampTo(n: number, [lo, hi]: readonly [number, number]): number {
  return Math.min(hi, Math.max(lo, n));
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A positive slider range, clamped and ordered; a collapsed range widens tenfold each way (both
 * sliders are log-mapped). Null when a number is missing or not finite.
 */
function clampRange(v: unknown, lim: readonly [number, number]): SimRange | null {
  if (!isObj(v) || !isNum(v.min) || !isNum(v.max) || !isNum(v.value)) return null;
  let min = clampTo(sig(v.min), lim);
  let max = clampTo(sig(v.max), lim);
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    min = clampTo(sig(min / 10), lim);
    max = clampTo(sig(max * 10), lim);
  }
  return { min, max, value: clampTo(sig(v.value), [min, max]) };
}

/** Presets clamped into the slider range, sorted, deduplicated, at most three; never empty. */
function clampPresets(v: unknown, r: SimRange): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const p of v) {
    if (!isNum(p)) return null;
    const c = clampTo(sig(p), [r.min, r.max]);
    if (!out.includes(c)) out.push(c);
  }
  out.sort((a, b) => a - b);
  return out.length ? out.slice(0, MAX_PRESETS) : [r.value];
}

const int = (n: number, lim: readonly [number, number]): number => clampTo(Math.round(n), lim);

/**
 * Validates and clamps raw explorable parameters (a draft block's `sim`, or a document's
 * data-params). Null: an unknown kind, surface or target, or a missing or non-finite number.
 */
export function clampSim(raw: unknown): ExplorableSim | null {
  if (!isObj(raw)) return null;
  if (raw.kind === 'gradient-descent') {
    const surface = raw.surface;
    if (typeof surface !== 'string' || !(SURFACES as readonly string[]).includes(surface)) return null;
    if (!isNum(raw.scale) || !isNum(raw.start) || !isNum(raw.steps)) return null;
    const lr = clampRange(raw.lr, LIMITS.lr);
    const presets = lr && clampPresets(raw.presets, lr);
    if (!lr || !presets) return null;
    return {
      kind: 'gradient-descent',
      surface: surface as Surface,
      scale: clampTo(sig(raw.scale), LIMITS.scale),
      start: clampTo(sig(raw.start), LIMITS.start),
      lr,
      steps: int(raw.steps, LIMITS.gdSteps),
      presets,
    };
  }
  if (raw.kind === 'metropolis-walk') {
    const target = raw.target;
    if (typeof target !== 'string' || !(TARGETS as readonly string[]).includes(target)) return null;
    if (!isNum(raw.start) || !isNum(raw.steps) || !isNum(raw.seed)) return null;
    const stepSize = clampRange(raw.stepSize, LIMITS.stepSize);
    const presets = stepSize && clampPresets(raw.presets, stepSize);
    if (!stepSize || !presets) return null;
    return {
      kind: 'metropolis-walk',
      target: target as Target,
      start: clampTo(sig(raw.start), LIMITS.start),
      stepSize,
      steps: int(raw.steps, LIMITS.mhSteps),
      seed: clampTo(Math.trunc(raw.seed), LIMITS.seed),
      presets,
    };
  }
  return null;
}

/** The slider range of a sim (learning rate or step size). */
export function sliderOf(sim: ExplorableSim): SimRange {
  return sim.kind === 'gradient-descent' ? sim.lr : sim.stepSize;
}

/** Slider position t in [0, 1] -> setting, log-mapped over the range. */
export function fromSlider(r: SimRange, t: number): number {
  const a = Math.log(r.min);
  const b = Math.log(r.max);
  return sig(Math.exp(a + Math.min(1, Math.max(0, t)) * (b - a)));
}

/** Setting -> slider position t in [0, 1]. */
export function toSlider(r: SimRange, v: number): number {
  const a = Math.log(r.min);
  const b = Math.log(r.max);
  return b === a ? 0 : Math.min(1, Math.max(0, (Math.log(v) - a) / (b - a)));
}
