/**
 * Judge calibration run (13 §9.5): the configured judge scores test/evals/calibration/ and the report
 * gives MAE per criterion against the hand scores. Run through `node scripts/eval/run.mjs --calibrate`.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { it } from 'vitest';
import { BudgetLedger } from '../../src/main/devtools';
import { loadCalibrationDocs, runCalibration } from './lib/calibrate';
import { evalConfigFromEnv } from './lib/config';
import { loadJudgeTemplate, loadRubrics } from './lib/judge';
import { guard, judgeFnFor, realProvider } from './lib/providers';

it('judge calibration (13 §9.5)', async () => {
  const cfg = evalConfigFromEnv(process.env, { judgeOnly: true });
  const j = cfg.judge;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ledger = new BudgetLedger({
    path: cfg.ledgerPath ?? path.join(cfg.resultsDir, `ledger-calibration-${stamp}.jsonl`),
    capUsd: cfg.maxUsd,
    lock: true,
  });
  try {
    const judge = judgeFnFor(
      guard(realProvider(j.provider, j.model, cfg.keys[j.provider] ?? ''), ledger, cfg.rates[j.model]),
    );
    const { report, file } = await runCalibration({
      docs: loadCalibrationDocs(),
      rubrics: loadRubrics(),
      template: loadJudgeTemplate(),
      judge,
      judgeRuns: cfg.judgeRuns,
      info: j,
      resultsDir: cfg.resultsDir,
    });
    process.stdout.write(
      `[calibrate] report: ${path.relative(process.cwd(), file)} cost=$${ledger.spentUsd.toFixed(2)}\n`,
    );
    const summary = process.env.ELI5_EVAL_SUMMARY_FILE;
    if (summary) {
      await writeFile(summary, JSON.stringify({ file, pass: report.pass, failing: report.failing }) + '\n');
    }
  } finally {
    ledger.release();
  }
});
