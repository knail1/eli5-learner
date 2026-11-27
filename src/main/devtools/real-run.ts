import fs from 'node:fs';
import path from 'node:path';
import type { ProviderId, Settings } from '../config';
import { createClaudeProvider, createOpenAIProvider, DEFAULT_RETRY } from '../llm';
import type { LLMProvider, RetryPolicy } from '../llm';
import { isValidSlug } from '../library';
import { isTerminal } from '../pipeline';
import type { Job, JobFailureCode, JobSnapshot, JobStatus, StartJobRequest } from '../pipeline';
import { log } from '../security';
import { BudgetGuardProvider, MIN_OUTPUT_TOKENS } from './budget-guard';
import { BudgetLedger } from './ledger';
import { ratesFor } from './rates';

/**
 * Headless real-provider run for developers (unpackaged builds only). The bootstrap calls
 * prepareRealRun as the last step before registry.freeze() (after loadOverlay and applyExtension, so
 * no later registration replaces the guard) to wrap the LLM providers in BudgetGuardProvider, then
 * startRealRun once the JobQueue is initialized: one create job per URL, a JSON summary on stdout,
 * then quit via the injected `quit` (the bootstrap passes `(code) => app.exit(code)`).
 */

export const MAX_REAL_RUN_BUDGET_USD = 50;
export const DEFAULT_REAL_RUN_TIMEOUT_MS = 30 * 60_000;

export interface RealRunConfig {
  urls: string[];
  budgetUsd: number;
  ledgerPath: string;
  timeoutMs: number;
  /**
   * ELI5_REAL_RUN_DEADPAN=1: every job also asks for the Deadpan tab (one more call each). In a
   * rebuild it adds the tab to documents that did not have it; without it a rebuild follows meta.
   */
  deadpan?: boolean;
  /** Present in rebuild mode (ELI5_REAL_RUN_REBUILD; design §5), when `urls` is empty. */
  rebuild?: RebuildRunConfig;
}

/** Rebuild mode: each listed document is regenerated from its source as a new version of itself. */
export interface RebuildRunConfig {
  /** 1-4 documents, in run order: the library slug and the absolute path of its one source file. */
  entries: { slug: string; file: string }[];
  /** ELI5_REAL_RUN_DRY=1: preflight and plan only; no provider call. */
  dry: boolean;
  /** ELI5_LLM_FAKE=1 in a test build: the fake LLM, no guard, no pricing, no money gates. */
  rehearsal: boolean;
  /** ELI5_REAL_RUN_PROMPT_SET: must equal the prompt set in effect, else the run refuses. */
  promptSet?: string;
  /** ELI5_REAL_RUN_DOC_GATE_USD: before each document the remaining cap must be at least this. */
  docGateUsd: number;
}

export const MAX_REBUILD_DOCS = 4;
export const DEFAULT_DOC_GATE_USD = 4;
const PROMPT_SET_RE = /^[a-z0-9-]{1,40}$/;

