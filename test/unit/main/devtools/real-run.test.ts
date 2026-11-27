import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS, type Settings } from '../../../../src/main/config/schema';
import {
  BudgetGuardProvider,
  BudgetLedger,
  failHeadlessRun,
  installBudgetGuard,
  prepareRealRun,
  realRunConfigFromEnv,
  realRunRequested,
  startRealRun,
  type RealRunQueue,
  type RealRunSession,
} from '../../../../src/main/devtools';
import { Registry } from '../../../../src/main/editions/registry';
import { registerPublicCapabilities } from '../../../../src/main/editions/public';
import { configureLlmRuntime, DEFAULT_RETRY, resetLlmRuntime } from '../../../../src/main/llm';
import type { GenerationRequest, LLMProvider } from '../../../../src/main/llm';
import { FakeProvider } from '../../../../src/main/llm/testing/fake';
import type { Job, JobFailureCode, JobSnapshot, StartJobRequest } from '../../../../src/main/pipeline';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'eli5-realrun-'));
});
afterEach(async () => {
  resetLlmRuntime();
  await rm(dir, { recursive: true, force: true });
});

const env = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  ELI5_REAL_RUN_URLS: 'https://example.com/a, https://example.org/b ,,https://example.com/a',
  ELI5_REAL_RUN_BUDGET_USD: '2.50',
  ...over,
});
const unpackaged = (): { isPackaged: boolean; userData: string } => ({ isPackaged: false, userData: dir });

describe('realRunConfigFromEnv', () => {
  it('is inactive in packaged builds even with the env vars set', () => {
    expect(realRunConfigFromEnv(env(), { isPackaged: true, userData: dir })).toBeUndefined();
  });

  it('is inactive without ELI5_REAL_RUN_URLS', () => {
    expect(realRunConfigFromEnv({ ELI5_REAL_RUN_BUDGET_USD: '1' }, unpackaged())).toBeUndefined();
  });

  it('parses, trims and dedupes URLs, reads the budget and defaults the ledger and timeout', () => {
    expect(realRunConfigFromEnv(env(), unpackaged())).toEqual({
      urls: ['https://example.com/a', 'https://example.org/b'],
      budgetUsd: 2.5,
      ledgerPath: path.join(dir, 'devtools', 'real-run-ledger.jsonl'),
      timeoutMs: 30 * 60_000,
    });
  });

  it('honours an explicit ledger path and timeout', () => {
    const cfg = realRunConfigFromEnv(
      env({ ELI5_REAL_RUN_LEDGER: path.join(dir, 'l.jsonl'), ELI5_REAL_RUN_TIMEOUT_MS: '60000' }),
      unpackaged(),
    );
    expect(cfg).toMatchObject({ ledgerPath: path.join(dir, 'l.jsonl'), timeoutMs: 60_000 });
  });

  it('reads ELI5_REAL_RUN_DEADPAN=1 (every job also asks for the Deadpan tab); 0 or empty leaves it off', () => {
    expect(realRunConfigFromEnv(env({ ELI5_REAL_RUN_DEADPAN: '1' }), unpackaged())).toMatchObject({ deadpan: true });
    for (const v of ['0', '', undefined]) {
      expect(realRunConfigFromEnv(env({ ELI5_REAL_RUN_DEADPAN: v }), unpackaged())).not.toHaveProperty('deadpan');
    }
  });

  it.each([
    [{ ELI5_REAL_RUN_DEADPAN: 'yes' }, /DEADPAN/],
    [{ ELI5_REAL_RUN_BUDGET_USD: undefined }, /BUDGET/],
    [{ ELI5_REAL_RUN_BUDGET_USD: 'lots' }, /BUDGET/],
    [{ ELI5_REAL_RUN_BUDGET_USD: '0' }, /BUDGET/],
    [{ ELI5_REAL_RUN_BUDGET_USD: '-1' }, /BUDGET/],
    [{ ELI5_REAL_RUN_BUDGET_USD: '1000' }, /BUDGET/],
    [{ ELI5_REAL_RUN_URLS: 'file:///etc/hosts' }, /http/],
    [{ ELI5_REAL_RUN_URLS: 'not a url' }, /http/],
    [{ ELI5_REAL_RUN_URLS: ' , ' }, /URL/],
    [{ ELI5_LLM_FAKE: '1' }, /ELI5_LLM_FAKE/],
    [{ ELI5_REAL_RUN_TIMEOUT_MS: 'soon' }, /TIMEOUT/],
  ])('rejects invalid configuration %o', (over, msg) => {
    expect(() => realRunConfigFromEnv(env(over), unpackaged())).toThrow(msg);
  });
});

