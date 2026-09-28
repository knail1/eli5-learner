/** schemaVersion N -> N+1 steps (12 §4.2 step 3). Version 1 is the first; no steps yet. */
type Raw = Record<string, unknown>;
type Step = (raw: Raw) => Raw;

/** STEPS[n] migrates version n to n+1. */
const STEPS: Record<number, Step> = {};

export function migrate(raw: Raw, from: number): Raw {
  let out = raw;
  for (let v = Math.max(0, Math.floor(from)); STEPS[v]; v++) out = STEPS[v]!(out);
  out.schemaVersion = 1;
  return out;
}
