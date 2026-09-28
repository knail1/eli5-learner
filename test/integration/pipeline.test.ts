/**
 * Pipeline integration (13 §2 "Integration"): real registry, resolvers, fetch path (fixture server),
 * extractors, task functions, document builder, renderer and library, wired by createPipelineDeps,
 * with FakeProvider for the model and a temp userData + library. Offline, deterministic.
 */
import { readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryKeyStore } from '../../src/main/config';
import { DEFAULTS, type Settings } from '../../src/main/config/schema';
import { bundledDocRuntime, type DocRuntime } from '../../src/main/document';
import { registerPublicCapabilities } from '../../src/main/editions/public';
import { Registry } from '../../src/main/editions/registry';
import { createFetcher, inProcessReadability, nodeTransport, type Fetcher } from '../../src/main/fetch';
import { requestHeaders } from '../../src/main/fetch/network';
import { Politeness } from '../../src/main/fetch/politeness';
import { CATALOG_FILE, openLibrary, type DocumentMeta, type FsLibrary } from '../../src/main/library';
import type { LlmTasks } from '../../src/main/llm';
import { FakeProvider, loadFakeScript, type FakeScript } from '../../src/main/llm/testing/fake';
import {
  createPipelineDeps,
  isTerminal,
  JobQueue,
  type Job,
  type JobSnapshot,
  type PipelineRuntime,
} from '../../src/main/pipeline';
import type { SourceInput } from '../../src/preload/contract';
import { fakeServices } from '../contracts/extractor.contract';
import { STUB_RUNTIME } from '../fixtures/documents/runtime';
import { FakeClock } from '../helpers/clock';
import { validateDocument } from '../helpers/doc-validity';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server';
import { SeededIdSource } from '../helpers/ids';
import { tmpLibrary } from '../helpers/tmp-library';

const REPO = path.resolve(import.meta.dirname, '../..');
const FIXTURES = path.join(REPO, 'test/fixtures');
const read = (p: string): string => readFileSync(p, 'utf8');
const script = (over: Partial<FakeScript> = {}): FakeScript => ({
  ...loadFakeScript(path.join(FIXTURES, 'llm/default.json'), read),
  ...over,
});
const runtime = (): DocRuntime => {
  try {
    return bundledDocRuntime();
  } catch {
    return STUB_RUNTIME;
  }
};
const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

let server: FixtureServer;
beforeAll(async () => {
  server = await startFixtureServer({ slowMs: 2_000 });
});
afterAll(async () => {
  await server.close();
});

let n = 0;
const file = (rel: string): SourceInput => ({
  id: `in-${(++n).toString(16).padStart(8, '0')}`,
  kind: 'file',
  origin: 'drop',
  path: path.join(FIXTURES, rel),
});
const url = (u: string): SourceInput => ({
  id: `in-${(++n).toString(16).padStart(8, '0')}`,
  kind: 'url',
  origin: 'url-field',
  url: u,
});

interface App {
  queue: JobQueue;
  lib: FsLibrary;
  fake: FakeProvider;
  rt: PipelineRuntime;
  userData: string;
  clock: FakeClock;
  events: JobSnapshot[];
  finished(id: string): Promise<Job>;
}

