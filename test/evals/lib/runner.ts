/**
 * Eval runner (13 §9.3, §9.6). For each case, in order: stop scheduling when the budget is spent,
 * run the real pipeline headless, apply the deterministic gates, judge each tab N times (median),
 * run and judge section actions, then score the suite, compare with the baseline and write the
 * results file. Logs carry ids, statuses and scores only: never source text or model output.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Settings } from '../../../src/main/config/schema';
import type { SectionId } from '../../../src/main/document';
import { LLMError } from '../../../src/main/llm';
import type { MenuAction } from '../../../src/preload/contract';
import { startFixtureServer, type FixtureServer } from '../../helpers/fixture-server';
import { runGates } from './gates';
import { createHarness, type Harness, type SavedDoc, type SectionInfo } from './harness';
import { JudgeError, criteriaFor, judgePart, type JudgeFn } from './judge';
import type { RecordingProvider } from './providers';
import { compareBaseline, criterionMeans, mean, suiteScores, toBaseline } from './scoring';
import { resolveCaseSources } from './sources';
import { sectionText, tabText } from './text';
import type {
  Baseline,
  CaseResult,
  EvalCase,
  EvalResults,
  EvalSectionAction,
  JudgedPart,
  Rubrics,
  SectionPartResult,
} from './types';

/** Source text sent to the judge is capped so one huge case cannot blow the judge's context. */
export const MAX_JUDGE_SOURCE_CHARS = 300_000;
const NEIGHBOUR_CHARS = 1_500;

const ACTION_MEANING: Record<EvalSectionAction, string> = {
  expand: 'expand: add more detail and explanation to this section',
  reexplain: 'reexplain: explain the same content more clearly, a different way',
  analogy: 'analogy: add an apt analogy that makes the idea click',
  deeper: 'deeper: go into more technical depth for an expert-curious reader',
  'section-eli5': 'section ELI5: a new tab explaining just this section as simply as possible',
};
const MENU_ACTION: Record<EvalSectionAction, MenuAction> = {
  expand: 'expand',
  reexplain: 'reexplain',
  analogy: 'analogy',
  deeper: 'deeper',
  'section-eli5': 'eli5-tab',
};

export interface BudgetView {
  readonly remainingUsd: number;
  readonly spentUsd: number;
  readonly capUsd: number;
}

export interface RunEvalOptions {
  cases: readonly EvalCase[];
  rubrics: Rubrics;
  template: string;
  /** The budget-guarded generator, wrapped in a recorder (source text for the judge). */
  generator: RecordingProvider;
  /** The budget-guarded judge. */
  judge: JudgeFn;
  judgeRuns: number;
  ledger: BudgetView;
  /** No new case starts below this remaining budget (the guard's own refusal floor). */
  minCaseUsd: number;
  settings: Settings;
  info: { provider: string; model: string; judge: { provider: string; model: string } };
  resultsDir: string;
  baselinesDir: string;
  writeBaseline?: boolean;
  workDir: string;
  now?: () => Date;
  log?: (line: string) => void;
}

class BudgetStop extends Error {}

const isBudgetError = (e: unknown): boolean =>
  e instanceof LLMError && e.kind === 'cancelled' && /budget/i.test(e.message);

