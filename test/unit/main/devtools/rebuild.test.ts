/**
 * The rebuild-as-new-version driver (design §5, D19-D20, D23-D24) with a scripted queue and an
 * in-memory library: preflight refusals, the dry-run plan (no provider call), the cost math, one
 * document at a time, the per-document gate and the hard stop. Offline; nothing is spent.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BudgetGuardProvider,
  BudgetLedger,
  planRebuildCost,
  REBUILD_HARD_STOP_USD,
  rebuildPlanInputs,
  startRebuildRun,
  TYPICAL_OUTPUT_TOKENS,
  TYPICAL_RETRY_SHARE,
  type RebuildLibrary,
  type RebuildQueue,
  type RebuildVerify,
  type RealRunSession,
  type StartRebuildRunOptions,
} from '../../../../src/main/devtools';
import type { DocumentMeta, VersionTreeView } from '../../../../src/main/library';
import { PromptCatalogue, SkillLibrary, type LLMProvider } from '../../../../src/main/llm';
import { FakeProvider } from '../../../../src/main/llm/testing/fake';
import type { Job, JobSnapshot, RebuildTarget, StartJobRequest } from '../../../../src/main/pipeline';

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'eli5-rebuild-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---- cost math ----

describe('planRebuildCost', () => {
  const rates = { inputPerMTok: 4, outputPerMTok: 20 };

  it('prices every step at $4/$20 per MTok: typical at 1x input, worst case at the guard reservation', () => {
    const plan = planRebuildCost({
      rates,
      sourceTokens: 10_000,
      glossary: true,
      photos: true,
      maxOutputTokens: () => 30_000,
      overheadTokens: () => 1_000,
    });
    const I = 4e-6;
    const O = 20e-6;
    // Typical: outputs from TYPICAL_OUTPUT_TOKENS (all below the 30k cap); inputs grow with drafts.
    const t = TYPICAL_OUTPUT_TOKENS;
    const callsIn =
      (1_000 + 10_000) * 2 + // in-depth, eli5
      (1_000 + t['in-depth']) + // ste
      (1_000 + t.eli5 + Math.ceil(t['in-depth'] / 10)) + // eli5-critique (draft + outline)
      (1_000 + t['in-depth']) * 2 + // glossary, summary
      1_000; // photo-pick
    const callsOut = t['in-depth'] + t.eli5 + t.ste + t['eli5-critique'] + t.glossary + t.summary + t['photo-pick'];
    // Retries: a share of every typical call on top.
    const typicalIn = callsIn + Math.ceil(callsIn * TYPICAL_RETRY_SHARE);
    const typicalOut = callsOut + Math.ceil(callsOut * TYPICAL_RETRY_SHARE);
    expect(plan.typicalUsd).toBeCloseTo(typicalIn * I + typicalOut * O, 10);
    // Worst: every call at its full cap, one STE repair, one in-depth-sized retry, input at 1.25x.
    const worstIn =
      (1_000 + 10_000) * 2 +
      (1_000 + 30_000) + // ste
      (1_000 + 30_000 + 30_000) + // ste-repair
      (1_000 + 30_000 + 3_000) + // eli5-critique
      (1_000 + 30_000) * 2 + // glossary, summary
      1_000 + // photo-pick
      (1_000 + 10_000 + 30_000); // retries
    const worstOut = 30_000 * 9;
    expect(plan.worstUsd).toBeCloseTo(worstIn * I * 1.25 + worstOut * O, 10);
    expect(plan.calls.map((c) => c.step)).toEqual([
      'in-depth',
      'eli5',
      'ste',
      'ste-repair',
      'eli5-critique',
      'glossary',
      'summary',
      'photo-pick',
      'retries',
    ]);
  });

  it('counts the step 1b calls (ste, eli5-critique) and leaves the glossary out when it is off', () => {
    const plan = planRebuildCost({
      rates,
      sourceTokens: 0,
      glossary: false,
      photos: false,
      maxOutputTokens: () => 1_000,
      overheadTokens: () => 0,
    });
    const steps = plan.calls.map((c) => c.step);
    expect(steps).toContain('ste');
    expect(steps).toContain('eli5-critique');
    expect(steps).not.toContain('glossary');
    expect(steps).not.toContain('photo-pick');
    // Typical output is capped by the step's own maxOutputTokens.
    expect(plan.calls.find((c) => c.step === 'in-depth')?.typicalOutputTokens).toBe(1_000);
    // The repair only exists in the worst case.
    expect(plan.calls.find((c) => c.step === 'ste-repair')?.typicalOutputTokens).toBe(0);
  });

  it('keeps a document from the default prompts under the $4 gate typically, near the design estimate', () => {
    const max: Record<string, number> = {
      'in-depth': 32_000,
      eli5: 32_000,
      ste: 32_000,
      'eli5-critique': 24_000,
      glossary: 8_000,
      summary: 2_000,
      'photo-pick': 1_000,
    };
    const plan = planRebuildCost({
      rates,
      sourceTokens: 15_000,
      glossary: true,
      photos: true,
      maxOutputTokens: (id) => max[id] ?? 0,
      overheadTokens: () => 5_000,
    });
    expect(plan.typicalUsd).toBeGreaterThan(1.2);
    expect(plan.typicalUsd).toBeLessThan(2.2);
    expect(plan.worstUsd).toBeGreaterThan(plan.typicalUsd);
  });
});

// ---- the driver ----

interface FakeDoc {
  meta: DocumentMeta;
  html: string;
  currentId: string;
  detached?: boolean;
  treeReadOnly?: boolean;
}

function meta(slug: string, fileSha: string, over: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    schemaVersion: 1,
    id: `id-${slug}`,
    topicSlug: slug,
    title: slug,
    summary: 's',
    summarySource: 'llm',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    jobId: 'j0',
    edition: 'public',
    clarifyingInput: 'for a statistician',
    glossaryEnabled: true,
    sourcesUsed: [{ ref: `${slug}.md`, kind: 'file', mimeType: 'text/markdown', sha256: fileSha }],
    sourcesSkipped: [],
    tabs: [],
    retiredIds: [],
    generation: { provider: 'claude', model: 'claude-opus-5-5', prompts: [] },
    warnings: [],
    merges: [],
    publications: [],
    ...over,
  } as DocumentMeta;
}

class FakeLibrary implements RebuildLibrary {
  readOnly = false;
  readonly docs = new Map<string, FakeDoc>();
  hasSlug(slug: string): boolean {
    return this.docs.has(slug);
  }
  getEntry(slug: string): { id: string; createdAt: string } | undefined {
    const d = this.docs.get(slug);
    return d ? { id: d.meta.id, createdAt: d.meta.createdAt } : undefined;
  }
  getMeta(slug: string): Promise<DocumentMeta> {
    const d = this.docs.get(slug);
    return d ? Promise.resolve(structuredClone(d.meta)) : Promise.reject(new Error('NOT_FOUND'));
  }
  docPath(slug: string): string {
    return path.join(dir, 'lib', slug, 'index.html');
  }
  versions(slug: string): Promise<VersionTreeView> {
    const d = this.docs.get(slug);
    if (!d) return Promise.reject(new Error('NOT_FOUND'));
    return Promise.resolve({
      slug,
      tree: { schemaVersion: 1, rootId: d.currentId, currentId: d.currentId, nodes: [] },
      detached: d.detached ?? false,
      readOnly: d.treeReadOnly ?? false,
      degraded: false,
    } as VersionTreeView);
  }
  readVersion(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }
}

/** Finishes each rebuild job after a tick, charging `costUsd` to the ledger, in start order. */
class ScriptedRebuildQueue implements RebuildQueue {
  readonly started: { req: StartJobRequest; target: RebuildTarget; runningWhenStarted: number }[] = [];
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Set<(s: JobSnapshot) => void>();
  private running = 0;
  readonly cancelled: string[] = [];
  constructor(
    private readonly onFinish: (i: number) => void = () => {},
    private readonly fail = false,
    /** When set, a job finishes only after a cancel. */
    private readonly hang = false,
  ) {}
  startRebuild(req: StartJobRequest, target: RebuildTarget): Promise<{ jobId: string }> {
    const i = this.started.length;
    this.started.push({ req, target, runningWhenStarted: this.running });
    this.running++;
    const id = `job-${i}`;
    const job = {
      id,
      kind: 'create',
      status: 'queued',
      inputs: req.inputs,
      options: req.options,
      warnings: [],
      skipped: [],
      rebuild: { ...target },
    } as unknown as Job;
    this.jobs.set(id, job);
    if (this.hang) return Promise.resolve({ jobId: id });
    setTimeout(() => {
      this.onFinish(i);
      this.running--;
      if (this.fail) {
        job.status = 'failed';
        job.failure = { code: 'SAVE_FAILED', message: 'failed', detail: 'REBUILD_BASE_MOVED' };
      } else {
        job.status = 'done';
        job.result = { docId: target.docId, topicSlug: target.slug, title: 'T' };
        job.warnings = [];
        job.rebuild = {
          ...target,
          report: { steLint: { sentences: 10, failing: 1, score: 0.1 }, eli5Critique: 'accepted' },
        };
      }
      for (const l of this.listeners) l({ id, status: job.status } as JobSnapshot);
    }, 5);
    return Promise.resolve({ jobId: id });
  }
  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }
  on(_e: 'changed', cb: (s: JobSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  cancel(id: string): Promise<void> {
    this.cancelled.push(id);
    const job = this.jobs.get(id);
    if (job && this.hang) {
      // The job stops a little later, after spending a last call.
      setTimeout(() => {
        this.onFinish(-1);
        this.running--;
        job.status = 'failed';
        job.failure = { code: 'CANCELLED', message: 'cancelled' };
        for (const l of this.listeners) l({ id, status: job.status } as JobSnapshot);
      }, 20);
    }
    return Promise.resolve();
  }
}

const OK_VERIFY: RebuildVerify = {
  ok: true,
  versionId: 'v-new000000000',
  parentVersionId: 'v-base00000000',
  label: 'Rebuilt with prompt set default (0123abcd)',
  validity: true,
  roundTrip: true,
  hasSte: true,
  catalogStable: true,
  jobNode: true,
  parentIsBase: true,
  parentHtmlMatches: true,
};

interface Setup {
  lib: FakeLibrary;
  files: Record<string, string>;
  session: RealRunSession;
  fake: FakeProvider;
  out: string[];
  codes: number[];
  opts: (over?: Partial<StartRebuildRunOptions>) => StartRebuildRunOptions;
}

async function setup(
  slugs: string[],
  o: { capUsd?: number; dry?: boolean; rehearsal?: boolean; promptSet?: string; docGateUsd?: number } = {},
): Promise<Setup> {
  const lib = new FakeLibrary();
  const files: Record<string, string> = {};
  for (const slug of slugs) {
    const file = path.join(dir, `${slug}.md`);
    const body = `# ${slug}\n\n${'Some text. '.repeat(200)}\n`;
    await writeFile(file, body);
    files[slug] = file;
    const html = `<html>${slug}</html>`;
    lib.docs.set(slug, { meta: meta(slug, sha(body)), html, currentId: `v-${slug.slice(0, 4)}base0000` });
    await mkdir(path.dirname(lib.docPath(slug)), { recursive: true });
    await writeFile(lib.docPath(slug), html);
  }
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  const capUsd = o.capUsd ?? 12;
  const session: RealRunSession = {
    config: {
      urls: [],
      budgetUsd: capUsd,
      ledgerPath,
      timeoutMs: 5_000,
      rebuild: {
        entries: slugs.map((slug) => ({ slug, file: files[slug] ?? '' })),
        dry: o.dry ?? false,
        rehearsal: o.rehearsal ?? false,
        docGateUsd: o.docGateUsd ?? 4,
        ...(o.promptSet ? { promptSet: o.promptSet } : {}),
      },
    },
    ledger: new BudgetLedger({ path: ledgerPath, capUsd }),
  };
  const fake = new FakeProvider({ responses: {} }, { model: 'claude-opus-5-5' });
  const guarded: LLMProvider = new BudgetGuardProvider(fake, session.ledger);
  const out: string[] = [];
  const codes: number[] = [];
  const opts = (over: Partial<StartRebuildRunOptions> = {}): StartRebuildRunOptions => ({
    session,
    jobs: new ScriptedRebuildQueue(),
    library: lib,
    provider: () => (o.rehearsal ? fake : guarded),
    promptSet: 'default',
    keyPresent: () => Promise.resolve(true),
    planInputs: { maxOutputTokens: () => 32_000, overheadTokens: () => 5_000 },
    stockPhotos: true,
    verify: () => Promise.resolve(OK_VERIFY),
    write: (t) => void out.push(t),
    quit: (c) => void codes.push(c),
    ...over,
  });
  return { lib, files, session, fake, out, codes, opts };
}

const charge = (ledger: BudgetLedger, usd: number): void => {
  const r = ledger.reserve({ maxCostUsd: usd, model: 'claude-opus-5-5', taskId: 'in-depth' });
  ledger.settle(r, {
    costUsd: usd,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outcome: 'ok',
  });
};

describe('startRebuildRun: dry run', () => {
  it('runs the preflight and prints the plan without any provider call, job or ledger line', async () => {
    const s = await setup(['doc-one', 'doc-two'], { dry: true });
    const jobs = new ScriptedRebuildQueue();
    const summary = await startRebuildRun(s.opts({ jobs }));
    expect(s.fake.calls).toEqual([]);
    expect(jobs.started).toEqual([]);
    await expect(readFile(s.session.config.ledgerPath, 'utf8').catch(() => '')).resolves.toBe('');
    expect(summary).toMatchObject({ ok: true, mode: 'dry', promptSet: 'default', docs: [] });
    expect(summary.preflight.map((p) => [p.slug, p.ok, p.shaMatches])).toEqual([
      ['doc-one', true, true],
      ['doc-two', true, true],
    ]);
    expect(summary.preflight[0]?.baseVersionId).toBe('v-doc-base0000');
    expect(summary.preflight[0]?.baseHtmlSha256).toBe(sha('<html>doc-one</html>'));
    expect(summary.plan).toHaveLength(2);
    for (const p of summary.plan) {
      expect(p.typicalUsd).toBeGreaterThan(0);
      expect(p.worstUsd).toBeGreaterThan(p.typicalUsd);
    }
    expect(summary.planTotal.worstUsd).toBeCloseTo((summary.plan[0]?.worstUsd ?? 0) * 2, 10);
    expect(JSON.parse(s.out.join(''))).toEqual(JSON.parse(JSON.stringify(summary)));
    expect(s.codes).toEqual([0]);
  });
});

describe('startRebuildRun: dry run in a rehearsal', () => {
  it('DRY wins over ELI5_LLM_FAKE: no job starts and nothing is written', async () => {
    const s = await setup(['doc-one'], { dry: true, rehearsal: true });
    const jobs = new ScriptedRebuildQueue();
    const summary = await startRebuildRun(s.opts({ jobs }));
    expect(jobs.started).toEqual([]);
    expect(s.fake.calls).toEqual([]);
    expect(summary).toMatchObject({ ok: true, mode: 'dry', docs: [] });
  });
});

describe('startRebuildRun: the printed summary', () => {
  it('carries no clarifying input and no local path, only the source file name', async () => {
    const s = await setup(['doc-one'], { dry: true });
    await startRebuildRun(s.opts());
    const printed = s.out.join('');
    expect(printed).not.toContain('for a statistician');
    expect(printed).not.toContain(dir);
    expect((JSON.parse(printed) as { preflight: { file: string }[] }).preflight[0]?.file).toBe('doc-one.md');
  });

  it('still sends the clarifying input and the full path to the job', async () => {
    const s = await setup(['doc-one']);
    const jobs = new ScriptedRebuildQueue();
    await startRebuildRun(s.opts({ jobs }));
    expect(jobs.started[0]?.req.options.clarifyingInput).toBe('for a statistician');
    expect(jobs.started[0]?.req.inputs[0]).toMatchObject({ path: s.files['doc-one'] });
  });
});

describe('startRebuildRun: preflight refusals (nothing starts)', () => {
  const cases: [string, (s: Setup) => Partial<StartRebuildRunOptions> | void, RegExp][] = [
    [
      'a source file whose sha256 differs from meta.sourcesUsed',
      (s) => void writeFile(s.files['doc-one'] ?? '', 'changed'),
      /sha256/,
    ],
    ['a read-only library', (s) => void (s.lib.readOnly = true), /read-only/],
    [
      'a version tree written by a newer app',
      (s) => void ((s.lib.docs.get('doc-one') as FakeDoc).treeReadOnly = true),
      /version tree is read-only/,
    ],
    [
      'a detached document (changed outside the app)',
      (s) => void ((s.lib.docs.get('doc-one') as FakeDoc).detached = true),
      /matches no version/,
    ],
    [
      'a document with other sources',
      (s) => {
        const m = (s.lib.docs.get('doc-one') as FakeDoc).meta;
        m.sourcesUsed = [
          ...m.sourcesUsed,
          { ref: 'https://example.com/', kind: 'url', mimeType: 'text/html', sha256: sha('x') },
        ] as DocumentMeta['sourcesUsed'];
      },
      /other source/,
    ],
    ['an unknown slug', (s) => void s.lib.docs.delete('doc-one'), /not in the library/],
    ['a prompt set other than the effective one', () => ({ promptSet: 'wsj-v1' }), /prompt set/],
    ['a missing Keychain key', () => ({ keyPresent: () => Promise.resolve(false) }), /key/],
    ['a provider outside the budget guard', (s) => ({ provider: () => s.fake }), /budget guard/],
    [
      'an unpriced model',
      (s) => ({
        provider: () =>
          new BudgetGuardProvider(new FakeProvider({ responses: {} }, { model: 'fake-model' }), s.session.ledger),
      }),
      /unknown model/,
    ],
  ];
  it.each(cases)('refuses %s', async (_name, arrange, msg) => {
    const s = await setup(['doc-one'], { promptSet: 'default' });
    const over = arrange(s) ?? {};
    await new Promise((r) => setTimeout(r, 5)); // let a file rewrite land
    const jobs = new ScriptedRebuildQueue();
    const summary = await startRebuildRun(s.opts({ jobs, ...over }));
    expect(jobs.started).toEqual([]);
    expect(s.fake.calls).toEqual([]);
    expect(summary.ok).toBe(false);
    expect(summary.error ?? summary.preflight.map((p) => p.problem).join(' ')).toMatch(msg);
    expect(s.codes).toEqual([1]);
  });

  it('a requested prompt set must equal the effective one (ELI5_REAL_RUN_PROMPT_SET)', async () => {
    const s = await setup(['doc-one'], { promptSet: 'wsj-v1' });
    const jobs = new ScriptedRebuildQueue();
    const summary = await startRebuildRun(s.opts({ jobs, promptSet: 'default' }));
    expect(jobs.started).toEqual([]);
    expect(summary.error).toMatch(/prompt set/);
  });
});

describe('startRebuildRun: real run', () => {
  it('rebuilds one document at a time with the captured base and reports a row per document', async () => {
    const s = await setup(['doc-one', 'doc-two']);
    const jobs = new ScriptedRebuildQueue((i) => charge(s.session.ledger, 1 + i));
    const summary = await startRebuildRun(s.opts({ jobs }));
    expect(jobs.started.map((x) => x.runningWhenStarted)).toEqual([0, 0]);
    expect(jobs.started[0]?.target).toEqual({
      slug: 'doc-one',
      docId: 'id-doc-one',
      baseVersionId: 'v-doc-base0000',
      baseHtmlSha256: sha('<html>doc-one</html>'),
      promptSet: 'default',
    });
    expect(jobs.started[0]?.req).toEqual({
      inputs: [{ id: expect.stringMatching(/^in-/) as string, kind: 'file', origin: 'drop', path: s.files['doc-one'] }],
      options: { clarifyingInput: 'for a statistician', glossary: true },
    });
    expect(summary).toMatchObject({ ok: true, mode: 'rebuild', ledgerBeforeUsd: 0 });
    expect(summary.ledgerAfterUsd).toBeCloseTo(3, 10);
    expect(summary.spentUsd).toBeCloseTo(3, 10);
    expect(summary.docs).toEqual([
      {
        slug: 'doc-one',
        ok: true,
        jobId: 'job-0',
        status: 'done',
        versionId: OK_VERIFY.versionId,
        parentVersionId: OK_VERIFY.parentVersionId,
        label: OK_VERIFY.label,
        spentUsd: expect.closeTo(1, 10) as number,
        steLint: { sentences: 10, failing: 1, score: 0.1 },
        eli5CritiqueAccepted: true,
        warnings: [],
        verify: OK_VERIFY,
      },
      expect.objectContaining({ slug: 'doc-two', ok: true, spentUsd: expect.closeTo(2, 10) as number }),
    ]);
    expect(s.codes).toEqual([0]);
  });

  it('stops cleanly before a document when the remaining cap is below the per-document gate', async () => {
    const s = await setup(['doc-one', 'doc-two'], { capUsd: 6 });
    const jobs = new ScriptedRebuildQueue(() => charge(s.session.ledger, 2.5));
    const summary = await startRebuildRun(s.opts({ jobs }));
    // $6 cap: doc-one starts with $6 left; afterwards $3.5 < $4, so doc-two never starts.
    expect(jobs.started.map((x) => x.target.slug)).toEqual(['doc-one']);
    expect(summary).toMatchObject({ ok: false, stopped: 'budget-gate' });
    expect(summary.docs.map((d) => d.slug)).toEqual(['doc-one']);
    expect(s.codes).toEqual([1]);
  });

  it('stops before the loop when the ledger cannot pay for a minimum response, whatever the doc gate (audit round 4)', async () => {
    // A doc gate below the cost of MIN_OUTPUT_TOKENS ($0.04 at $20/MTok) would let a document start.
    const s = await setup(['doc-one'], { capUsd: 12, docGateUsd: 0.001 });
    charge(s.session.ledger, 12 - 0.01);
    const jobs = new ScriptedRebuildQueue();
    const summary = await startRebuildRun(s.opts({ jobs }));
    expect(jobs.started).toEqual([]);
    expect(summary).toMatchObject({ ok: false, error: 'budget exhausted' });
    expect(s.codes).toEqual([1]);
  });

  it(`hard-stops before a document once the ledger has passed $${REBUILD_HARD_STOP_USD}`, async () => {
    const s = await setup(['doc-one'], { capUsd: 20 });
    charge(s.session.ledger, REBUILD_HARD_STOP_USD + 0.01);
    const jobs = new ScriptedRebuildQueue();
    const summary = await startRebuildRun(s.opts({ jobs }));
    expect(jobs.started).toEqual([]);
    expect(summary).toMatchObject({ ok: false, stopped: 'hard-stop' });
  });

  it('marks a failed rebuild (base moved) as not ok and skips its verification', async () => {
    const s = await setup(['doc-one']);
    let verified = 0;
    const summary = await startRebuildRun(
      s.opts({
        jobs: new ScriptedRebuildQueue(() => {}, true),
        verify: () => {
          verified++;
          return Promise.resolve(OK_VERIFY);
        },
      }),
    );
    expect(verified).toBe(0);
    expect(summary.docs[0]).toMatchObject({ ok: false, status: 'failed', failureCode: 'SAVE_FAILED' });
    expect(s.codes).toEqual([1]);
  });

  it('after a timeout it waits for the cancelled job to stop, then stops the run', async () => {
    const s = await setup(['doc-one', 'doc-two']);
    s.session.config.timeoutMs = 10;
    const jobs = new ScriptedRebuildQueue(() => charge(s.session.ledger, 0.5), false, true);
    const summary = await startRebuildRun(s.opts({ jobs, cancelGraceMs: 2_000 }));
    expect(jobs.cancelled).toEqual(['job-0']);
    // doc-two never starts, and the spend of the cancelled job lands in its own row.
    expect(jobs.started.map((x) => x.target.slug)).toEqual(['doc-one']);
    expect(summary).toMatchObject({ ok: false, stopped: 'timeout' });
    expect(summary.docs).toEqual([
      expect.objectContaining({ slug: 'doc-one', ok: false, status: 'failed', failureCode: 'CANCELLED' }),
    ]);
    expect(summary.docs[0]?.spentUsd).toBeCloseTo(0.5, 10);
  });

  it('a failed verification makes the row and the run not ok', async () => {
    const s = await setup(['doc-one']);
    const summary = await startRebuildRun(
      s.opts({ verify: () => Promise.resolve({ ...OK_VERIFY, ok: false, parentHtmlMatches: false }) }),
    );
    expect(summary.docs[0]?.ok).toBe(false);
    expect(summary.ok).toBe(false);
  });
});

describe('startRebuildRun: rehearsal (fake LLM, test builds only)', () => {
  it('accepts the unguarded fake, skips the key check and the money gates', async () => {
    const s = await setup(['doc-one', 'doc-two'], { rehearsal: true, capUsd: 1 });
    const jobs = new ScriptedRebuildQueue();
    let keyChecked = false;
    const summary = await startRebuildRun(
      s.opts({
        jobs,
        keyPresent: () => {
          keyChecked = true;
          return Promise.resolve(false);
        },
      }),
    );
    expect(keyChecked).toBe(false);
    expect(jobs.started).toHaveLength(2);
    expect(summary).toMatchObject({ ok: true, mode: 'rehearsal' });
  });
});

describe('rebuildPlanInputs', () => {
  it('reads maxOutputTokens from the front matter clamped by the setting, and counts template, fragments and skills', () => {
    const REPO = path.resolve(import.meta.dirname, '../../../..');
    const prompts = PromptCatalogue.load({ root: path.join(REPO, 'config/prompts') });
    const skills = new SkillLibrary([path.join(REPO, 'resources/skills')]);
    const inputs = rebuildPlanInputs({ prompts, skills, contextTokens: () => 200_000, maxOutputSetting: () => 20_000 });
    expect(inputs.maxOutputTokens('in-depth')).toBe(Math.min(prompts.get('in-depth').maxOutputTokens, 20_000));
    expect(inputs.maxOutputTokens('summary')).toBe(prompts.get('summary').maxOutputTokens);
    const def = prompts.get('in-depth');
    const bare = rebuildPlanInputs({ prompts, contextTokens: () => 200_000, maxOutputSetting: () => 32_000 });
    // Fragments (chart, animation, diagram rules) and skills make the overhead larger than the template.
    expect(bare.overheadTokens('in-depth')).toBeGreaterThan(Math.ceil((def.system.length + def.user.length) / 3));
    expect(inputs.overheadTokens('in-depth')).toBeGreaterThan(bare.overheadTokens('in-depth'));
  });
});