const settings = (): Settings => ({ ...DEFAULTS });

describe('installBudgetGuard (pre-freeze hook)', () => {
  it('wraps the claude and openai providers in a BudgetGuardProvider that shares one ledger', () => {
    const s = settings();
    const registry = new Registry({ edition: 'public', getSettings: () => s });
    registerPublicCapabilities(registry);
    const ledger = new BudgetLedger({ path: path.join(dir, 'l.jsonl'), capUsd: 1 });
    const inner = new FakeProvider({ responses: {} }, { model: 'claude-opus-5' });
    installBudgetGuard(registry, ledger, { claude: () => inner });
    registry.freeze();
    const p = registry.llm();
    expect(p).toBeInstanceOf(BudgetGuardProvider);
    expect(p.model).toBe('claude-opus-5');
  });

  it('wraps the public Claude factory by default', () => {
    const s = settings();
    const registry = new Registry({ edition: 'public', getSettings: () => s });
    registerPublicCapabilities(registry);
    installBudgetGuard(registry, new BudgetLedger({ path: path.join(dir, 'l.jsonl'), capUsd: 1 }));
    registry.freeze();
    expect(registry.llm()).toBeInstanceOf(BudgetGuardProvider);
    expect(registry.llm().id).toBe('claude');
  });

  it('builds the public providers without internal retries, so one reservation bounds one billed call', async () => {
    let sends = 0;
    configureLlmRuntime({
      keys: { get: () => Promise.resolve(['k', 'test', 'only'].join('-')) },
      retry: DEFAULT_RETRY,
      fetch: (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes('count_tokens')) sends++;
        return Promise.resolve(new Response('{"type":"error","error":{"type":"api_error"}}', { status: 500 }));
      },
    });
    const s = settings();
    const registry = new Registry({ edition: 'public', getSettings: () => s });
    registerPublicCapabilities(registry);
    const ledger = new BudgetLedger({ path: path.join(dir, 'l.jsonl'), capUsd: 10 });
    installBudgetGuard(registry, ledger);
    registry.freeze();
    const r: GenerationRequest = {
      taskId: 'in-depth',
      system: 's',
      messages: [{ role: 'user', text: 'u' }],
      maxOutputTokens: 4_000,
    };
    await expect(registry.llm().generate(r)).rejects.toMatchObject({ kind: 'server' });
    expect(sends).toBe(1);
    // Charged as one attempt: at most the input estimate plus 4000 output tokens at $25/MTok.
    expect(ledger.spentUsd).toBeGreaterThan(0);
    expect(ledger.spentUsd).toBeLessThan(4_001 * 25e-6);
  });

  it('refuses to run after the registry is frozen', () => {
    const s = settings();
    const registry = new Registry({ edition: 'public', getSettings: () => s });
    registry.freeze();
    expect(() =>
      installBudgetGuard(registry, new BudgetLedger({ path: path.join(dir, 'l.jsonl'), capUsd: 1 })),
    ).toThrow(/freeze/);
  });
});