/** A "launch": registry + settings + Keychain + library + pipeline over (possibly existing) dirs. */
async function launch(o: { script?: FakeScript; from?: App; tasks?: (t: LlmTasks) => LlmTasks } = {}): Promise<App> {
  const userData = o.from?.userData ?? (await tmpLibrary()).userData;
  const clock = o.from?.clock ?? new FakeClock('2026-04-01T09:00:00.000Z');
  const settings: Settings = { ...DEFAULTS };
  const fake = new FakeProvider(o.script ?? script());
  const registry = new Registry({ edition: 'public', getSettings: () => settings });
  registerPublicCapabilities(registry);
  registry.registerLLMProvider('claude', () => fake);
  registry.freeze();
  const keyStore = new MemoryKeyStore({ 'llm.claude.apiKey': ['sk', 'ant', 'integration', 'fake'].join('-') });
  const lib = await openLibrary({
    rootInput: { isPackaged: false, repoRoot: '/nonexistent-repo', userData, env: process.env },
    appVersion: '0.0.0-test',
    clock,
    ids: new SeededIdSource(3),
    processLock: false,
  });
  const fetcher: Fetcher = createFetcher({
    transport: nodeTransport(),
    headers: requestHeaders('Mozilla/5.0 TestChromium ELI5Learner/0.0.0', ['en-US']),
    readability: inProcessReadability,
    lookup: async () => ['203.0.113.10'], // TEST-NET-3: "public" for the private-address guard
    politeness: new Politeness({ hostIntervalMs: 0 }),
    sleep: async () => {},
  });
  const services = fakeServices();
  let jobSeq = o.from ? 100 : 0;
  let docSeq = o.from ? 100 : 0;
  const rt = createPipelineDeps({
    registry,
    settings: () => settings,
    keyStore,
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
        jobId: () => `01JINT${String(++jobSeq).padStart(6, '0')}`,
        docId: () => `00000000-0000-4000-8000-${String(++docSeq).padStart(12, '0')}`,
      },
      sectionIds: new SeededIdSource(9),
      docRuntime: runtime(),
      sleep: async () => {},
    },
  });
  if (o.tasks) rt.deps.tasks = o.tasks(rt.deps.tasks);
  const queue = new JobQueue(rt.deps);
  const events: JobSnapshot[] = [];
  queue.on('changed', (s) => events.push(s));
  await queue.init();
  const finished = (id: string): Promise<Job> =>
    new Promise((resolve) => {
      const check = (): boolean => {
        const j = queue.get(id);
        if (!j || !isTerminal(j.status)) return false;
        void queue.settled(id).then(() => resolve(queue.get(id) ?? j));
        return true;
      };
      if (check()) return;
      const off = queue.on('changed', () => {
        if (check()) off();
      });
    });
  return { queue, lib, fake, rt, userData, clock, events, finished };
}

async function savedDoc(app: App, slug: string): Promise<{ html: string; meta: DocumentMeta }> {
  const html = await readFile(app.lib.docPath(slug), 'utf8');
  const meta = JSON.parse(await readFile(app.lib.docPath(slug, 'meta.json'), 'utf8')) as DocumentMeta;
  return { html, meta };
}

const opts = { clarifyingInput: 'Explain it for a new operations lead', glossary: true };

