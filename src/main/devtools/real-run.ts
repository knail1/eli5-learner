import path from 'node:path';
import type { ProviderId, Settings } from '../config';
import { createClaudeProvider, createOpenAIProvider } from '../llm';
import type { LLMProvider } from '../llm';
import { isTerminal } from '../pipeline';
import type { Job, JobFailureCode, JobSnapshot, JobStatus, StartJobRequest } from '../pipeline';
import { log } from '../security';
import { BudgetGuardProvider, MIN_OUTPUT_TOKENS } from './budget-guard';
import { BudgetLedger } from './ledger';
import { ratesFor } from './rates';

/**
 * Headless real-provider run for developers (unpackaged builds only). The bootstrap calls
 * prepareRealRun before registry.freeze() to wrap the LLM providers in BudgetGuardProvider, then
 * startRealRun once the JobQueue is initialized: one create job per URL, a JSON summary on stdout,
 * then quit.
 */

export const MAX_REAL_RUN_BUDGET_USD = 50;
export const DEFAULT_REAL_RUN_TIMEOUT_MS = 30 * 60_000;

export interface RealRunConfig {
  urls: string[];
  budgetUsd: number;
  ledgerPath: string;
  timeoutMs: number;
}

export type RealRunEnv = Readonly<Record<string, string | undefined>>;

/**
 * Reads ELI5_REAL_RUN_URLS (comma separated), ELI5_REAL_RUN_BUDGET_USD, and the optional
 * ELI5_REAL_RUN_LEDGER and ELI5_REAL_RUN_TIMEOUT_MS. Undefined when packaged or not requested;
 * throws on a malformed request so a typo never runs without a cap.
 */
export function realRunConfigFromEnv(
  env: RealRunEnv,
  o: { isPackaged: boolean; userData: string },
): RealRunConfig | undefined {
  if (o.isPackaged || env.ELI5_REAL_RUN_URLS === undefined) return undefined;
  if (env.ELI5_LLM_FAKE === '1') throw new Error('Real run refused: ELI5_LLM_FAKE=1 is set');
  const urls = [
    ...new Set(
      env.ELI5_REAL_RUN_URLS.split(',')
        .map((u) => u.trim())
        .filter(Boolean),
    ),
  ];
  if (urls.length === 0) throw new Error('Real run refused: ELI5_REAL_RUN_URLS has no URL');
  for (const u of urls) {
    let ok = false;
    try {
      const p = new URL(u).protocol;
      ok = p === 'http:' || p === 'https:';
    } catch {
      ok = false;
    }
    if (!ok) throw new Error('Real run refused: every ELI5_REAL_RUN_URLS entry must be an http(s) URL');
  }
  const budget = Number(env.ELI5_REAL_RUN_BUDGET_USD ?? '');
  if (!env.ELI5_REAL_RUN_BUDGET_USD || !Number.isFinite(budget) || budget <= 0 || budget > MAX_REAL_RUN_BUDGET_USD) {
    throw new Error(`Real run refused: ELI5_REAL_RUN_BUDGET_USD must be a number in (0, ${MAX_REAL_RUN_BUDGET_USD}]`);
  }
  let timeoutMs = DEFAULT_REAL_RUN_TIMEOUT_MS;
  if (env.ELI5_REAL_RUN_TIMEOUT_MS !== undefined) {
    timeoutMs = Number(env.ELI5_REAL_RUN_TIMEOUT_MS);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Real run refused: ELI5_REAL_RUN_TIMEOUT_MS must be a positive integer');
    }
  }
  const ledgerPath = env.ELI5_REAL_RUN_LEDGER
    ? path.resolve(env.ELI5_REAL_RUN_LEDGER)
    : path.join(o.userData, 'devtools', 'real-run-ledger.jsonl');
  return { urls, budgetUsd: budget, ledgerPath, timeoutMs };
}

/** The slice of the capability registry the pre-freeze hook needs. */
export interface GuardableRegistry {
  readonly frozen: boolean;
  registerLLMProvider(id: string, factory: (s: Settings) => LLMProvider): void;
}

export type ProviderFactories = Partial<Record<ProviderId, (s: Settings) => LLMProvider>>;

const PUBLIC_FACTORIES: ProviderFactories = { claude: createClaudeProvider, openai: createOpenAIProvider };

/**
 * Re-registers each real provider id with a factory that wraps the base provider in a
 * BudgetGuardProvider sharing one ledger, so switching llm.provider cannot escape the cap.
 */
export function installBudgetGuard(
  registry: GuardableRegistry,
  ledger: BudgetLedger,
  base: ProviderFactories = PUBLIC_FACTORIES,
): void {
  if (registry.frozen) throw new Error('installBudgetGuard must run before registry.freeze()');
  for (const [id, factory] of Object.entries(base)) {
    registry.registerLLMProvider(id, (s) => new BudgetGuardProvider(factory(s), ledger));
  }
}

export interface RealRunSession {
  config: RealRunConfig;
  ledger: BudgetLedger;
}

