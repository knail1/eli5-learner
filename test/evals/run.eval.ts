/**
 * The real eval run (13 §9): real providers from ELI5_EVAL_* env, one BudgetLedger capped at
 * ELI5_EVAL_MAX_USD shared by generator and judge. Run it through `node scripts/eval/run.mjs`
 * (npm run eval); it spends real money and needs the network, so it is never part of `npm test`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
import { BudgetLedger, MIN_OUTPUT_TOKENS, ratesFor } from '../../src/main/devtools';
import { loadCases, selectCases } from './lib/cases';
import { evalConfigFromEnv } from './lib/config';
import { EVALS_DIR, loadJudgeTemplate, loadRubrics } from './lib/judge';
import { RecordingProvider, evalSettings, guard, judgeFnFor, realProvider } from './lib/providers';
import { runEval } from './lib/runner';

it('generation quality eval (13 §9)', async () => {
  const cfg = evalConfigFromEnv(process.env);
  // Validate the case subset and every source before any spend.
  const cases = selectCases(loadCases(), cfg.cases);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ledger = new BudgetLedger({
    path: cfg.ledgerPath ?? path.join(cfg.resultsDir, `ledger-${stamp}.jsonl`),
    capUsd: cfg.maxUsd,
    lock: true,
  });
  const workDir = await mkdtemp(path.join(tmpdir(), 'eli5-eval-'));
  try {
    const g = cfg.generator;
    const j = cfg.judge;
    const genRates = ratesFor(g.model) ?? cfg.rates[g.model];
    if (!genRates) throw new Error(`model ${g.model} has no price`);
    const generator = new RecordingProvider(
      guard(realProvider(g.provider, g.model, cfg.keys[g.provider] ?? ''), ledger, cfg.rates[g.model]),
    );
    const judge = judgeFnFor(
      guard(realProvider(j.provider, j.model, cfg.keys[j.provider] ?? ''), ledger, cfg.rates[j.model]),
    );
    const { results, file } = await runEval({
      cases,
      rubrics: loadRubrics(),
      template: loadJudgeTemplate(),
      generator,
      judge,
      judgeRuns: cfg.judgeRuns,
      ledger,
      minCaseUsd: (MIN_OUTPUT_TOKENS * genRates.outputPerMTok) / 1e6,
      settings: evalSettings(g.provider, g.model),
      info: { provider: g.provider, model: g.model, judge: j },
      resultsDir: cfg.resultsDir,
      baselinesDir: path.join(EVALS_DIR, 'baselines'),
      writeBaseline: cfg.writeBaseline,
      workDir,
    });
    process.stdout.write(`[eval] results: ${path.relative(process.cwd(), file)}\n`);
    const summary = process.env.ELI5_EVAL_SUMMARY_FILE;
    if (summary) {
      await writeFile(
        summary,
        JSON.stringify({ file, status: results.status, regressed: results.regression?.regressed ?? false }) + '\n',
      );
    }
  } finally {
    ledger.release();
    await rm(workDir, { recursive: true, force: true });
  }
});