describe('pipeline integration (06 acceptance, 13 §2)', () => {
  it('markdown + docx + a fetched HTML page become one valid document with correct catalog and meta', async () => {
    const app = await launch();
    const { jobId } = await app.queue.start({
      inputs: [file('sources/text/notes.md'), file('sources/docx/policy-memo.docx'), url(server.url('/article/'))],
      options: opts,
    });
    const job = await app.finished(jobId);
    expect(job.failure).toBeUndefined();
    expect(job.status).toBe('done');
    const slug = job.result?.topicSlug ?? '';
    const { html, meta } = await savedDoc(app, slug);
    expect(validateDocument(html, meta).errors).toEqual([]);
    expect(meta).toMatchObject({
      schemaVersion: 1,
      id: job.result?.docId,
      topicSlug: slug,
      title: job.result?.title,
      jobId,
      edition: 'public',
      clarifyingInput: opts.clarifyingInput,
      glossaryEnabled: true,
      summarySource: 'llm',
      sourcesSkipped: [],
      warnings: [],
      merges: [],
      retiredIds: [],
      publications: [],
      generation: { provider: 'claude', model: 'fake-model' },
      createdAt: '2026-04-01T09:00:00.000Z',
    });
    expect(meta.sourcesUsed.map((s) => [s.ref, s.kind])).toEqual([
      ['notes.md', 'file'],
      ['policy-memo.docx', 'file'],
      [server.url('/article/'), 'url'],
    ]);
    expect(meta.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5']);
    // The model saw all three sources, delimited (02 §9).
    const indepthCall = app.fake.calls.find((c) => c.taskId === 'in-depth');
    const prompt = indepthCall?.messages[0]?.text ?? '';
    expect(prompt).toContain('<source ref="notes.md" format="markdown"');
    expect(prompt).toContain('<source ref="policy-memo.docx" format="docx"');
    expect(prompt).toContain(`<source ref="${server.url('/article/')}" format="html"`);
    // catalog.json on disk matches meta.json.
    const catalog = JSON.parse(await readFile(path.join(app.lib.root, CATALOG_FILE), 'utf8')) as {
      entries: { id: string; topicSlug: string; title: string; summary: string; tabCount: number }[];
    };
    expect(catalog.entries).toEqual([
      expect.objectContaining({ id: meta.id, topicSlug: slug, title: meta.title, summary: meta.summary, tabCount: 2 }),
    ]);
    // References list every source; staging is gone.
    expect(html).toContain('notes.md');
    expect(html).toContain('policy-memo.docx');
    expect(await exists(path.join(app.userData, 'jobs', jobId))).toBe(false);
    expect(await readdir(path.join(app.lib.root, '.staging'))).toEqual([]);
    app.rt.dispose();
  });

  it('partial failure: a missing file is skipped and listed; the document is still saved', async () => {
    const app = await launch();
    const { jobId } = await app.queue.start({
      inputs: [file('sources/text/notes.md'), file('sources/text/missing-quarterly-plan.txt')],
      options: opts,
    });
    const job = await app.finished(jobId);
    expect(job.status).toBe('done');
    expect(app.events.filter((e) => e.id === jobId).at(-1)?.statusLine).toMatch(/ · 1 source\(s\) skipped$/);
    const { html, meta } = await savedDoc(app, job.result?.topicSlug ?? '');
    expect(validateDocument(html, meta).errors).toEqual([]);
    expect(meta.sourcesSkipped).toEqual([
      expect.objectContaining({ ref: 'missing-quarterly-plan.txt', code: 'not-found' }),
    ]);
    expect(meta.warnings).toEqual([expect.objectContaining({ kind: 'source-skipped' })]);
    expect(html).toContain('missing-quarterly-plan.txt');
    app.rt.dispose();
  });

  it('total failure: no usable content ends NO_USABLE_CONTENT with no Library entry', async () => {
    const app = await launch();
    const { jobId } = await app.queue.start({
      inputs: [file('sources/text/empty.txt'), url(server.url('/login-wall/'))],
      options: opts,
    });
    const job = await app.finished(jobId);
    expect(job.failure?.code).toBe('NO_USABLE_CONTENT');
    expect(job.skipped.map((s) => s.code).sort()).toEqual(['empty', 'login-required']);
    expect(app.lib.list()).toEqual([]);
    expect(app.fake.calls).toEqual([]);
    app.rt.dispose();
  });

  it('cancellation ends Cancelled and leaves no folder, catalog entry or staging', async () => {
    const app = await launch({ script: script({ latencyMs: 60_000 }) });
    const { jobId } = await app.queue.start({ inputs: [file('sources/docx/policy-memo.docx')], options: opts });
    await new Promise<void>((resolve) => {
      const off = app.queue.on('changed', (s) => {
        if (s.id === jobId && s.status === 'generating') {
          off();
          resolve();
        }
      });
    });
    await app.queue.cancel(jobId);
    const job = await app.finished(jobId);
    expect(job.failure?.code).toBe('CANCELLED');
    expect(app.lib.list()).toEqual([]);
    expect(await exists(path.join(app.userData, 'jobs', jobId))).toBe(false);
    expect(await readdir(path.join(app.lib.root, '.staging'))).toEqual([]);
    expect((await readdir(app.lib.root)).filter((d) => !d.startsWith('.') && d !== CATALOG_FILE)).toEqual([]);
    app.rt.dispose();
  });

  it('crash-resume from a checkpoint: relaunch finishes without redoing reading, extraction or finished steps', async () => {
    const a = await launch({ tasks: (t) => ({ ...t, summarize: () => new Promise(() => {}) }) });
    const { jobId } = await a.queue.start({
      inputs: [file('sources/text/notes.md'), url(server.url('/article/'))],
      options: opts,
    });
    await new Promise<void>((resolve) => {
      const off = a.queue.on('changed', (s) => {
        if (s.id === jobId && s.statusLine === 'Generating document (finishing up)') {
          off();
          resolve();
        }
      });
    });
    const hitsBefore = server.hits.length;
    await a.queue.close(); // the process dies here; the record keeps its checkpoint
    a.rt.dispose();

    const b = await launch({ from: a });
    const job = await b.finished(jobId);
    expect(job.status).toBe('done');
    expect(job.attempt).toBe(2);
    expect(b.events.find((e) => e.id === jobId)?.statusLine).toBe('Resuming');
    expect(b.fake.calls.map((c) => c.taskId)).toEqual(['summary']);
    expect(server.hits.length).toBe(hitsBefore); // the URL was not refetched
    expect(b.lib.list()).toHaveLength(1);
    const { html, meta } = await savedDoc(b, job.result?.topicSlug ?? '');
    expect(validateDocument(html, meta).errors).toEqual([]);
    expect(meta.jobId).toBe(jobId);
    b.rt.dispose();
  });
});