const fmt = (n: number | undefined): string => (n === undefined ? '-' : n.toFixed(2));
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n[truncated]` : s);

function caseContext(c: EvalCase, doc: SavedDoc): string {
  const used = doc.meta.sourcesUsed.map((s) => `- ${s.ref}`).join('\n') || '- (none)';
  const skipped = doc.meta.sourcesSkipped.map((s) => `- ${s.ref}: ${s.reason}`).join('\n') || '- (none)';
  return [
    `Clarifying input from the reader: ${c.clarifying ?? 'none'}`,
    `Glossary requested: ${c.glossary ? 'yes' : 'no'}`,
    `Sources the app used:\n${used}`,
    `Sources the app skipped (with reason):\n${skipped}`,
  ].join('\n');
}

function pickSection(sections: SectionInfo[], hint: string): SectionInfo | undefined {
  const usable = sections.filter((s) => s.kind !== 'references');
  const h = hint.toLowerCase();
  return usable.find((s) => s.heading.toLowerCase().includes(h)) ?? usable[Math.min(1, usable.length - 1)];
}

export async function runEval(o: RunEvalOptions): Promise<{ results: EvalResults; file: string }> {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const started = now();
  const date = started.toISOString().slice(0, 10);
  const spentAtStart = o.ledger.spentUsd;
  const notes: string[] = [];
  const results: CaseResult[] = [];
  const server: FixtureServer = await startFixtureServer({ slowMs: 2_000 });
  let harness: Harness | undefined;
  let stopped = false;

  const judgeWith = async (
    part: 'indepth' | 'eli5' | 'section',
    input: Omit<Parameters<typeof judgePart>[1], 'part'>,
  ): Promise<JudgedPart> => {
    try {
      return await judgePart(o.judge, { ...input, part }, o.rubrics[part], o.template, o.judgeRuns);
    } catch (e) {
      if (isBudgetError(e)) throw new BudgetStop();
      throw e;
    }
  };

  try {
    harness = await createHarness({
      provider: o.generator,
      settings: o.settings,
      workDir: path.join(o.workDir, 'app'),
      now,
    });
    for (const c of o.cases) {
      if (stopped || o.ledger.remainingUsd < o.minCaseUsd) {
        stopped = true;
        results.push({ id: c.id, domain: c.domain, status: 'skipped_budget', scores: {} });
        log(`[eval] ${c.id}: skipped_budget`);
        continue;
      }
      let r: CaseResult;
      try {
        r = await runCase(c, harness);
      } catch (e) {
        if (!(e instanceof BudgetStop)) throw e;
        stopped = true;
        r = { id: c.id, domain: c.domain, status: 'skipped_budget', scores: {} };
      }
      results.push(r);
      log(
        `[eval] ${c.id}: ${r.status} indepth=${fmt(r.scores.indepth)} eli5=${fmt(r.scores.eli5)} section=${fmt(r.scores.section)}`,
      );
    }
  } finally {
    await harness?.dispose();
    await server.close();
  }

  async function runCase(c: EvalCase, h: Harness): Promise<CaseResult> {
    o.generator.reset();
    const inputs = await resolveCaseSources(c.sources, { workDir: path.join(o.workDir, 'sources', c.id), server });
    const { job, doc } = await h.generate(inputs, { clarifyingInput: c.clarifying ?? '', glossary: c.glossary });
    const base = { id: c.id, domain: c.domain };
    const zero = { indepth: 0, eli5: 0, ...(c.sectionActions?.length ? { section: 0 } : {}) };
    if (job.status !== 'done' || !doc) {
      const code = job.failure?.code ?? job.status;
      if (code === 'CANCELLED') throw new BudgetStop(); // the only cancel in an eval run is the budget guard
      return { ...base, status: 'generation_failed', scores: zero, error: code };
    }
    const skippedSources = doc.meta.sourcesSkipped.map((s) => ({ ref: s.ref, code: s.code }));
    const gates = runGates(doc.html, c, doc.meta);
    if (!gates.ok) return { ...base, status: 'gate_failed', scores: zero, gates, skippedSources };

    const src = o.generator.sourceMaterial();
    const shared = {
      sources: clip(src.text, MAX_JUDGE_SOURCE_CHARS),
      context: caseContext(c, doc),
      mustCover: c.mustCover,
      jargon: c.jargon,
      ...(src.images.length ? { images: src.images } : {}),
    };
    let indepth: JudgedPart;
    let eli5: JudgedPart;
    const sections: SectionPartResult[] = [];
    try {
      indepth = await judgeWith('indepth', {
        ...shared,
        criteria: criteriaFor('indepth', { glossary: c.glossary }),
        material: tabText(doc.html, 'indepth'),
      });
      eli5 = await judgeWith('eli5', {
        ...shared,
        criteria: criteriaFor('eli5', {}),
        material: tabText(doc.html, 'eli5'),
      });
      let current = doc;
      for (const a of c.sectionActions ?? []) {
        const res = await runSectionAction(h, current, a);
        sections.push(res.part);
        current = res.doc;
      }
    } catch (e) {
      if (e instanceof JudgeError) {
        return { ...base, status: 'judge_error', scores: {}, error: 'judge_error', gates, skippedSources };
      }
      throw e;
    }
    return {
      ...base,
      status: 'scored',
      scores: {
        indepth: indepth.score,
        eli5: eli5.score,
        ...(sections.length ? { section: mean(sections.map((s) => s.score)) } : {}),
      },
      indepth,
      eli5,
      ...(sections.length ? { sections } : {}),
      gates,
      skippedSources,
    };
  }

  async function runSectionAction(
    h: Harness,
    doc: SavedDoc,
    a: NonNullable<EvalCase['sectionActions']>[number],
  ): Promise<{ part: SectionPartResult; doc: SavedDoc }> {
    const failed = (error: string): { part: SectionPartResult; doc: SavedDoc } => ({
      part: {
        action: a.action,
        sectionHint: a.sectionHint,
        medians: {},
        score: 0,
        rationale: {},
        missingFacts: [],
        runs: [],
        error,
      },
      doc,
    });
    const sections = h.sections(doc.html, 'indepth');
    const target = pickSection(sections, a.sectionHint);
    if (!target) return failed('no-section');
    const before = sectionText(doc.html, target.id);
    const tabsBefore = new Set(doc.meta.tabs.map((t) => t.key));
    const { job, doc: after } = await h.sectionAction(doc.slug, {
      tabKey: 'indepth',
      sectionId: target.id as SectionId,
      action: MENU_ACTION[a.action],
      selectionText: clip(before, 2_000),
      ...(a.note ? { note: a.note } : {}),
    });
    if (job.status !== 'done') {
      if (job.failure?.code === 'CANCELLED') throw new BudgetStop();
      return failed(job.failure?.code ?? job.status);
    }
    let material: string;
    let neighbours = '';
    if (a.action === 'section-eli5') {
      const added = after.meta.tabs.find((t) => !tabsBefore.has(t.key));
      if (!added) return { ...failed('no-new-tab'), doc: after };
      material = tabText(after.html, added.key);
    } else {
      material = sectionText(after.html, target.id);
      const i = sections.findIndex((s) => s.id === target.id);
      neighbours = [sections[i - 1], sections[i + 1]]
        .filter((s): s is SectionInfo => s !== undefined && s.kind !== 'references')
        .map((s) => clip(sectionText(after.html, s.id), NEIGHBOUR_CHARS))
        .join('\n\n');
    }
    const context = [
      `Section action requested: ${ACTION_MEANING[a.action]}`,
      `User note: ${a.note ?? 'none'}`,
      `The section before the action:\n${before}`,
      ...(neighbours ? [`Neighbouring sections (after the action):\n${neighbours}`] : []),
    ].join('\n\n');
    const part = await judgeWith('section', {
      criteria: criteriaFor('section', { note: a.note !== undefined }),
      sources: '(not needed for this rubric: judge the rewrite against the section before it and its neighbours)',
      material,
      context,
      mustCover: [],
      jargon: [],
    });
    return { part: { ...part, action: a.action, sectionHint: a.sectionHint }, doc: after };
  }

  const complete = !results.some((r) => r.status === 'skipped_budget');
  if (!complete) notes.push('Cost cap reached: remaining cases skipped_budget; no regression verdict (13 §14).');
  if (results.some((r) => r.status === 'judge_error')) notes.push('judge_error cases are excluded from the means.');

  const suite = suiteScores(results);
  const out: EvalResults = {
    schemaVersion: 1,
    runId: `${started.toISOString()}-${o.info.provider}-${o.info.model}`,
    date,
    provider: o.info.provider,
    model: o.info.model,
    judge: { ...o.info.judge, runs: o.judgeRuns },
    status: complete ? 'complete' : 'incomplete',
    costUsd: Math.max(0, o.ledger.spentUsd - spentAtStart),
    capUsd: o.ledger.capUsd,
    cases: results,
    suite,
    criteria: criterionMeans(results),
    regression: null,
    notes,
  };

  const baselineFile = path.join(o.baselinesDir, `${o.info.provider}.json`);
  if (complete && existsSync(baselineFile)) {
    const base = JSON.parse(readFileSync(baselineFile, 'utf8')) as Baseline;
    out.regression = compareBaseline(results, base, path.basename(baselineFile));
    if (base.model !== o.info.model || base.judge.model !== o.info.judge.model) {
      notes.push(`Baseline was produced with model ${base.model} and judge ${base.judge.model}.`);
    }
  } else if (complete) {
    notes.push(`No baseline at baselines/${o.info.provider}.json.`);
  }

  await mkdir(o.resultsDir, { recursive: true });
  const safe = (s: string): string => s.replace(/[^\w.-]+/g, '_');
  const file = path.join(o.resultsDir, `${date}-${safe(o.info.provider)}-${safe(o.info.model)}.json`);
  await writeFile(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
  if (o.writeBaseline) {
    if (complete) {
      await mkdir(o.baselinesDir, { recursive: true });
      await writeFile(baselineFile, JSON.stringify(toBaseline(out), null, 2) + '\n', 'utf8');
      log(`[eval] baseline written: ${path.relative(process.cwd(), baselineFile)}`);
    } else log('[eval] baseline not written: the run is incomplete');
  }
  log(
    `[eval] ${out.status}: indepth=${fmt(suite.indepth ?? undefined)} eli5=${fmt(suite.eli5 ?? undefined)} ` +
      `section=${fmt(suite.section ?? undefined)} cost=$${out.costUsd.toFixed(2)}/${out.capUsd}` +
      (out.regression ? ` regression=${out.regression.regressed ? 'YES' : 'no'}` : ''),
  );
  for (const reason of out.regression?.reasons ?? []) log(`[eval]   ${reason}`);
  return { results: out, file };
}
