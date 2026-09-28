/**
 * The eval runner end to end, offline (13 §9.3, §9.6): the real pipeline headless with FakeProvider
 * as the generator and a scripted judge, both behind the devtools BudgetGuardProvider and one
 * BudgetLedger, exactly as a real run wires them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BudgetLedger, MIN_OUTPUT_TOKENS } from '../../src/main/devtools';
import {
  fallbackLimits,
  type ConnectionCheck,
  type GenerationRequest,
  type GenerationResult,
  type LLMProvider,
} from '../../src/main/llm';
import { FakeProvider, loadFakeScript } from '../../src/main/llm/testing/fake';
import { loadCases, selectCases } from './lib/cases';
import { loadJudgeTemplate, loadRubrics } from './lib/judge';
import { RecordingProvider, evalSettings, guard, judgeFnFor } from './lib/providers';
import { runEval, type RunEvalOptions } from './lib/runner';
import type { Baseline, EvalCase } from './lib/types';

const REPO = path.resolve(import.meta.dirname, '../..');
const RATES = { inputPerMTok: 1, outputPerMTok: 5 };
const rubrics = loadRubrics();
const template = loadJudgeTemplate();
const all = loadCases();

/** Scores every requested criterion from `score(runIndex)`; the criteria are read from the prompt. */
class ScriptedJudge implements LLMProvider {
  readonly id = 'openai' as const;
  readonly model = 'fake-judge';
  readonly limits = fallbackLimits('openai');
  calls: { images: number; system: string; user: string }[] = [];
  constructor(private readonly reply: (criteria: string[], call: number, user: string) => string) {}
  generate(req: GenerationRequest): Promise<GenerationResult> {
    return this.answer(req);
  }
  generateWithImages(req: GenerationRequest): Promise<GenerationResult> {
    return this.answer(req);
  }
  testConnection(): Promise<ConnectionCheck> {
    return Promise.resolve({ ok: true, model: this.model });
  }
  private async answer(req: GenerationRequest): Promise<GenerationResult> {
    const criteria = /and no others: ([A-Z0-9, ]+)\./.exec(req.system)?.[1]?.split(', ') ?? [];
    const user = req.messages[0]?.text ?? '';
    this.calls.push({ images: req.messages[0]?.images?.length ?? 0, system: req.system, user });
    const text = this.reply(criteria, this.calls.length - 1, user);
    return {
      text,
      stopReason: 'end',
      usage: {
        inputTokens: Math.ceil((req.system.length + user.length) / 4),
        outputTokens: Math.ceil(text.length / 4),
      },
      model: this.model,
      provider: this.id,
      latencyMs: 0,
      attempts: 1,
    };
  }
}

/** Runs cycle 5, 3, 4: the median is 4 for every criterion. */
const cycling = (criteria: string[], call: number): string =>
  JSON.stringify({
    scores: Object.fromEntries(criteria.map((c) => [c, [5, 3, 4][call % 3]])),
    rationale: Object.fromEntries(criteria.map((c) => [c, `JUDGE-RATIONALE ${c}`])),
    missingFacts: [],
  });

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'eli5-evals-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface Rig {
  opts: RunEvalOptions;
  fake: FakeProvider;
  judge: ScriptedJudge;
  ledger: BudgetLedger;
  lines: string[];
}

let rigs = 0;
function rig(
  cases: EvalCase[],
  o: { capUsd?: number; minCaseUsd?: number; reply?: ScriptedJudge['reply']; baseline?: boolean } = {},
): Rig {
  const dir = path.join(tmp, `rig-${++rigs}`);
  const script = loadFakeScript(path.join(REPO, 'test/fixtures/llm/default.json'), (p) => readFileSync(p, 'utf8'));
  const fake = new FakeProvider(script, { id: 'claude', model: 'fake-model' });
  const judge = new ScriptedJudge(o.reply ?? cycling);
  const ledger = new BudgetLedger({ path: path.join(dir, 'ledger.jsonl'), capUsd: o.capUsd ?? 100 });
  const lines: string[] = [];
  return {
    fake,
    judge,
    ledger,
    lines,
    opts: {
      cases,
      rubrics,
      template,
      generator: new RecordingProvider(guard(fake, ledger, RATES)),
      judge: judgeFnFor(guard(judge, ledger, RATES)),
      judgeRuns: 3,
      ledger,
      minCaseUsd: o.minCaseUsd ?? (MIN_OUTPUT_TOKENS * RATES.outputPerMTok) / 1e6,
      settings: evalSettings('claude', 'fake-model'),
      info: { provider: 'claude', model: 'fake-model', judge: { provider: 'openai', model: 'fake-judge' } },
      resultsDir: path.join(dir, 'results'),
      baselinesDir: path.join(dir, 'baselines'),
      workDir: path.join(dir, 'work'),
      now: () => new Date('2026-09-28T03:00:00.000Z'),
      log: (l) => lines.push(l),
    },
  };
}

