// Outcome words and table rows (07 §7.1, design D8): computed by code from the simulation, never
// written by the model, and used everywhere (static SVG labels, the details table, Markdown and the
// runtime's status line), so text and animation cannot disagree.
import { sig, type ExplorableSim } from './clamp';
import { runGD, type GdOutcome } from './gd';
import { runMH, type MhOutcome } from './mh';

export type Outcome = GdOutcome | MhOutcome;

/** A number as people read it: four significant digits, no exponent for ordinary values. */
export function fmtNum(n: number): string {
  const v = sig(n);
  return Math.abs(v) >= 1e-6 || v === 0 ? String(v) : v.toExponential();
}

/** "learning rate" or "step size". */
export function settingName(sim: ExplorableSim): string {
  return sim.kind === 'gradient-descent' ? 'learning rate' : 'step size';
}

/** Short prefix for direct labels: "lr 0.1", "step 1". */
export function settingShort(sim: ExplorableSim, v: number): string {
  return `${sim.kind === 'gradient-descent' ? 'lr' : 'step'} ${fmtNum(v)}`;
}

export interface OutcomeRow {
  setting: number;
  outcome: Outcome;
  /** Steps run (gradient descent) or proposals made (walk). */
  steps: number;
  /** "x = 0.004" or "71% accepted". */
  result: string;
  /** Direct label: "lr 0.1: converges", "lr 1.5: diverges after 12 steps". */
  label: string;
}

/** One row for setting `v` of `sim`. */
export function outcomeRow(sim: ExplorableSim, v: number): OutcomeRow {
  if (sim.kind === 'gradient-descent') {
    const run = runGD(sim, v);
    const last = run.xs[run.xs.length - 1] ?? sim.start;
    const tail =
      run.outcome === 'diverges'
        ? ` after ${run.steps} step${run.steps === 1 ? '' : 's'}`
        : run.outcome === 'converges' && run.steps < sim.steps
          ? ` in ${run.steps} step${run.steps === 1 ? '' : 's'}`
          : '';
    return {
      setting: v,
      outcome: run.outcome,
      steps: run.steps,
      result: run.outcome === 'diverges' ? 'flew off' : `x = ${fmtNum(last)}`,
      label: `${settingShort(sim, v)}: ${run.outcome}${tail}`,
    };
  }
  const run = runMH(sim, v);
  const pct = Math.round(run.rate * 100);
  return {
    setting: v,
    outcome: run.outcome,
    steps: sim.steps,
    result: `${pct}% accepted`,
    label: `${settingShort(sim, v)}: ${run.outcome} (${pct}% accepted)`,
  };
}

/** One row per preset, in preset order. */
export function outcomeRows(sim: ExplorableSim): OutcomeRow[] {
  return sim.presets.map((p) => outcomeRow(sim, p));
}