function parseRebuild(env: RealRunEnv, rehearsal: boolean): RebuildRunConfig {
  const raw = (env.ELI5_REAL_RUN_REBUILD ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  if (raw.length === 0) throw new Error('Real run refused: ELI5_REAL_RUN_REBUILD has no entry');
  if (raw.length > MAX_REBUILD_DOCS) {
    throw new Error(`Real run refused: ELI5_REAL_RUN_REBUILD takes 1-${MAX_REBUILD_DOCS} documents`);
  }
  const entries = raw.map((e) => {
    const eq = e.indexOf('=');
    if (eq <= 0) throw new Error('Real run refused: each ELI5_REAL_RUN_REBUILD entry is slug=/absolute/file');
    const slug = e.slice(0, eq).trim();
    const file = e.slice(eq + 1).trim();
    if (!isValidSlug(slug)) throw new Error('Real run refused: an ELI5_REAL_RUN_REBUILD slug is not a valid slug');
    if (!path.isAbsolute(file))
      throw new Error('Real run refused: an ELI5_REAL_RUN_REBUILD file is not an absolute path');
    return { slug, file };
  });
  if (new Set(entries.map((e) => e.slug)).size !== entries.length) {
    throw new Error('Real run refused: ELI5_REAL_RUN_REBUILD names a slug twice');
  }
  for (const e of entries) {
    let regular = false;
    try {
      regular = fs.lstatSync(e.file).isFile();
    } catch {
      regular = false;
    }
    if (!regular) throw new Error('Real run refused: an ELI5_REAL_RUN_REBUILD file is not a regular file');
  }
  const dryRaw = env.ELI5_REAL_RUN_DRY;
  if (dryRaw !== undefined && dryRaw !== '1' && dryRaw !== '0' && dryRaw !== '') {
    throw new Error('Real run refused: ELI5_REAL_RUN_DRY must be 1 when set');
  }
  const promptSet = env.ELI5_REAL_RUN_PROMPT_SET?.trim();
  if (promptSet !== undefined && promptSet !== '' && !PROMPT_SET_RE.test(promptSet)) {
    throw new Error('Real run refused: ELI5_REAL_RUN_PROMPT_SET is not a prompt set name');
  }
  let docGateUsd = DEFAULT_DOC_GATE_USD;
  if (env.ELI5_REAL_RUN_DOC_GATE_USD !== undefined) {
    docGateUsd = Number(env.ELI5_REAL_RUN_DOC_GATE_USD);
    if (!env.ELI5_REAL_RUN_DOC_GATE_USD.trim() || !Number.isFinite(docGateUsd) || docGateUsd <= 0) {
      throw new Error('Real run refused: ELI5_REAL_RUN_DOC_GATE_USD must be a positive number');
    }
  }
  return {
    entries,
    dry: dryRaw === '1',
    rehearsal,
    ...(promptSet ? { promptSet } : {}),
    docGateUsd,
  };
}

export type RealRunEnv = Readonly<Record<string, string | undefined>>;

/**
 * Reads ELI5_REAL_RUN_URLS (comma separated) or ELI5_REAL_RUN_REBUILD (`slug=/abs/file`, comma
 * separated, with the optional ELI5_REAL_RUN_DRY, ELI5_REAL_RUN_PROMPT_SET and
 * ELI5_REAL_RUN_DOC_GATE_USD), ELI5_REAL_RUN_BUDGET_USD, and the optional ELI5_REAL_RUN_LEDGER,
 * ELI5_REAL_RUN_TIMEOUT_MS and ELI5_REAL_RUN_DEADPAN. Undefined when packaged or not requested; throws on a malformed request
 * so a typo never runs without a cap. ELI5_LLM_FAKE=1 is refused, except with REBUILD in a test
 * build (`testBuild`), where it makes the run a rehearsal.
 */
export function realRunConfigFromEnv(
  env: RealRunEnv,
  o: { isPackaged: boolean; userData: string; testBuild?: boolean },
): RealRunConfig | undefined {
  const wantsRebuild = env.ELI5_REAL_RUN_REBUILD !== undefined;
  if (o.isPackaged || (env.ELI5_REAL_RUN_URLS === undefined && !wantsRebuild)) return undefined;
  if (wantsRebuild && env.ELI5_REAL_RUN_URLS !== undefined) {
    throw new Error('Real run refused: ELI5_REAL_RUN_URLS and ELI5_REAL_RUN_REBUILD are mutually exclusive');
  }
  const fake = env.ELI5_LLM_FAKE === '1';
  const rehearsal = fake && wantsRebuild && o.testBuild === true;
  if (fake && !rehearsal) throw new Error('Real run refused: ELI5_LLM_FAKE=1 is set');
  const rebuild = wantsRebuild ? parseRebuild(env, rehearsal) : undefined;
  const urls = [
    ...new Set(
      (env.ELI5_REAL_RUN_URLS ?? '')
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean),
    ),
  ];
  if (urls.length === 0 && !rebuild) throw new Error('Real run refused: ELI5_REAL_RUN_URLS has no URL');
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
  // D24: a rebuild spends on the owner's key, tallied on its own ledger, never the default dev one.
  if (rebuild && !rebuild.rehearsal && !env.ELI5_REAL_RUN_LEDGER?.trim()) {
    throw new Error('Real run refused: a rebuild needs its own ELI5_REAL_RUN_LEDGER (a new file for the owner key)');
  }
  const deadpanRaw = env.ELI5_REAL_RUN_DEADPAN;
  if (deadpanRaw !== undefined && deadpanRaw !== '1' && deadpanRaw !== '0' && deadpanRaw !== '') {
    throw new Error('Real run refused: ELI5_REAL_RUN_DEADPAN must be 1 when set');
  }
  const ledgerPath = env.ELI5_REAL_RUN_LEDGER
    ? path.resolve(env.ELI5_REAL_RUN_LEDGER)
    : path.join(o.userData, 'devtools', 'real-run-ledger.jsonl');
  return {
    urls,
    budgetUsd: budget,
    ledgerPath,
    timeoutMs,
    ...(deadpanRaw === '1' ? { deadpan: true } : {}),
    ...(rebuild ? { rebuild } : {}),
  };
}

/** The slice of the capability registry the pre-freeze hook needs. */
export interface GuardableRegistry {
  readonly frozen: boolean;
  registerLLMProvider(id: string, factory: (s: Settings) => LLMProvider): void;
}

export type ProviderFactories = Partial<Record<ProviderId, (s: Settings) => LLMProvider>>;

/** Real runs disable provider-internal retries so one reservation bounds one billed attempt. */
const NO_RETRY: RetryPolicy = Object.freeze({ ...DEFAULT_RETRY, maxRetries: 0, maxRetriesByKind: {} });

