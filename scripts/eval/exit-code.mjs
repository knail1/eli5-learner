// @ts-check
/**
 * Exit code of `scripts/eval/run.mjs` from the run's summary (13 §9.1, §9.5, §9.6):
 * 0 done (a cost-capped, incomplete run too), 1 run error (no summary), 2 regression vs the baseline
 * or calibration MAE above 0.75, 3 inconclusive (a case could not be judged, the run aborted, or no
 * case matched the baseline).
 *
 * @param {{ calibrate: boolean; vitest: number; summary: { status?: string; regressed?: boolean; pass?: boolean } | undefined }} o
 * @returns {number}
 */
export function exitCode(o) {
  const s = o.summary;
  if (!s) return o.vitest === 0 ? 1 : o.vitest;
  if (o.calibrate) return s.pass === false ? 2 : o.vitest;
  if (s.regressed === true) return 2;
  if (s.status === 'inconclusive') return 3;
  return o.vitest;
}
