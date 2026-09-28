import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCode } from '../../scripts/eval/exit-code.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '../../scripts/eval/run.mjs');
const run = (...args: string[]): { status: number | null; out: string; err: string } => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

describe('scripts/eval/run.mjs (npm run eval)', () => {
  it('maps flags to ELI5_EVAL_* env for the run project', () => {
    const r = run(
      '--provider',
      'openai',
      '--model=gpt-5-mini',
      '--judge',
      'claude:claude-sonnet-5',
      '--cases',
      'a,b',
      '--judge-runs',
      '1',
      '--max-usd',
      '2',
      '--write-baseline',
      '--print-env',
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      project: 'evals:run',
      env: {
        ELI5_EVAL_PROVIDER: 'openai',
        ELI5_EVAL_MODEL: 'gpt-5-mini',
        ELI5_EVAL_JUDGE: 'claude:claude-sonnet-5',
        ELI5_EVAL_CASES: 'a,b',
        ELI5_EVAL_JUDGE_RUNS: '1',
        ELI5_EVAL_MAX_USD: '2',
        ELI5_EVAL_WRITE_BASELINE: '1',
      },
    });
  });

  it('selects the calibration project and refuses unknown flags or keys on the command line', () => {
    expect(JSON.parse(run('--calibrate', '--print-env').out)).toEqual({ project: 'evals:calibrate', env: {} });
    const bad = run('--api-key', 'x');
    expect(bad.status).toBe(1);
    expect(bad.err).toMatch(/unknown argument --api-key/);
    expect(run('--model').err).toMatch(/--model needs a value/);
  });
});

describe('exit codes (npm run eval / eval:calibrate)', () => {
  it('0 done or cost-capped, 1 run error, 2 regression or failed calibration, 3 inconclusive', () => {
    expect(exitCode({ calibrate: false, vitest: 0, summary: { status: 'complete', regressed: false } })).toBe(0);
    expect(exitCode({ calibrate: false, vitest: 0, summary: { status: 'incomplete', regressed: false } })).toBe(0);
    expect(exitCode({ calibrate: false, vitest: 0, summary: { status: 'complete', regressed: true } })).toBe(2);
    expect(exitCode({ calibrate: false, vitest: 0, summary: { status: 'inconclusive', regressed: false } })).toBe(3);
    expect(exitCode({ calibrate: false, vitest: 1, summary: undefined })).toBe(1);
    expect(exitCode({ calibrate: false, vitest: 0, summary: undefined })).toBe(1);
    expect(exitCode({ calibrate: true, vitest: 0, summary: { pass: true } })).toBe(0);
    expect(exitCode({ calibrate: true, vitest: 0, summary: { pass: false } })).toBe(2);
  });
});
