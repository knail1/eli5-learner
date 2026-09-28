/**
 * Eval run configuration from the environment (13 §9.1, §9.5, §9.6). Refuses anything that could
 * spend money without a cap or a price, and never runs on a pull request (13 §12).
 */
import path from 'node:path';
import { DEFAULT_MODELS } from '../../../src/main/config';
import { ratesFor, type ModelRates } from '../../../src/main/devtools';

export type EvalProvider = 'claude' | 'openai';
const PROVIDERS: readonly EvalProvider[] = ['claude', 'openai'];
const KEY_VAR: Record<EvalProvider, string> = {
  claude: 'ELI5_EVAL_API_KEY_CLAUDE',
  openai: 'ELI5_EVAL_API_KEY_OPENAI',
};

export const DEFAULT_MAX_USD = 10;
export const DEFAULT_JUDGE_RUNS = 3;

export interface EvalConfig {
  generator: { provider: EvalProvider; model: string };
  judge: { provider: EvalProvider; model: string };
  /** ELI5_EVAL_CASES subset; undefined = every case. */
  cases?: string[];
  judgeRuns: number;
  maxUsd: number;
  /** Price overrides for models missing from src/main/devtools/rates.ts. */
  rates: Record<string, ModelRates>;
  ledgerPath?: string;
  resultsDir: string;
  writeBaseline: boolean;
  /** Kept apart so the rest of the config can be logged or stored. */
  keys: Partial<Record<EvalProvider, string>>;
}

export type EvalEnv = Readonly<Record<string, string | undefined>>;

const refuse = (msg: string): never => {
  throw new Error(`Eval refused: ${msg}`);
};

function provider(v: string | undefined, name: string, fallback: EvalProvider): EvalProvider {
  if (v === undefined || v.trim() === '') return fallback;
  const p = v.trim() as EvalProvider;
  return PROVIDERS.includes(p) ? p : refuse(`${name} must be one of ${PROVIDERS.join(', ')}`);
}

/** `model=in:out,...` in USD per million tokens. */
function parseRates(v: string | undefined): Record<string, ModelRates> {
  const out: Record<string, ModelRates> = {};
  for (const item of (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const m = /^([\w.:-]+)=(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(item);
    if (!m) return refuse('ELI5_EVAL_RATES entries look like model=<input USD/MTok>:<output USD/MTok>');
    if (ratesFor(m[1] as string)) refuse(`ELI5_EVAL_RATES: ${m[1]} already has a price in src/main/devtools/rates.ts`);
    out[m[1] as string] = { inputPerMTok: Number(m[2]), outputPerMTok: Number(m[3]) };
  }
  return out;
}

/** `judgeOnly` (calibration, 13 §9.5): only the judge's key and price are required. */
export function evalConfigFromEnv(env: EvalEnv, o: { repoRoot?: string; judgeOnly?: boolean } = {}): EvalConfig {
  if (env.ELI5_LLM_FAKE === '1') refuse('ELI5_LLM_FAKE=1 is set');
  const event = env.GITHUB_EVENT_NAME ?? '';
  if (event.startsWith('pull_request')) refuse('evals never run on a pull request (13 §12)');

  const keys: EvalConfig['keys'] = {};
  for (const p of PROVIDERS) {
    const k = env[KEY_VAR[p]]?.trim();
    if (k) keys[p] = k;
  }
  const gen = provider(env.ELI5_EVAL_PROVIDER, 'ELI5_EVAL_PROVIDER', 'claude');
  if (!keys[gen] && !o.judgeOnly) refuse(`${KEY_VAR[gen]} is not set`);
  const genModel = env.ELI5_EVAL_MODEL?.trim() || DEFAULT_MODELS[gen];

  // 13 §9.5: the judge defaults to the other public provider; without its key, the same provider.
  let judge: EvalConfig['judge'];
  const spec = env.ELI5_EVAL_JUDGE?.trim();
  if (spec) {
    const [p, ...rest] = spec.split(':');
    const jp = provider(p, 'ELI5_EVAL_JUDGE provider', gen);
    judge = { provider: jp, model: rest.join(':').trim() || DEFAULT_MODELS[jp] };
  } else {
    const other: EvalProvider = gen === 'claude' ? 'openai' : 'claude';
    const jp = keys[other] ? other : keys[gen] || !o.judgeOnly ? gen : other;
    judge = { provider: jp, model: DEFAULT_MODELS[jp] };
  }
  if (!keys[judge.provider]) refuse(`${KEY_VAR[judge.provider]} is not set (needed by the judge)`);

  const runs = Number(env.ELI5_EVAL_JUDGE_RUNS ?? DEFAULT_JUDGE_RUNS);
  if (!Number.isInteger(runs) || runs < 1 || runs > 9) refuse('ELI5_EVAL_JUDGE_RUNS must be an integer from 1 to 9');
  const maxUsd = Number(env.ELI5_EVAL_MAX_USD ?? DEFAULT_MAX_USD);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) refuse('ELI5_EVAL_MAX_USD must be a positive number');

  const rates = parseRates(env.ELI5_EVAL_RATES);
  for (const m of o.judgeOnly ? [judge.model] : [genModel, judge.model]) {
    if (!rates[m] && !ratesFor(m)) refuse(`model ${m} has no price; add it with ELI5_EVAL_RATES=${m}=<in>:<out>`);
  }

  const cases = env.ELI5_EVAL_CASES?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const root = o.repoRoot ?? path.resolve(import.meta.dirname, '../../..');
  return {
    generator: { provider: gen, model: genModel },
    judge,
    ...(cases && cases.length ? { cases } : {}),
    judgeRuns: runs,
    maxUsd,
    rates,
    ...(env.ELI5_EVAL_LEDGER ? { ledgerPath: path.resolve(env.ELI5_EVAL_LEDGER) } : {}),
    resultsDir: path.resolve(root, env.ELI5_EVAL_RESULTS_DIR ?? 'test/evals/results'),
    writeBaseline: env.ELI5_EVAL_WRITE_BASELINE === '1',
    keys,
  };
}