/** A case the default fake script passes the jargon gate on (its glossary anchors "SKU"). */
const fakeGlossaryCase: EvalCase = {
  id: 'fake-glossary-sections',
  domain: 'security',
  sources: ['evals/security/access-review-standard.docx.json'],
  clarifying: 'CLARIFY-MARKER',
  glossary: true,
  mustCover: ['least privilege'],
  jargon: ['SKU'],
  sectionActions: [
    { action: 'analogy', sectionHint: 'forecast', note: 'Use a kitchen analogy' },
    { action: 'section-eli5', sectionHint: 'watch' },
  ],
};

describe('runEval end to end (FakeProvider generator, scripted judge, no network)', () => {
  it('generates, gates, judges N times, scores, and writes a results file with no source text or model output', async () => {
    const cases = [
      ...selectCases(all, ['general-ops-pdf', 'security-soc-screenshot', 'security-advisory-url-skipped']),
      fakeGlossaryCase,
    ];
    const r = rig(cases);
    const { results, file } = await runEval(r.opts);

    expect(results.cases.map((c) => [c.id, c.status])).toEqual([
      ['general-ops-pdf', 'scored'],
      ['security-advisory-url-skipped', 'gate_failed'],
      ['security-soc-screenshot', 'gate_failed'],
      ['fake-glossary-sections', 'scored'],
    ]);
    const [ops, advisory, soc, fake] = results.cases;
    // Glossary off: D6 is not scored.
    expect(Object.keys(ops?.indepth?.medians ?? {})).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D7']);
    expect(ops?.scores).toEqual({ indepth: 4, eli5: 4 });
    // Gate failures score 0 without a judge call; the skipped login-wall source is recorded.
    expect(soc?.scores).toEqual({ indepth: 0, eli5: 0 });
    expect(soc?.gates?.failures).toEqual([
      { gate: 'jargon', detail: 'SIEM' },
      { gate: 'jargon', detail: 'false positive' },
      { gate: 'jargon', detail: 'triage' },
    ]);
    expect(advisory?.skippedSources).toEqual([expect.objectContaining({ code: 'login-required' })]);
    // Section actions: an in-place analogy with a note (S3 scored) and a Section ELI5 tab (no S3).
    expect(fake?.sections?.map((s) => [s.action, Object.keys(s.medians)])).toEqual([
      ['analogy', ['S1', 'S2', 'S3']],
      ['section-eli5', ['S1', 'S2']],
    ]);
    expect(fake?.scores).toEqual({ indepth: 4, eli5: 4, section: 4 });
    expect(fake?.indepth?.runs).toHaveLength(3);
    // Judge calls: 3 per tab for 2 scored cases, 3 per section action: none for gate failures.
    expect(r.judge.calls).toHaveLength(3 * 2 * 2 + 3 * 2);

    // The built sources reached the pipeline: the docx spec as text, the PNG as a vision image.
    const prompts = r.fake.calls.filter((c) => c.taskId === 'in-depth');
    expect(prompts.some((c) => c.messages[0]?.text.includes('least privilege'))).toBe(true);
    expect(r.fake.calls.some((c) => c.taskId === 'in-depth' && c.imageCount > 0)).toBe(true);
    // The judge saw the extracted source text, the clarifying input and the tab text.
    const first = r.judge.calls.find((c) => c.user.includes('CLARIFY-MARKER'));
    expect(first?.user).toContain('least privilege');
    expect(first?.system).toContain('Accuracy');

    // Suite: gate failures count as 0.
    expect(results.suite).toEqual({ indepth: 2, eli5: 2, section: 4 });
    expect(results.criteria.D1).toBe(4);
    expect(results.status).toBe('complete');
    expect(results.judge).toEqual({ provider: 'openai', model: 'fake-judge', runs: 3 });
    expect(results.costUsd).toBeGreaterThan(0);
    expect(results.regression).toBeNull();
    expect(results.notes.join(' ')).toMatch(/No baseline/);

    expect(path.basename(file)).toBe('2026-09-28-claude-fake-model.json');
    const written = readFileSync(file, 'utf8');
    expect(JSON.parse(written)).toEqual(results);
    // 13 §9.6: scores, rationales and missing facts only; never source text or model output.
    const outputs = [written, ...r.lines].join('\n');
    for (const secret of [
      'least privilege',
      'Operations Review',
      'Plans Its Widget Supply',
      'Widgets, explained simply',
    ]) {
      expect(outputs).not.toContain(secret);
    }
    expect(written).toContain('JUDGE-RATIONALE D1');
    expect(r.lines.at(-1)).toMatch(/^\[eval\] complete: indepth=2\.00 eli5=2\.00 section=4\.00 cost=\$/);

    // Generator and judge spent through one ledger.
    const ledgerLines = readFileSync(r.ledger.path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { taskId: string });
    expect(new Set(ledgerLines.map((l) => l.taskId))).toEqual(
      new Set(['in-depth', 'eli5', 'glossary', 'summary', 'section-analogy', 'section-eli5-tab']),
    );
  });

  it('stops scheduling new cases once the cap is reached and reports incomplete (13 §9.6, §14)', async () => {
    const cases = selectCases(all, ['general-ops-pdf', 'general-plain-text']);
    // The first case starts with the full cap; after its spend less than minCaseUsd remains.
    const r = rig(cases, { capUsd: 5, minCaseUsd: 4.999 });
    const { results } = await runEval(r.opts);
    expect(results.cases.map((c) => c.status)).toEqual(['scored', 'skipped_budget']);
    expect(results.status).toBe('incomplete');
    expect(results.regression).toBeNull();
    expect(results.notes.join(' ')).toMatch(/Cost cap reached/);
    expect(results.suite.indepth).toBe(4); // skipped cases are not in the means
    expect(r.lines).toContain('[eval] general-plain-text: skipped_budget');
  });

  it('marks a case skipped_budget when the guard refuses mid-case, and skips the rest', async () => {
    const r = rig(selectCases(all, ['general-ops-pdf', 'general-plain-text']), { capUsd: 0.015, minCaseUsd: 0 });
    const { results } = await runEval(r.opts);
    expect(results.cases.map((c) => c.status)).toEqual(['skipped_budget', 'skipped_budget']);
    expect(results.status).toBe('incomplete');
    expect(r.judge.calls).toEqual([]);
    expect(results.costUsd).toBeLessThanOrEqual(0.015);
  });

  it('a judge that returns invalid JSON twice marks the case judge_error, excluded from the means', async () => {
    const r = rig(selectCases(all, ['general-ops-pdf', 'general-plain-text']), {
      reply: (criteria, call, user) => (user.includes('Weekly operations note') ? 'not json' : cycling(criteria, call)),
    });
    const { results } = await runEval(r.opts);
    expect(results.cases.map((c) => [c.id, c.status])).toEqual([
      ['general-ops-pdf', 'scored'],
      ['general-plain-text', 'judge_error'],
    ]);
    expect(results.suite).toEqual({ indepth: 4, eli5: 4, section: null });
    const retries = r.judge.calls.filter((c) => c.user.includes('Weekly operations note'));
    expect(retries).toHaveLength(2);
    expect(retries[1]?.user).toMatch(/previous reply was rejected/);
  });

  it('compares with baselines/<provider>.json and flags a regression; writes a baseline on request', async () => {
    const r = rig(selectCases(all, ['general-ops-pdf']));
    const base: Baseline = {
      schemaVersion: 1,
      provider: 'claude',
      model: 'fake-model',
      date: '2026-09-01',
      judge: { provider: 'openai', model: 'fake-judge' },
      suite: { indepth: 5, eli5: 4, section: null },
      criteria: { D1: 5 },
      cases: {
        'general-ops-pdf': {
          scores: { indepth: 5, eli5: 4 },
          medians: { D1: 5, D2: 4, D3: 4, D4: 4, D5: 4, D7: 4, E1: 4, E2: 4, E3: 4, E4: 4, E5: 4 },
        },
      },
    };
    await mkdir(r.opts.baselinesDir, { recursive: true });
    await writeFile(path.join(r.opts.baselinesDir, 'claude.json'), JSON.stringify(base));
    const { results } = await runEval(r.opts);
    expect(results.regression?.regressed).toBe(true);
    expect(results.regression?.comparedCases).toEqual(['general-ops-pdf']);
    expect(results.regression?.reasons.join(' ')).toMatch(/D1 mean fell 1\.00/);
    expect(r.lines.some((l) => /regression=YES/.test(l))).toBe(true);

    const w = rig(selectCases(all, ['general-ops-pdf']));
    await runEval({ ...w.opts, writeBaseline: true });
    const file = path.join(w.opts.baselinesDir, 'claude.json');
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, 'utf8')) as Baseline;
    expect(written.cases['general-ops-pdf']?.scores).toEqual({ indepth: 4, eli5: 4 });
    expect(written.suite).toEqual({ indepth: 4, eli5: 4, section: null });
  });
});