describe('prepareRealRun', () => {
  it('returns undefined and registers nothing when inactive', () => {
    const s = settings();
    const registry = new Registry({ edition: 'public', getSettings: () => s });
    let registered = 0;
    const spy = { frozen: false, registerLLMProvider: () => void registered++ };
    expect(prepareRealRun({ env: {}, isPackaged: false, userData: dir, registry: spy })).toBeUndefined();
    expect(prepareRealRun({ env: env(), isPackaged: true, userData: dir, registry: spy })).toBeUndefined();
    expect(registered).toBe(0);
    expect(registry.frozen).toBe(false);
  });

  it('opens the ledger at the configured path and installs the guard', () => {
    const ids: string[] = [];
    const spy = { frozen: false, registerLLMProvider: (id: string) => void ids.push(id) };
    const session = prepareRealRun({ env: env(), isPackaged: false, userData: dir, registry: spy });
    expect(session?.config.urls).toHaveLength(2);
    expect(session?.ledger.capUsd).toBe(2.5);
    expect(session?.ledger.path).toBe(path.join(dir, 'devtools', 'real-run-ledger.jsonl'));
    expect(ids.sort()).toEqual(['claude', 'openai']);
  });
});

describe('prepareRealRun ledger lock', () => {
  it('locks the ledger for the session so a concurrent run on the same file is refused', async () => {
    const spy = { frozen: false, registerLLMProvider: () => {} };
    const e = env({ ELI5_REAL_RUN_URLS: 'https://example.com/a' });
    const first = prepareRealRun({ env: e, isPackaged: false, userData: dir, registry: spy });
    expect(() => prepareRealRun({ env: e, isPackaged: false, userData: dir, registry: spy })).toThrow(/in use/);
    if (!first) throw new Error('not armed');
    const q = new ScriptedQueue([{ status: 'done', slug: 'a' }]);
    await startRealRun({
      session: first,
      jobs: q,
      library,
      provider: () =>
        new BudgetGuardProvider(new FakeProvider({ responses: {} }, { model: 'claude-opus-5' }), first.ledger),
      ...harness(),
    });
    // Released when the run finishes.
    prepareRealRun({ env: e, isPackaged: false, userData: dir, registry: spy })?.ledger.release();
  });
});

describe('headless failure (audit round 1: no modal, no stale lock)', () => {
  const spy = { frozen: false, registerLLMProvider: () => {} };
  const e = env({ ELI5_REAL_RUN_URLS: 'https://example.com/a' });

  it('knows when a headless run was requested, never in a packaged build', () => {
    expect(realRunRequested({}, false)).toBe(false);
    expect(realRunRequested({ ELI5_REAL_RUN_URLS: 'https://example.com/a' }, false)).toBe(true);
    expect(realRunRequested({ ELI5_REAL_RUN_REBUILD: 'a=/x' }, false)).toBe(true);
    expect(realRunRequested({ ELI5_REAL_RUN_REBUILD: 'a=/x' }, true)).toBe(false);
  });

  it('a bootstrap failure after arming prints a JSON error, releases the lock and exits 1', () => {
    const session = prepareRealRun({ env: e, isPackaged: false, userData: dir, registry: spy });
    if (!session) throw new Error('not armed');
    const out: string[] = [];
    const codes: number[] = [];
    failHeadlessRun({
      err: new Error('ELI5_LIBRARY_DIR must be absolute'),
      session,
      write: (t) => void out.push(t),
      exit: (c) => void codes.push(c),
    });
    expect(codes).toEqual([1]);
    expect(JSON.parse(out.join(''))).toEqual({ ok: false, error: 'ELI5_LIBRARY_DIR must be absolute' });
    // The lock is gone: the next run is not refused as 'in use'.
    prepareRealRun({ env: e, isPackaged: false, userData: dir, registry: spy })?.ledger.release();
  });

  it('a failure before arming (no session) still prints and exits 1', () => {
    const out: string[] = [];
    const codes: number[] = [];
    failHeadlessRun({ err: 'refused', write: (t) => void out.push(t), exit: (c) => void codes.push(c) });
    expect(codes).toEqual([1]);
    expect(JSON.parse(out.join(''))).toEqual({ ok: false, error: 'refused' });
  });

  it('a driver that throws before its summary is caught the way the bootstrap wires it', async () => {
    const session = prepareRealRun({ env: e, isPackaged: false, userData: dir, registry: spy });
    if (!session) throw new Error('not armed');
    const codes: number[] = [];
    const quit = (c: number): void => void codes.push(c);
    await startRealRun({
      session,
      jobs: new ScriptedQueue([]),
      library,
      provider: () => {
        throw new Error('NotAvailableInEdition');
      },
      write: () => {},
      quit,
    }).catch((err: unknown) => failHeadlessRun({ err, session, write: () => {}, exit: quit }));
    expect(codes).toEqual([1]);
    prepareRealRun({ env: e, isPackaged: false, userData: dir, registry: spy })?.ledger.release();
  });
});

