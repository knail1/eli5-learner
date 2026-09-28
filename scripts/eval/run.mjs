#!/usr/bin/env node
// @ts-check
/**
 * Generation-quality evals (spec/tech/13-testing-quality.md §9). Maps CLI flags to ELI5_EVAL_* env
 * and runs the Vitest eval project; API keys come only from the environment
 * (ELI5_EVAL_API_KEY_CLAUDE / ELI5_EVAL_API_KEY_OPENAI), never from flags.
 *
 *   node scripts/eval/run.mjs --provider claude --model claude-opus-5 [--judge openai:gpt-5]
 *     [--cases id1,id2] [--judge-runs 3] [--max-usd 10] [--ledger path] [--rates model=in:out]
 *     [--write-baseline]
 *   node scripts/eval/run.mjs --calibrate [--judge claude:claude-sonnet-5]
 *
 * Exit codes (exit-code.mjs): 0 done (an incomplete, cost-capped run also exits 0), 1 run error,
 * 2 regression vs the baseline (or calibration MAE above 0.75), 3 inconclusive (judge_error cases,
 * an aborted run, or no case matched the baseline).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exitCode } from './exit-code.mjs';

const FLAGS = {
  '--provider': 'ELI5_EVAL_PROVIDER',
  '--model': 'ELI5_EVAL_MODEL',
  '--judge': 'ELI5_EVAL_JUDGE',
  '--cases': 'ELI5_EVAL_CASES',
  '--judge-runs': 'ELI5_EVAL_JUDGE_RUNS',
  '--max-usd': 'ELI5_EVAL_MAX_USD',
  '--ledger': 'ELI5_EVAL_LEDGER',
  '--rates': 'ELI5_EVAL_RATES',
  '--results-dir': 'ELI5_EVAL_RESULTS_DIR',
};

const USAGE = `usage: node scripts/eval/run.mjs [--calibrate] ${Object.keys(FLAGS)
  .map((f) => `[${f} <value>]`)
  .join(' ')} [--write-baseline] [--print-env]`;

/** @param {string[]} argv */
function parse(argv) {
  /** @type {Record<string, string>} */
  const env = {};
  let calibrate = false;
  let printEnv = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    const [flag, inline] =
      a.includes('=') && a.startsWith('--')
        ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]
        : [a, undefined];
    if (flag === '--calibrate') calibrate = true;
    else if (flag === '--write-baseline') env.ELI5_EVAL_WRITE_BASELINE = '1';
    else if (flag === '--print-env') printEnv = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (flag in FLAGS) {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
      env[FLAGS[/** @type {keyof typeof FLAGS} */ (flag)]] = v;
    } else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  return { env, calibrate, printEnv };
}

let args;
try {
  args = parse(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const project = args.calibrate ? 'evals:calibrate' : 'evals:run';
if (args.printEnv) {
  // Flags only: keys and other inherited variables are never printed.
  console.log(JSON.stringify({ project, env: args.env }));
  process.exit(0);
}

const repo = path.resolve(import.meta.dirname, '../..');
const scratch = mkdtempSync(path.join(tmpdir(), 'eli5-eval-run-'));
const summaryFile = path.join(scratch, 'summary.json');
const r = spawnSync('npx', ['vitest', 'run', '--config', 'test/evals/vitest.config.ts', '--project', project], {
  cwd: repo,
  stdio: 'inherit',
  env: { ...process.env, ...args.env, ELI5_ALLOW_NET: '1', ELI5_EVAL_SUMMARY_FILE: summaryFile },
});
/** @type {{ status?: string; regressed?: boolean; pass?: boolean } | undefined} */
let summary;
try {
  summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
} catch {
  summary = undefined; // the run failed before writing results
}
if (!args.calibrate && summary?.status === 'incomplete')
  console.log('[eval] incomplete: the cost cap was reached (no regression verdict)');
if (!args.calibrate && summary?.status === 'inconclusive')
  console.log('[eval] inconclusive: see the notes in the results file (no regression verdict)');
const code = exitCode({ calibrate: args.calibrate, vitest: r.status ?? 1, summary });
rmSync(scratch, { recursive: true, force: true });
process.exit(code);