const PUBLIC_FACTORIES: ProviderFactories = {
  claude: (s) => createClaudeProvider(s, { retry: NO_RETRY }),
  openai: (s) => createOpenAIProvider(s, { retry: NO_RETRY }),
};

/**
 * Re-registers each real provider id with a factory that wraps the base provider in a
 * BudgetGuardProvider sharing one ledger, so switching llm.provider cannot escape the cap. The
 * default base is the public Claude and OpenAI providers without retries; this replaces any overlay
 * registration for those ids. Ids not wrapped (e.g. bedrock) are refused by startRealRun. A custom
 * `base` is assumed to follow the process retry policy, which the guard reserves for.
 */
export function installBudgetGuard(registry: GuardableRegistry, ledger: BudgetLedger, base?: ProviderFactories): void {
  if (registry.frozen) throw new Error('installBudgetGuard must run before registry.freeze()');
  const opts = base ? {} : { retry: () => NO_RETRY };
  for (const [id, factory] of Object.entries(base ?? PUBLIC_FACTORIES)) {
    registry.registerLLMProvider(id, (s) => new BudgetGuardProvider(factory(s), ledger, opts));
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
  /** A test build (__ELI5_TEST__): only there may a rebuild run as a rehearsal on the fake LLM. */
  testBuild?: boolean;
  userData: string;
  registry: GuardableRegistry;
  base?: ProviderFactories;
}): RealRunSession | undefined {
  const config = realRunConfigFromEnv(o.env, {
    isPackaged: o.isPackaged,
    userData: o.userData,
    ...(o.testBuild !== undefined ? { testBuild: o.testBuild } : {}),
  });
  if (!config) return undefined;
  // Locked for the session: a concurrent run on the same ledger is refused (released on finish).
  const ledger = new BudgetLedger({ path: config.ledgerPath, capUsd: config.budgetUsd, lock: true });
  try {
    // A rehearsal keeps the fake the test build registered: nothing is priced or spent.
    if (!config.rebuild?.rehearsal) installBudgetGuard(o.registry, ledger, o.base);
  } catch (err) {
    ledger.release();
    throw err;
  }
  log.info('realrun.armed', {
    count: config.rebuild?.entries.length ?? config.urls.length,
    ...(config.rebuild
      ? { kind: config.rebuild.rehearsal ? 'rehearsal' : config.rebuild.dry ? 'dry' : 'rebuild' }
      : {}),
  });
  return { config, ledger };
}

/** Whether the environment asks for a headless real run or rebuild (packaged builds never do). */
export function realRunRequested(env: RealRunEnv, isPackaged: boolean): boolean {
  return !isPackaged && (env.ELI5_REAL_RUN_URLS !== undefined || env.ELI5_REAL_RUN_REBUILD !== undefined);
}

/**
 * A headless run that failed before (or outside) its driver's own summary: bootstrap threw (a
 * relative ELI5_LIBRARY_DIR, a refused config) or the driver promise rejected. Nobody is watching
 * a window, so never a modal: the error goes to stdout as a JSON summary, the ledger lock is
 * released (a held lock would refuse the next run) and the process ends with code 1.
 */
export function failHeadlessRun(o: {
  err: unknown;
  session?: RealRunSession | undefined;
  write?: (text: string) => void;
  exit: (exitCode: number) => void;
}): void {
  const error = o.err instanceof Error ? o.err.message : String(o.err);
  try {
    o.session?.ledger.release();
  } finally {
    const write = o.write ?? ((t: string) => void process.stdout.write(t));
    write(JSON.stringify({ ok: false, error }, null, 2) + '\n');
    log.error('realrun.failed', {}, o.err);
    o.exit(1);
  }
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
  /** The active provider (registry.llm()): it must be budget-guarded and priced before any job starts. */
  provider: () => LLMProvider;
  glossary?: boolean;
  write?: (text: string) => void;
  /** Required: ends the process after the summary (the bootstrap sets the exit code, then `app.quit`). */
  quit: (exitCode: number) => void;
}

export async function startRealRun(o: StartRealRunOptions): Promise<RealRunSummary> {
  const { config, ledger } = o.session;
  const write = o.write ?? ((t: string) => void process.stdout.write(t));
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
    ledger.release();
    write(JSON.stringify(summary, null, 2) + '\n');
    log.info('realrun.finished', { count: jobs.length, status: summary.ok ? 'ok' : 'failed' });
    o.quit(summary.ok ? 0 : 1);
    return summary;
  };

  // An unguarded provider (an id installBudgetGuard did not wrap, or a later registration that
  // replaced the guard) would spend without a cap.
  if (!(p instanceof BudgetGuardProvider)) return finish([], `provider ${p.id} is not behind the budget guard`);
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
            options: {
              clarifyingInput: '',
              glossary: o.glossary ?? true,
              ...(config.deadpan ? { deadpan: true } : {}),
            },
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
