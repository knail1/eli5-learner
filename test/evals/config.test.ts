import { describe, expect, it } from 'vitest';
import { evalConfigFromEnv } from './lib/config';

// Secret-shaped strings are assembled at runtime (13 §5.3 hygiene).
const KEY_C = ['sk', 'ant', 'eval', 'unit'].join('-');
const KEY_O = ['sk', 'proj', 'eval', 'unit'].join('-');

describe('evalConfigFromEnv (13 §9.1, §9.5, §9.6)', () => {
  it('defaults: claude generator at its default model, judge = the other provider when it has a key, 3 runs, $10', () => {
    const c = evalConfigFromEnv({
      ELI5_EVAL_API_KEY_CLAUDE: KEY_C,
      ELI5_EVAL_API_KEY_OPENAI: KEY_O,
      ELI5_EVAL_RATES: 'gpt-5=1.25:10',
    });
    expect(c.generator).toEqual({ provider: 'claude', model: 'claude-opus-5' });
    expect(c.judge).toEqual({ provider: 'openai', model: 'gpt-5' });
    expect(c.judgeRuns).toBe(3);
    expect(c.maxUsd).toBe(10);
    expect(c.cases).toBeUndefined();
    expect(c.keys).toEqual({ claude: KEY_C, openai: KEY_O });
    expect(c.rates['gpt-5']).toEqual({ inputPerMTok: 1.25, outputPerMTok: 10 });
    // Keys never appear in the serializable part of the config.
    expect(JSON.stringify({ ...c, keys: undefined })).not.toContain(KEY_C);
  });

  it('falls back to the generator provider as judge when the other provider has no key', () => {
    const c = evalConfigFromEnv({ ELI5_EVAL_API_KEY_CLAUDE: KEY_C });
    expect(c.judge).toEqual({ provider: 'claude', model: 'claude-opus-5' });
  });

  it('reads provider, model, judge, subset, runs and cap from env', () => {
    const c = evalConfigFromEnv({
      ELI5_EVAL_PROVIDER: 'openai',
      ELI5_EVAL_MODEL: 'gpt-5-mini',
      ELI5_EVAL_JUDGE: 'claude:claude-sonnet-5',
      ELI5_EVAL_API_KEY_CLAUDE: KEY_C,
      ELI5_EVAL_API_KEY_OPENAI: KEY_O,
      ELI5_EVAL_CASES: ' a-case, b-case ,,',
      ELI5_EVAL_JUDGE_RUNS: '1',
      ELI5_EVAL_MAX_USD: '2.5',
      ELI5_EVAL_RATES: 'gpt-5-mini=0.25:2',
    });
    expect(c.generator).toEqual({ provider: 'openai', model: 'gpt-5-mini' });
    expect(c.judge).toEqual({ provider: 'claude', model: 'claude-sonnet-5' });
    expect(c.cases).toEqual(['a-case', 'b-case']);
    expect(c.judgeRuns).toBe(1);
    expect(c.maxUsd).toBe(2.5);
  });

  it('judge-only (calibration) needs just the judge key', () => {
    const c = evalConfigFromEnv({ ELI5_EVAL_API_KEY_CLAUDE: KEY_C }, { judgeOnly: true });
    expect(c.judge).toEqual({ provider: 'claude', model: 'claude-opus-5' });
    const o = evalConfigFromEnv(
      { ELI5_EVAL_API_KEY_OPENAI: KEY_O, ELI5_EVAL_RATES: 'gpt-5=1.25:10' },
      { judgeOnly: true },
    );
    expect(o.judge).toEqual({ provider: 'openai', model: 'gpt-5' });
    expect(() => evalConfigFromEnv({}, { judgeOnly: true })).toThrow(/ELI5_EVAL_API_KEY/);
  });

  it.each([
    [{}, /ELI5_EVAL_API_KEY_CLAUDE/],
    [{ ELI5_EVAL_API_KEY_CLAUDE: KEY_C, ELI5_EVAL_PROVIDER: 'bedrock' }, /ELI5_EVAL_PROVIDER/],
    [{ ELI5_EVAL_API_KEY_CLAUDE: KEY_C, ELI5_EVAL_JUDGE: 'openai:gpt-5' }, /ELI5_EVAL_API_KEY_OPENAI/],
    [{ ELI5_EVAL_API_KEY_CLAUDE: KEY_C, ELI5_EVAL_JUDGE_RUNS: '0' }, /ELI5_EVAL_JUDGE_RUNS/],
    [{ ELI5_EVAL_API_KEY_CLAUDE: KEY_C, ELI5_EVAL_MAX_USD: '-1' }, /ELI5_EVAL_MAX_USD/],
    [{ ELI5_EVAL_API_KEY_CLAUDE: KEY_C, ELI5_EVAL_MODEL: 'claude-unpriced-9' }, /no price/],
    [{ ELI5_EVAL_API_KEY_CLAUDE: KEY_C, ELI5_EVAL_RATES: 'x=abc' }, /ELI5_EVAL_RATES/],
    [{ ELI5_EVAL_API_KEY_CLAUDE: KEY_C, ELI5_LLM_FAKE: '1' }, /ELI5_LLM_FAKE/],
    [{ ELI5_EVAL_API_KEY_CLAUDE: KEY_C, GITHUB_EVENT_NAME: 'pull_request' }, /pull request/],
  ])('refuses %j', (env, msg) => {
    expect(() => evalConfigFromEnv(env)).toThrow(msg);
  });
});
