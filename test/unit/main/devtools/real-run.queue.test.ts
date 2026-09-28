/**
 * The real-run driver over the real JobQueue, registry, fetch path (fixture server) and library,
 * with FakeProvider (priced as claude-opus-5) behind the BudgetGuardProvider. Offline.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryKeyStore } from '../../../../src/main/config';
import { DEFAULTS, type Settings } from '../../../../src/main/config/schema';
import { bundledDocRuntime, type DocRuntime } from '../../../../src/main/document';
import { prepareRealRun, startRealRun, type RealRunSession } from '../../../../src/main/devtools';
import { registerPublicCapabilities } from '../../../../src/main/editions/public';
import { Registry } from '../../../../src/main/editions/registry';
import { createFetcher, inProcessReadability, nodeTransport } from '../../../../src/main/fetch';
import { requestHeaders } from '../../../../src/main/fetch/network';
import { Politeness } from '../../../../src/main/fetch/politeness';
import { openLibrary } from '../../../../src/main/library';
import { FakeProvider, loadFakeScript } from '../../../../src/main/llm/testing/fake';
import { createPipelineDeps, JobQueue } from '../../../../src/main/pipeline';
import { fakeServices } from '../../../contracts/extractor.contract';
import { STUB_RUNTIME } from '../../../fixtures/documents/runtime';
import { FakeClock } from '../../../helpers/clock';
import { startFixtureServer, type FixtureServer } from '../../../helpers/fixture-server';
import { SeededIdSource } from '../../../helpers/ids';
import { tmpLibrary } from '../../../helpers/tmp-library';

const REPO = path.resolve(import.meta.dirname, '../../../..');
const read = (p: string): string => readFileSync(p, 'utf8');
const runtime = (): DocRuntime => {
  try {
    return bundledDocRuntime();
  } catch {
    return STUB_RUNTIME;
  }
};

let server: FixtureServer;
beforeAll(async () => {
  server = await startFixtureServer({ slowMs: 2_000 });
});
afterAll(async () => {
  await server.close();
});

async function launch(env: Record<string, string>): Promise<{
  queue: JobQueue;
  session: RealRunSession;
  fake: FakeProvider;
  registry: Registry;
  docPath: (slug: string) => string;
  dispose: () => void;
}> {
  const { userData } = await tmpLibrary();
  const clock = new FakeClock('2026-09-01T09:00:00.000Z');
  const settings: Settings = { ...DEFAULTS };
  const fake = new FakeProvider(loadFakeScript(path.join(REPO, 'test/fixtures/llm/default.json'), read), {
    model: 'claude-opus-5',
  });
  const registry = new Registry({ edition: 'public', getSettings: () => settings });
  registerPublicCapabilities(registry);
  const session = prepareRealRun({
    env: { ...env, ELI5_REAL_RUN_LEDGER: path.join(userData, 'ledger.jsonl') },
    isPackaged: false,
    userData,
    registry,
    base: { claude: () => fake },
  });
  if (!session) throw new Error('real run not armed');
  registry.freeze();
  const lib = await openLibrary({
    rootInput: { isPackaged: false, repoRoot: '/nonexistent-repo', userData, env: process.env },
    appVersion: '0.0.0-test',
    clock,
    ids: new SeededIdSource(3),
    processLock: false,
  });
  const fetcher = createFetcher({
    transport: nodeTransport(),
    headers: requestHeaders('Mozilla/5.0 TestChromium ELI5Learner/0.0.0', ['en-US']),
    readability: inProcessReadability,
    lookup: async () => ['203.0.113.10'],
    politeness: new Politeness({ hostIntervalMs: 0 }),
    sleep: async () => {},
  });
  const services = fakeServices();
  let seq = 0;
  const rt = createPipelineDeps({
    registry,
    settings: () => settings,
    keyStore: new MemoryKeyStore({ 'llm.claude.apiKey': ['sk', 'ant', 'realrun', 'fake'].join('-') }),
    library: lib,
    userData,
    resourcePath: (rel) => path.join(REPO, 'resources', rel),
    workerEntry: 'unused-in-node',
    watchSkills: false,
    extractServices: { renderPdfPages: services.renderPdfPages, normalizeImage: services.normalizeImage },
    fetchUrl: (u, ctx) => fetcher.fetchUrl(u, ctx),
    endFetchJob: (id) => fetcher.endJob(id),
    overrides: {
      clock,
      ids: {
        jobId: () => `01JRR${String(++seq).padStart(6, '0')}`,
        docId: () => `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      },
      sectionIds: new SeededIdSource(9),
      docRuntime: runtime(),
      sleep: async () => {},
    },
  });
  const queue = new JobQueue(rt.deps);
  await queue.init();
  return {
    queue,
    session,
    fake,
    registry,
    docPath: (slug) => lib.docPath(slug),
    dispose: () => {
      void queue.close();
      rt.dispose();
    },
  };
}

describe('real run over the JobQueue', () => {
  it('generates one document per URL through the budget guard and records spend in the ledger', async () => {
    const app = await launch({
      ELI5_REAL_RUN_URLS: `${server.url('/article/')},${server.url('/login-wall/')}`,
      ELI5_REAL_RUN_BUDGET_USD: '5',
    });
    const out: string[] = [];
    const codes: number[] = [];
    const summary = await startRealRun({
      session: app.session,
      jobs: app.queue,
      library: { docPath: app.docPath },
      provider: () => app.registry.llm(),
      write: (t) => void out.push(t),
      quit: (c) => void codes.push(c),
    });

    expect(summary.model).toBe('claude-opus-5');
    expect(summary.jobs.map((j) => j.status)).toEqual(['done', 'failed']);
    const [ok, bad] = summary.jobs;
    expect(ok?.indexPath).toBe(app.docPath(ok?.slug ?? ''));
    expect(await readFile(ok?.indexPath ?? '', 'utf8')).toContain('<html');
    expect(bad).toMatchObject({
      failureCode: 'NO_USABLE_CONTENT',
      skipped: [expect.objectContaining({ code: 'login-required' })],
    });
    expect(app.fake.calls.length).toBeGreaterThan(0);
    expect(summary.spentUsd).toBeGreaterThan(0);
    expect(summary.spentUsd).toBeLessThanOrEqual(5);
    expect(app.session.ledger.reservedUsd).toBe(0);
    const ledger = (await readFile(app.session.config.ledgerPath, 'utf8')).trim().split('\n');
    expect(ledger).toHaveLength(app.fake.calls.length * 2);
    expect(codes).toEqual([1]);
    expect(JSON.parse(out.join('')).jobs).toHaveLength(2);
    app.dispose();
  }, 30_000);

  it('a cap too small for any call fails the job without calling the model', async () => {
    const app = await launch({ ELI5_REAL_RUN_URLS: server.url('/article/'), ELI5_REAL_RUN_BUDGET_USD: '0.052' });
    const summary = await startRealRun({
      session: app.session,
      jobs: app.queue,
      library: { docPath: app.docPath },
      provider: () => app.registry.llm(),
      write: () => {},
      quit: () => {},
    });
    expect(summary.jobs[0]?.status).toBe('failed');
    expect(app.fake.calls).toEqual([]);
    expect(summary.spentUsd).toBe(0);
    app.dispose();
  }, 30_000);
});