/** Pre-freeze bootstrap hook: undefined (and no side effects) unless a real run was requested. */
export function prepareRealRun(o: {
  env: RealRunEnv;
  isPackaged: boolean;
  userData: string;
  registry: GuardableRegistry;
  base?: ProviderFactories;
}): RealRunSession | undefined {
  const config = realRunConfigFromEnv(o.env, { isPackaged: o.isPackaged, userData: o.userData });
  if (!config) return undefined;
  const ledger = new BudgetLedger({ path: config.ledgerPath, capUsd: config.budgetUsd });
  installBudgetGuard(o.registry, ledger, o.base);
  log.info('realrun.armed', { count: config.urls.length });
  return { config, ledger };
}

/** The JobQueue surface the driver uses. */
export interface RealRunQueue {
  start(req: StartJobRequest): Promise<{ jobId: string }>;
  get(id: string): Job | undefined;
  on(event: 'changed', cb: (s: JobSnapshot) => void): () => void;
  cancel(id: string): Promise<void>;
}

export interface RealRunJobSummary {
  url: string;
  jobId?: string;
  status: JobStatus | 'rejected' | 'timeout';
  failureCode?: JobFailureCode;
  error?: string;
  slug?: string;
  title?: string;
  indexPath?: string;
  skipped: { ref: string; code: string; reason: string }[];
  /** Ledger total (all runs) when this job settled; calls are not attributed per job. */
  costSoFarUsd: number;
}

export interface RealRunSummary {
  ok: boolean;
  provider: string;
  model: string;
  budgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  ledgerPath: string;
  error?: string;
  jobs: RealRunJobSummary[];
}

export interface StartRealRunOptions {
  session: RealRunSession;
  jobs: RealRunQueue;
  library: { docPath(slug: string): string };
  /** The active provider (registry.llm()), checked for a price before any job starts. */
  provider: () => Pick<LLMProvider, 'id' | 'model'>;
  glossary?: boolean;
  write?: (text: string) => void;
  quit?: (exitCode: number) => void;
}

export async function startRealRun(o: StartRealRunOptions): Promise<RealRunSummary> {
  const { config, ledger } = o.session;
  const write = o.write ?? ((t: string) => void process.stdout.write(t));
  const quit = o.quit ?? ((code: number) => void (process.exitCode = code));
  const p = o.provider();
  const base = { provider: p.id, model: p.model, budgetUsd: config.budgetUsd, ledgerPath: config.ledgerPath };
  const finish = (jobs: RealRunJobSummary[], error?: string): RealRunSummary => {
    const summary: RealRunSummary = {
      ok: error === undefined && jobs.every((j) => j.status === 'done'),
      ...base,
      spentUsd: ledger.spentUsd,
      remainingUsd: ledger.remainingUsd,
      ...(error !== undefined ? { error } : {}),
      jobs,
    };
    write(JSON.stringify(summary, null, 2) + '\n');
    log.info('realrun.finished', { count: jobs.length, status: summary.ok ? 'ok' : 'failed' });
    quit(summary.ok ? 0 : 1);
    return summary;
  };

  const rates = ratesFor(p.model);
  if (!rates) return finish([], `budget guard: unknown model ${p.model} has no price`);
  if (ledger.remainingUsd < (MIN_OUTPUT_TOKENS * rates.outputPerMTok) / 1e6) return finish([], 'budget exhausted');

  const pending = new Map<string, number>(); // jobId → index into rows
  const rows: RealRunJobSummary[] = [];
  const settled = new Map<string, number>(); // jobId → ledger total when it settled
  const allDone = new Promise<void>((resolve) => {
    let starting = config.urls.length;
    let off: () => void = () => {};
    const check = (): void => {
      for (const id of pending.keys()) {
        const j = o.jobs.get(id);
        if (j && isTerminal(j.status)) {
          settled.set(id, ledger.spentUsd);
          pending.delete(id);
        }
      }
      if (starting === 0 && pending.size === 0) {
        off();
        resolve();
      }
    };
    off = o.jobs.on('changed', check);
    void (async () => {
      for (const [i, url] of config.urls.entries()) {
        rows.push({ url, status: 'queued', skipped: [], costSoFarUsd: 0 });
        try {
          const { jobId } = await o.jobs.start({
            inputs: [{ id: `in-${(i + 1).toString(16).padStart(8, '0')}`, kind: 'url', origin: 'url-field', url }],
            options: { clarifyingInput: '', glossary: o.glossary ?? true },
          });
          rows[i] = { ...rows[i]!, jobId };
          pending.set(jobId, i);
        } catch (err) {
          rows[i] = { ...rows[i]!, status: 'rejected', error: err instanceof Error ? err.message : String(err) };
        }
        starting--;
      }
      check();
    })();
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    allDone.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), config.timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    for (const id of pending.keys()) await o.jobs.cancel(id).catch(() => undefined);
  }

  const out = rows.map((row): RealRunJobSummary => {
    if (row.jobId === undefined) return row;
    const job = o.jobs.get(row.jobId);
    const slug = job?.result?.topicSlug;
    return {
      url: row.url,
      jobId: row.jobId,
      status: settled.has(row.jobId) ? (job?.status ?? 'failed') : 'timeout',
      ...(job?.failure ? { failureCode: job.failure.code } : {}),
      ...(slug !== undefined ? { slug, title: job?.result?.title ?? '', indexPath: o.library.docPath(slug) } : {}),
      skipped: (job?.skipped ?? []).map((s) => ({ ref: s.ref, code: s.code, reason: s.reason })),
      costSoFarUsd: settled.get(row.jobId) ?? ledger.spentUsd,
    };
  });
  return finish(out);
}
