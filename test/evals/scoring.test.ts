import { describe, expect, it } from 'vitest';
import { aggregateRuns, compareBaseline, criterionMeans, mean, median, suiteScores, toBaseline } from './lib/scoring';
import type { Baseline, CaseResult, EvalResults, JudgeOutput } from './lib/types';

const run = (scores: Record<string, 1 | 2 | 3 | 4 | 5>, missing: string[] = []): JudgeOutput => ({
  scores,
  rationale: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, `${k} scored ${v}`])),
  missingFacts: missing,
});

const scored = (id: string, indepth: number, eli5: number, medians: Record<string, number>, section?: number) =>
  ({
    id,
    domain: 'general',
    status: 'scored',
    scores: { indepth, eli5, ...(section !== undefined ? { section } : {}) },
    indepth: { medians, score: indepth, rationale: {}, missingFacts: [], runs: [] },
  }) as CaseResult;

describe('median and mean (13 §9.3 step 5, §9.6)', () => {
  it('takes the middle value of an odd count and the mean of the middle two of an even count', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 2])).toBe(3);
    expect(median([2])).toBe(2);
    expect(() => median([])).toThrow();
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('aggregateRuns', () => {
  it('takes the median per criterion, the case score as the mean of medians, and a median-scoring rationale', () => {
    const part = aggregateRuns(
      [run({ D1: 5, D2: 2 }, ['fact a']), run({ D1: 3, D2: 4 }, ['Fact A', 'fact b']), run({ D1: 4, D2: 4 })],
      ['D1', 'D2'],
    );
    expect(part.medians).toEqual({ D1: 4, D2: 4 });
    expect(part.score).toBe(4);
    expect(part.rationale.D1).toBe('D1 scored 4');
    expect(part.rationale.D2).toBe('D2 scored 4');
    // Facts named by any run, de-duplicated case-insensitively.
    expect(part.missingFacts).toEqual(['fact a', 'fact b']);
    expect(part.runs).toHaveLength(3);
  });
});

describe('suite scores and criterion means (13 §9.6)', () => {
  const cases: CaseResult[] = [
    scored('a', 4, 3, { D1: 4, D2: 5 }, 5),
    scored('b', 2, 5, { D1: 2, D2: 3 }),
    { id: 'c', domain: 'data', status: 'gate_failed', scores: { indepth: 0, eli5: 0 } },
    { id: 'd', domain: 'data', status: 'judge_error', scores: {} },
    { id: 'e', domain: 'data', status: 'skipped_budget', scores: {} },
  ];

  it('averages case scores per part; gate failures count as 0; judge errors and budget skips are excluded', () => {
    expect(suiteScores(cases)).toEqual({ indepth: 2, eli5: 8 / 3, section: 5 });
    expect(suiteScores([])).toEqual({ indepth: null, eli5: null, section: null });
  });

  it('averages each criterion over scored cases', () => {
    expect(criterionMeans(cases)).toEqual({ D1: 3, D2: 4 });
  });
});

describe('baseline regression rule (13 §9.6)', () => {
  const base: Baseline = {
    schemaVersion: 1,
    provider: 'claude',
    model: 'm',
    date: '2026-09-01',
    judge: { provider: 'openai', model: 'j' },
    suite: { indepth: 4, eli5: 4, section: null },
    criteria: { D1: 4, D2: 4 },
    cases: {
      a: { scores: { indepth: 4, eli5: 4 }, medians: { D1: 4, D2: 4 } },
      b: { scores: { indepth: 4, eli5: 4 }, medians: { D1: 4, D2: 4 } },
      z: { scores: { indepth: 1, eli5: 1 }, medians: { D1: 1, D2: 1 } },
    },
  };

  it('flags a suite drop > 0.3 over the cases both runs scored', () => {
    const r = compareBaseline(
      [scored('a', 3.6, 4, { D1: 4, D2: 4 }), scored('b', 3.6, 4, { D1: 4, D2: 4 })],
      base,
      'b',
    );
    expect(r.comparedCases).toEqual(['a', 'b']);
    expect(r.suiteDelta.indepth).toBeCloseTo(-0.4);
    expect(r.regressed).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/indepth/);
  });

  it('flags a criterion mean drop > 0.5 even when the suite holds', () => {
    const r = compareBaseline(
      [scored('a', 4, 4, { D1: 3.4, D2: 4 }), scored('b', 4, 4, { D1: 3.4, D2: 4 })],
      base,
      'b',
    );
    expect(r.criterionDelta.D1).toBeCloseTo(-0.6);
    expect(r.regressed).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/D1/);
  });

  it('does not flag drops at the threshold', () => {
    const r = compareBaseline(
      [scored('a', 3.7, 4, { D1: 3.5, D2: 4 }), scored('b', 3.7, 4, { D1: 3.5, D2: 4 })],
      base,
      'b',
    );
    expect(r.regressed).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('builds a baseline from a results file', () => {
    const results = {
      provider: 'claude',
      model: 'm',
      date: '2026-09-02',
      judge: { provider: 'openai', model: 'j', runs: 3 },
      suite: { indepth: 4, eli5: 3, section: null },
      criteria: { D1: 4 },
      cases: [scored('a', 4, 3, { D1: 4 }), { id: 'd', domain: 'data', status: 'judge_error', scores: {} }],
    } as unknown as EvalResults;
    expect(toBaseline(results)).toEqual({
      schemaVersion: 1,
      provider: 'claude',
      model: 'm',
      date: '2026-09-02',
      judge: { provider: 'openai', model: 'j' },
      suite: { indepth: 4, eli5: 3, section: null },
      criteria: { D1: 4 },
      cases: { a: { scores: { indepth: 4, eli5: 3 }, medians: { D1: 4 } } },
    });
  });
});
