/**
 * Scoring (13 §9.3 step 5, §9.6): median of judge runs per criterion, case score = mean of the
 * medians, suite score per part = mean of case scores, and the baseline regression rule.
 */
import type {
  Baseline,
  CaseResult,
  EvalResults,
  JudgedPart,
  JudgeOutput,
  RegressionReport,
  Score,
  SuiteScores,
} from './types';

/** 13 §9.6 regression thresholds. */
export const SUITE_DROP = 0.3;
export const CRITERION_DROP = 0.5;
const EPS = 1e-9;

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('mean of an empty list');
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('median of an empty list');
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Medians per criterion over the judge runs, plus a rationale from a run that scored the median. */
export function aggregateRuns(runs: readonly JudgeOutput[], criteria: readonly string[]): JudgedPart {
  const medians: Record<string, number> = {};
  const rationale: Record<string, string> = {};
  for (const c of criteria) {
    const values = runs.map((r) => r.scores[c] as number);
    const m = median(values);
    medians[c] = m;
    // The run closest to the median explains it best.
    const best = runs.reduce((a, b) =>
      Math.abs((b.scores[c] as number) - m) < Math.abs((a.scores[c] as number) - m) ? b : a,
    );
    rationale[c] = best.rationale[c] ?? '';
  }
  const seen = new Set<string>();
  const missingFacts: string[] = [];
  for (const f of runs.flatMap((r) => r.missingFacts)) {
    const k = f.trim().toLowerCase();
    if (k === '' || seen.has(k)) continue;
    seen.add(k);
    missingFacts.push(f.trim());
  }
  return {
    medians,
    score: mean(Object.values(medians)),
    rationale,
    missingFacts,
    runs: runs.map((r) => Object.fromEntries(criteria.map((c) => [c, r.scores[c] as Score]))),
  };
}

/** Statuses whose part scores count in the suite: scored cases, and gate/generation failures as 0. */
const COUNTED = new Set<CaseResult['status']>(['scored', 'gate_failed', 'generation_failed']);

const PARTS = ['indepth', 'eli5', 'section'] as const;

function suiteOf(scores: CaseResult['scores'][]): SuiteScores {
  const out: SuiteScores = { indepth: null, eli5: null, section: null };
  for (const p of PARTS) {
    const xs = scores.map((s) => s[p]).filter((x): x is number => typeof x === 'number');
    out[p] = xs.length ? mean(xs) : null;
  }
  return out;
}

export function suiteScores(cases: readonly CaseResult[]): SuiteScores {
  return suiteOf(cases.filter((c) => COUNTED.has(c.status)).map((c) => c.scores));
}

/** Every criterion median of one case; section actions are averaged per criterion. */
export function caseMedians(c: CaseResult): Record<string, number> {
  const out: Record<string, number> = { ...(c.indepth?.medians ?? {}), ...(c.eli5?.medians ?? {}) };
  const sec: Record<string, number[]> = {};
  for (const s of c.sections ?? []) for (const [k, v] of Object.entries(s.medians)) (sec[k] ??= []).push(v);
  for (const [k, vs] of Object.entries(sec)) out[k] = mean(vs);
  return out;
}

function meansOf(medians: Record<string, number>[]): Record<string, number> {
  const acc: Record<string, number[]> = {};
  for (const m of medians) for (const [k, v] of Object.entries(m)) (acc[k] ??= []).push(v);
  return Object.fromEntries(
    Object.keys(acc)
      .sort()
      .map((k) => [k, mean(acc[k] as number[])]),
  );
}

/** Criterion means over scored cases (gate failures have no per-criterion scores). */
export function criterionMeans(cases: readonly CaseResult[]): Record<string, number> {
  return meansOf(cases.filter((c) => c.status === 'scored').map(caseMedians));
}

/**
 * 13 §9.6: a suite drop > 0.3 or any criterion mean drop > 0.5 is a regression. Compared over the
 * cases both runs scored, so a subset run (ELI5_EVAL_CASES) is compared like for like.
 */
export function compareBaseline(cases: readonly CaseResult[], base: Baseline, label: string): RegressionReport {
  const now = cases.filter((c) => COUNTED.has(c.status) && base.cases[c.id] !== undefined);
  const ids = now.map((c) => c.id);
  const cur = suiteOf(now.map((c) => c.scores));
  const prev = suiteOf(ids.map((id) => base.cases[id]?.scores ?? {}));
  const curCrit = meansOf(now.filter((c) => c.status === 'scored').map(caseMedians));
  const prevCrit = meansOf(now.filter((c) => c.status === 'scored').map((c) => base.cases[c.id]?.medians ?? {}));
  const reasons: string[] = [];
  const suiteDelta: SuiteScores = { indepth: null, eli5: null, section: null };
  for (const p of PARTS) {
    const a = cur[p];
    const b = prev[p];
    if (a === null || b === null) continue;
    suiteDelta[p] = a - b;
    if (b - a > SUITE_DROP + EPS) reasons.push(`${p} suite score fell ${(b - a).toFixed(2)} (> ${SUITE_DROP})`);
  }
  const criterionDelta: Record<string, number> = {};
  for (const [k, a] of Object.entries(curCrit)) {
    const b = prevCrit[k];
    if (b === undefined) continue;
    criterionDelta[k] = a - b;
    if (b - a > CRITERION_DROP + EPS) reasons.push(`${k} mean fell ${(b - a).toFixed(2)} (> ${CRITERION_DROP})`);
  }
  return { baseline: label, comparedCases: ids, regressed: reasons.length > 0, reasons, suiteDelta, criterionDelta };
}

/** The committed baseline form of a results file (13 §9.6: updated only with the results file). */
export function toBaseline(r: EvalResults): Baseline {
  const cases: Baseline['cases'] = {};
  for (const c of r.cases) {
    if (!COUNTED.has(c.status)) continue;
    cases[c.id] = { scores: c.scores, medians: caseMedians(c) };
  }
  return {
    schemaVersion: 1,
    provider: r.provider,
    model: r.model,
    date: r.date,
    judge: { provider: r.judge.provider, model: r.judge.model },
    suite: r.suite,
    criteria: r.criteria,
    cases,
  };
}
