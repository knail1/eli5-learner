import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_MAE, agreement, loadCalibrationDocs, runCalibration } from './lib/calibrate';
import { criteriaFor, loadJudgeTemplate, loadRubrics, type JudgeRequest } from './lib/judge';
import { EVAL_SECTION_ACTIONS } from './lib/types';

const docs = loadCalibrationDocs();

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'eli5-cal-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('calibration set (13 §9.5)', () => {
  it('has 10 hand-scored synthetic documents covering the full score range', () => {
    expect(docs).toHaveLength(10);
    const scores = docs.flatMap((d) => [...Object.values(d.human.indepth), ...Object.values(d.human.eli5)]);
    expect(Math.min(...scores)).toBe(1);
    expect(Math.max(...scores)).toBe(5);
    for (const d of docs) {
      const expected = ['D1', 'D2', 'D3', 'D4', 'D5', ...(d.glossary ? ['D6'] : []), 'D7'];
      expect(Object.keys(d.human.indepth), d.id).toEqual(expected);
      expect(Object.keys(d.human.eli5), d.id).toEqual(['E1', 'E2', 'E3', 'E4', 'E5']);
    }
  });
});

describe('calibration section actions (13 §9.4 S1-S3, §9.5)', () => {
  const samples = docs.flatMap((d) => (d.sectionActions ?? []).map((a) => ({ doc: d.id, ...a })));

  it('has hand-scored section-action samples for every action, S1-S3 and the full score range', () => {
    expect(samples.length).toBeGreaterThanOrEqual(10);
    expect(new Set(samples.map((a) => a.action))).toEqual(new Set(EVAL_SECTION_ACTIONS));
    for (const a of samples) {
      expect(Object.keys(a.human), a.doc).toEqual(criteriaFor('section', { note: a.note !== undefined }));
    }
    expect(samples.filter((a) => a.note !== undefined).length).toBeGreaterThanOrEqual(5);
    const scores = samples.flatMap((a) => Object.values(a.human));
    expect(Math.min(...scores)).toBe(1);
    expect(Math.max(...scores)).toBe(5);
  });
});

describe('agreement (MAE per criterion)', () => {
  it('computes mean absolute error per criterion and passes only when every MAE <= 0.75', () => {
    const a = agreement([
      { judge: { D1: 5, E1: 2 }, human: { D1: 4, E1: 2 } },
      { judge: { D1: 3, E1: 2 }, human: { D1: 3, E1: 4 } },
    ]);
    expect(a.criteria).toEqual({ D1: { mae: 0.5, n: 2 }, E1: { mae: 1, n: 2 } });
    expect(a.pass).toBe(false);
    expect(a.failing).toEqual(['E1']);
    expect(MAX_MAE).toBe(0.75);
    expect(agreement([{ judge: { D1: 4 }, human: { D1: 4.75 } }]).pass).toBe(true);
  });
});

describe('runCalibration', () => {
  it('judges every document tab and section sample N times, reports MAE per criterion and writes the report', async () => {
    // What a judge request grades: a section rewrite, or a whole tab.
    const graded: { marker: string; human: Record<string, number> }[] = [
      ...docs.flatMap((d) => (d.sectionActions ?? []).map((a) => ({ marker: a.after, human: a.human }))),
      ...docs.flatMap((d) => (['indepth', 'eli5'] as const).map((t) => ({ marker: d.tabs[t], human: d.human[t] }))),
    ];
    const calls: JudgeRequest[] = [];
    // A judge that returns the human score, off by one on E5 for every document.
    const judge = async (r: JudgeRequest): Promise<string> => {
      calls.push(r);
      const human = graded.find((g) => r.user.includes(g.marker))?.human ?? {};
      const criteria = /and no others: ([A-Z0-9, ]+)\./.exec(r.system)?.[1]?.split(', ') ?? [];
      const scores = Object.fromEntries(
        criteria.map((c) => [c, c === 'E5' ? (human[c] === 5 ? 4 : (human[c] ?? 3) + 1) : (human[c] ?? 3)]),
      );
      return JSON.stringify({ scores, rationale: {}, missingFacts: [] });
    };
    const lines: string[] = [];
    const run = () =>
      runCalibration({
        docs,
        rubrics: loadRubrics(),
        template: loadJudgeTemplate(),
        judge,
        judgeRuns: 1,
        info: { provider: 'openai', model: 'fake-judge' },
        resultsDir: tmp,
        now: () => new Date('2026-09-28T00:00:00.000Z'),
        log: (l) => lines.push(l),
      });
    const { report, file } = await run();
    const sections = docs.flatMap((d) => d.sectionActions ?? []);
    expect(calls).toHaveLength(20 + sections.length);
    // The section judge sees the action, the note and the section before the action.
    const first = sections[0];
    const req = calls.find((c) => first !== undefined && c.user.includes(first.after));
    expect(req?.user).toContain(first?.before.split('\n')[1] ?? '-');
    expect(req?.system).toContain('Action honored');
    expect(report.criteria.D1).toEqual({ mae: 0, n: 10 });
    expect(report.criteria.D6?.n).toBe(9); // glossary off for one document
    expect(report.criteria.E5).toEqual({ mae: 1, n: 10 });
    expect(report.criteria.S1).toEqual({ mae: 0, n: sections.length });
    expect(report.criteria.S2).toEqual({ mae: 0, n: sections.length });
    expect(report.criteria.S3).toEqual({ mae: 0, n: sections.filter((a) => a.note !== undefined).length });
    expect(report.docs.filter((d) => d.tab === 'section')).toHaveLength(sections.length);
    expect(report.pass).toBe(false);
    expect(report.failing).toEqual(['E5']);
    expect(path.basename(file)).toBe('calibration-2026-09-28-openai-fake-judge.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(report);
    expect(lines.at(-1)).toMatch(/FAIL.*E5/);
    // A second calibration the same day keeps the first report.
    const again = await run();
    expect(again.file).not.toBe(file);
    expect(existsSync(file)).toBe(true);
  });
});