// ---- startRealRun with a scripted queue ----

type Outcome =
  | { status: 'done'; slug: string }
  | { status: 'failed'; code: JobFailureCode }
  | { status: 'hang' }
  | { status: 'reject' };

class ScriptedQueue implements RealRunQueue {
  readonly started: StartJobRequest[] = [];
  readonly cancelled: string[] = [];
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Set<(s: JobSnapshot) => void>();
  constructor(
    private readonly outcomes: Outcome[],
    private readonly onFinish: () => void = () => {},
  ) {}

  start(req: StartJobRequest): Promise<{ jobId: string }> {
    const i = this.started.length;
    this.started.push(req);
    const o = this.outcomes[i] ?? { status: 'hang' };
    if (o.status === 'reject') return Promise.reject(new Error('library is read-only'));
    const id = `job-${i}`;
    const job = {
      id,
      kind: 'create',
      status: 'queued',
      createdAt: '2026-09-01T00:00:00.000Z',
      inputs: req.inputs,
      options: req.options,
      progress: {},
      resolved: [],
      skipped: [],
      warnings: [],
      attempt: 1,
    } as unknown as Job;
    this.jobs.set(id, job);
    if (o.status !== 'hang') {
      setTimeout(
        () => {
          this.onFinish();
          if (o.status === 'done') {
            job.status = 'done';
            job.result = { docId: `doc-${i}`, topicSlug: o.slug, title: `Title ${i}` };
            job.skipped = [
              { ref: 'https://example.com/img.png', code: 'fetch-failed', reason: 'HTTP 404' },
            ] as Job['skipped'];
          } else {
            job.status = 'failed';
            job.failure = { code: o.code, message: 'failed' } as Job['failure'];
          }
          for (const l of this.listeners) l({ id, status: job.status } as JobSnapshot);
        },
        5 * (i + 1),
      );
    }
    return Promise.resolve({ jobId: id });
  }
  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }
  on(_event: 'changed', cb: (s: JobSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  cancel(id: string): Promise<void> {
    this.cancelled.push(id);
    return Promise.resolve();
  }
}

function session(urls: string[], capUsd = 1, timeoutMs = 5_000): RealRunSession {
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  return {
    config: { urls, budgetUsd: capUsd, ledgerPath, timeoutMs },
    ledger: new BudgetLedger({ path: ledgerPath, capUsd }),
  };
}

let guardLedger: BudgetLedger | undefined;
const provider = (model = 'claude-opus-5'): LLMProvider => {
  guardLedger ??= new BudgetLedger({ path: path.join(dir, 'guard.jsonl'), capUsd: 1 });
  return new BudgetGuardProvider(new FakeProvider({ responses: {} }, { model }), guardLedger);
};
beforeEach(() => {
  guardLedger = undefined;
});
const library = { docPath: (slug: string): string => path.join('/lib', slug, 'index.html') };

function harness(): { out: string[]; codes: number[]; write: (t: string) => void; quit: (c: number) => void } {
  const out: string[] = [];
  const codes: number[] = [];
  return { out, codes, write: (t) => void out.push(t), quit: (c) => void codes.push(c) };
}

describe('startRealRun', () => {
  it('starts one create job per URL, waits for all, prints a JSON summary and quits 0', async () => {
    const h = harness();
    const s = session(['https://example.com/a', 'https://example.org/b']);
    const spend = (): void => {
      const r = s.ledger.reserve({ maxCostUsd: 0.1, model: 'claude-opus-5', taskId: 'in-depth' });
      s.ledger.settle(r, {
        costUsd: 0.1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outcome: 'ok',
      });
    };
    const q = new ScriptedQueue(
      [
        { status: 'done', slug: 'topic-a' },
        { status: 'done', slug: 'topic-b' },
      ],
      spend,
    );
    const summary = await startRealRun({ session: s, jobs: q, library, provider: () => provider(), ...h });

    expect(q.started.map((r) => r.inputs)).toEqual([
      [{ id: expect.stringMatching(/^in-/), kind: 'url', origin: 'url-field', url: 'https://example.com/a' }],
      [{ id: expect.stringMatching(/^in-/), kind: 'url', origin: 'url-field', url: 'https://example.org/b' }],
    ]);
    expect(q.started[0]?.options).toEqual({ clarifyingInput: '', glossary: true });
    expect(summary).toMatchObject({
      ok: true,
      provider: 'claude',
      model: 'claude-opus-5',
      budgetUsd: 1,
      ledgerPath: s.config.ledgerPath,
    });
    expect(summary.spentUsd).toBeCloseTo(0.2, 12);
    expect(summary.remainingUsd).toBeCloseTo(0.8, 12);
    expect(summary.jobs).toEqual([
      {
        url: 'https://example.com/a',
        jobId: 'job-0',
        status: 'done',
        slug: 'topic-a',
        title: 'Title 0',
        indexPath: path.join('/lib', 'topic-a', 'index.html'),
        skipped: [{ ref: 'https://example.com/img.png', code: 'fetch-failed', reason: 'HTTP 404' }],
        costSoFarUsd: expect.closeTo(0.1, 12) as number,
      },
      expect.objectContaining({
        url: 'https://example.org/b',
        status: 'done',
        costSoFarUsd: expect.closeTo(0.2, 12) as number,
      }),
    ]);
    expect(JSON.parse(h.out.join(''))).toEqual(JSON.parse(JSON.stringify(summary)));
    expect(h.codes).toEqual([0]);
  });

  it('reports failures and start rejections and quits 1', async () => {
    const h = harness();
    const q = new ScriptedQueue([{ status: 'failed', code: 'LLM_AUTH' }, { status: 'reject' }]);
    const summary = await startRealRun({
      session: session(['https://example.com/a', 'https://example.com/b']),
      jobs: q,
      library,
      provider: () => provider(),
      glossary: false,
      ...h,
    });
    expect(q.started[0]?.options.glossary).toBe(false);
    expect(summary.ok).toBe(false);
    expect(summary.jobs).toEqual([
      expect.objectContaining({ status: 'failed', failureCode: 'LLM_AUTH', skipped: [] }),
      expect.objectContaining({ url: 'https://example.com/b', status: 'rejected', error: 'library is read-only' }),
    ]);
    expect(summary.jobs[0]).not.toHaveProperty('indexPath');
    expect(h.codes).toEqual([1]);
  });

  it('asks every job for the Deadpan tab when the config says so', async () => {
    const h = harness();
    const s = session(['https://example.com/a']);
    s.config.deadpan = true;
    const q = new ScriptedQueue([{ status: 'done', slug: 'topic-a' }]);
    await startRealRun({ session: s, jobs: q, library, provider: () => provider(), ...h });
    expect(q.started[0]?.options).toEqual({ clarifyingInput: '', glossary: true, deadpan: true });
  });

  it('cancels jobs still running at the timeout and marks them timeout', async () => {
    const h = harness();
    const q = new ScriptedQueue([{ status: 'done', slug: 'a' }, { status: 'hang' }]);
    const summary = await startRealRun({
      session: session(['https://example.com/a', 'https://example.com/b'], 1, 100),
      jobs: q,
      library,
      provider: () => provider(),
      ...h,
    });
    expect(summary.jobs.map((j) => j.status)).toEqual(['done', 'timeout']);
    expect(q.cancelled).toEqual(['job-1']);
    expect(h.codes).toEqual([1]);
  });

  it('refuses a provider that is not behind the budget guard before starting any job', async () => {
    const h = harness();
    const q = new ScriptedQueue([]);
    const summary = await startRealRun({
      session: session(['https://example.com/a']),
      jobs: q,
      library,
      provider: () => new FakeProvider({ responses: {} }, { model: 'claude-opus-5' }),
      ...h,
    });
    expect(q.started).toEqual([]);
    expect(summary).toMatchObject({ ok: false, error: expect.stringMatching(/budget guard/) as string, jobs: [] });
    expect(h.codes).toEqual([1]);
  });

  it('refuses an unpriced model before starting any job', async () => {
    const h = harness();
    const q = new ScriptedQueue([]);
    const summary = await startRealRun({
      session: session(['https://example.com/a']),
      jobs: q,
      library,
      provider: () => provider('fake-model'),
      ...h,
    });
    expect(q.started).toEqual([]);
    expect(summary).toMatchObject({ ok: false, error: expect.stringMatching(/unknown model/) as string, jobs: [] });
    expect(h.codes).toEqual([1]);
  });

  it('refuses to start when the ledger cannot fund even one minimal call', async () => {
    const h = harness();
    const q = new ScriptedQueue([]);
    // 2048 output tokens at $25/MTok = 0.0512 > 0.05.
    const summary = await startRealRun({
      session: session(['https://example.com/a'], 0.05),
      jobs: q,
      library,
      provider: () => provider(),
      ...h,
    });
    expect(q.started).toEqual([]);
    expect(summary).toMatchObject({ ok: false, error: 'budget exhausted' });
    expect(h.codes).toEqual([1]);
  });
});

// ---- rebuild mode (design §5, D19-D24) ----

describe('realRunConfigFromEnv rebuild mode', () => {
  let a: string;
  let b: string;
  beforeEach(async () => {
    a = path.join(dir, 'part-1.md');
    b = path.join(dir, 'part-2.md');
    await writeFile(a, '# One\n');
    await writeFile(b, '# Two\n');
  });
  const rb = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
    ELI5_REAL_RUN_REBUILD: `doc-one=${a}, doc-two=${b}`,
    ELI5_REAL_RUN_BUDGET_USD: '12',
    ELI5_REAL_RUN_LEDGER: path.join(dir, 'owner-ledger.jsonl'),
    ...over,
  });

  it('parses slug=file entries with the defaults: no dry run, no rehearsal, a $4 per-document gate', () => {
    expect(realRunConfigFromEnv(rb(), unpackaged())).toEqual({
      urls: [],
      budgetUsd: 12,
      ledgerPath: path.join(dir, 'owner-ledger.jsonl'),
      timeoutMs: 30 * 60_000,
      rebuild: {
        entries: [
          { slug: 'doc-one', file: a },
          { slug: 'doc-two', file: b },
        ],
        dry: false,
        rehearsal: false,
        docGateUsd: 4,
      },
    });
  });

  it('reads DRY, PROMPT_SET and DOC_GATE_USD', () => {
    const cfg = realRunConfigFromEnv(
      rb({ ELI5_REAL_RUN_DRY: '1', ELI5_REAL_RUN_PROMPT_SET: 'wsj-v1', ELI5_REAL_RUN_DOC_GATE_USD: '2.5' }),
      unpackaged(),
    );
    expect(cfg?.rebuild).toMatchObject({ dry: true, promptSet: 'wsj-v1', docGateUsd: 2.5 });
  });

  it('is inactive in packaged builds', () => {
    expect(realRunConfigFromEnv(rb(), { isPackaged: true, userData: dir })).toBeUndefined();
  });

  it('accepts ELI5_LLM_FAKE=1 only in a test build, as a rehearsal', () => {
    expect(() => realRunConfigFromEnv(rb({ ELI5_LLM_FAKE: '1' }), unpackaged())).toThrow(/ELI5_LLM_FAKE/);
    const cfg = realRunConfigFromEnv(rb({ ELI5_LLM_FAKE: '1' }), { ...unpackaged(), testBuild: true });
    expect(cfg?.rebuild?.rehearsal).toBe(true);
    // A rehearsal spends nothing, so it may use the default ledger.
    const noLedger = realRunConfigFromEnv(rb({ ELI5_LLM_FAKE: '1', ELI5_REAL_RUN_LEDGER: undefined }), {
      ...unpackaged(),
      testBuild: true,
    });
    expect(noLedger?.ledgerPath).toBe(path.join(dir, 'devtools', 'real-run-ledger.jsonl'));
    // Real (URL) mode still refuses the fake in a test build.
    expect(() => realRunConfigFromEnv(env({ ELI5_LLM_FAKE: '1' }), { ...unpackaged(), testBuild: true })).toThrow(
      /ELI5_LLM_FAKE/,
    );
  });

  it.each([
    ['with URLS', { ELI5_REAL_RUN_URLS: 'https://example.com/' }, /exclusive/],
    ['an empty list', { ELI5_REAL_RUN_REBUILD: ' , ' }, /REBUILD/],
    ['an entry without =', { ELI5_REAL_RUN_REBUILD: 'doc-one' }, /slug=/],
    ['an invalid slug', { ELI5_REAL_RUN_REBUILD: 'Doc One=/tmp/x.md' }, /slug/],
    ['a relative path', { ELI5_REAL_RUN_REBUILD: 'doc-one=part-1.md' }, /absolute/],
    ['a missing file', { ELI5_REAL_RUN_REBUILD: 'doc-one=/nonexistent/eli5/part.md' }, /regular file/],
    ['a duplicate slug', { ELI5_REAL_RUN_REBUILD: 'doc-one=/a.md,doc-one=/b.md' }, /twice/],
    ['DRY not 1', { ELI5_REAL_RUN_DRY: 'yes' }, /DRY/],
    ['a bad prompt set', { ELI5_REAL_RUN_PROMPT_SET: '../x' }, /PROMPT_SET/],
    ['a zero gate', { ELI5_REAL_RUN_DOC_GATE_USD: '0' }, /DOC_GATE/],
    ['a non-numeric gate', { ELI5_REAL_RUN_DOC_GATE_USD: 'four' }, /DOC_GATE/],
    ['no budget', { ELI5_REAL_RUN_BUDGET_USD: undefined }, /BUDGET/],
    ['no ledger of its own (D24)', { ELI5_REAL_RUN_LEDGER: undefined }, /ELI5_REAL_RUN_LEDGER/],
    ['a blank ledger', { ELI5_REAL_RUN_LEDGER: ' ' }, /ELI5_REAL_RUN_LEDGER/],
  ])('refuses %s', (_name, over, msg) => {
    expect(() => realRunConfigFromEnv(rb(over), unpackaged())).toThrow(msg);
  });

  it('refuses a directory and more than four documents', async () => {
    await mkdir(path.join(dir, 'folder'));
    expect(() =>
      realRunConfigFromEnv(rb({ ELI5_REAL_RUN_REBUILD: `doc-one=${path.join(dir, 'folder')}` }), unpackaged()),
    ).toThrow(/regular file/);
    const five = ['a', 'b', 'c', 'd', 'e'].map((s) => `doc-${s}=${a}`).join(',');
    expect(() => realRunConfigFromEnv(rb({ ELI5_REAL_RUN_REBUILD: five }), unpackaged())).toThrow(/1-4/);
  });

  it('prepareRealRun in rehearsal opens the ledger but installs no guard (the fake stays registered)', () => {
    const ids: string[] = [];
    const spy = { frozen: false, registerLLMProvider: (id: string) => void ids.push(id) };
    const session = prepareRealRun({
      env: rb({ ELI5_LLM_FAKE: '1' }),
      isPackaged: false,
      testBuild: true,
      userData: dir,
      registry: spy,
    });
    expect(session?.config.rebuild?.rehearsal).toBe(true);
    expect(ids).toEqual([]);
    session?.ledger.release();
  });
});
