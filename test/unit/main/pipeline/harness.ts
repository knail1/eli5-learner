/**
 * Pipeline test harness (13 §3.2): real JobQueue, stages, resolvers, extractors, document builder and
 * library over a temp userData + library root; FakeProvider behind the real task functions; a fake
 * fetchUrl; FakeClock and seeded ids. Offline and deterministic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, type Settings } from '../../../../src/main/config/schema';
import { bundledDocRuntime, passThroughNormalizer, type DocRuntime } from '../../../../src/main/document';
import type { FetchOutcome } from '../../../../src/main/fetch';
import { openLibrary, type FsLibrary, type OpenLibraryOptions } from '../../../../src/main/library';
import { createTasks, PromptCatalogue, SkillLibrary, type LlmTasks } from '../../../../src/main/llm';
import { FakeProvider, loadFakeScript, type FakeScript } from '../../../../src/main/llm/testing/fake';
import {
  defaultPipelinePolicy,
  inProcessExtractRunner,
  JobQueue,
  isTerminal,
  type Job,
  type JobDoneEvent,
  type JobSnapshot,
  type PipelineDeps,
  type PipelineLibrary,
} from '../../../../src/main/pipeline';
import {
  buildLaneRouter,
  ClipboardResolver,
  FileResolver,
  UrlResolver,
  type SourceInput,
} from '../../../../src/main/sources';
import { fakeServices } from '../../../contracts/extractor.contract';
import { FakeClock } from '../../../helpers/clock';
import { SeededIdSource } from '../../../helpers/ids';
import { STUB_RUNTIME } from '../../../fixtures/documents/runtime';
import { tmpLibrary } from '../../../helpers/tmp-library';

export const REPO = path.resolve(import.meta.dirname, '../../../..');
export const FIXTURES = path.join(REPO, 'test/fixtures');
const read = (p: string): string => fs.readFileSync(p, 'utf8');
export const prompts = PromptCatalogue.load([path.join(REPO, 'resources/prompts')]);
export const skills = new SkillLibrary([path.join(REPO, 'resources/skills')]);

export function defaultScript(over: Partial<FakeScript> = {}): FakeScript {
  return { ...loadFakeScript(path.join(FIXTURES, 'llm/default.json'), read), ...over };
}

/** The real runtime when `npm run build:runtime` has run, else the stand-in. */
export function docRuntime(): DocRuntime {
  try {
    return bundledDocRuntime();
  } catch {
    return STUB_RUNTIME;
  }
}

let seq = 0;
export const fileInput = (rel: string): SourceInput => ({
  id: `in-${(++seq).toString(16).padStart(8, '0')}`,
  kind: 'file',
  origin: 'drop',
  path: path.join(FIXTURES, rel),
});
export const urlInput = (url: string): SourceInput => ({
  id: `in-${(++seq).toString(16).padStart(8, '0')}`,
  kind: 'url',
  origin: 'url-field',
  url,
});

/** Article bodies served by the fake fetchUrl, keyed by URL. */
export const ARTICLES: Record<string, string> = {
  'https://example.com/widgets':
    '<article><h1>Widget supply</h1><p>Example Widgets Inc. forecasts demand per channel and keeps safety stock.</p></article>',
};

export function fakeFetch(articles: Record<string, string> = ARTICLES): PipelineDeps['fetchUrl'] {
  return async (url, ctx): Promise<FetchOutcome> => {
    if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const html = articles[url];
    if (html === undefined) return { kind: 'skipped', code: 'login-required', reason: 'Page required login' };
    return {
      kind: 'article',
      content: {
        requestedUrl: url,
        finalUrl: url,
        title: 'Widget supply',
        byline: null,
        siteName: null,
        lang: 'en',
        publishedTime: null,
        excerpt: null,
        contentHtml: html,
        textLength: html.length,
        via: 'http',
        imageUrls: [],
      },
    };
  };
}

/** A PipelineLibrary view of a real library whose methods can be overridden. */
export function libraryPort(lib: FsLibrary, over: Partial<PipelineLibrary> = {}): PipelineLibrary {
  return {
    get root() {
      return lib.root;
    },
    get readOnly() {
      return lib.readOnly;
    },
    allocateSlug: (t, h) => lib.allocateSlug(t, h),
    commitDocument: (r, d, m) => lib.commitDocument(r, d, m),
    stagingDir: (id) => lib.stagingDir(id),
    withDocLock: (s, fn) => lib.withDocLock(s, fn),
    docPath: (s, f) => lib.docPath(s, f),
    getEntry: (id) => lib.getEntry(id),
    reconcile: () => lib.reconcile(),
    ...over,
  };
}

export interface HarnessOptions {
  script?: FakeScript;
  settings?: Partial<Settings['pipeline']>;
  deps?: Partial<PipelineDeps>;
  tasks?: (t: LlmTasks) => LlmTasks;
  library?: Partial<OpenLibraryOptions>;
  libraryOver?: Partial<PipelineLibrary> | ((lib: FsLibrary) => Partial<PipelineLibrary>);
  /** Reuse the dirs (and clock) of an earlier harness: a relaunch after a crash. */
  from?: Harness;
  init?: boolean;
}

export interface Harness {
  queue: JobQueue;
  deps: PipelineDeps;
  fake: FakeProvider;
  lib: FsLibrary;
  userData: string;
  clock: FakeClock;
  events: JobSnapshot[];
  done: JobDoneEvent[];
  mergeChecks: string[];
  extractCalls: string[];
  power: { started: number; stopped: number };
  /** Resolves with the job once it reaches a terminal status. */
  finished(jobId: string): Promise<Job>;
  /** Resolves when the job's snapshot reaches `status`. */
  reached(jobId: string, status: JobSnapshot['status']): Promise<JobSnapshot>;
  lines(jobId: string): string[];
}

export async function harness(o: HarnessOptions = {}): Promise<Harness> {
  const dirs = o.from ? { userData: o.from.userData } : await tmpLibrary();
  const clock = o.from?.clock ?? new FakeClock('2026-03-01T00:00:00.000Z');
  const lib = await openLibrary({
    rootInput: { isPackaged: false, repoRoot: '/nonexistent-repo', userData: dirs.userData, env: process.env },
    appVersion: '0.0.0-test',
    clock,
    ids: new SeededIdSource(11),
    processLock: false,
    devChecks: true,
    ...o.library,
  });
  const fake = new FakeProvider(o.script ?? defaultScript());
  const settings: Settings = { ...DEFAULTS, pipeline: { ...DEFAULTS.pipeline, ...o.settings } };
  const base = createTasks({ provider: () => fake, prompts, skills, settings: () => settings });
  const tasks = o.tasks ? o.tasks(base) : base;
  const services = fakeServices();
  const inProcess = inProcessExtractRunner({
    renderPdfPages: services.renderPdfPages,
    normalizeImage: services.normalizeImage,
  });
  const extractCalls: string[] = [];
  const mergeChecks: string[] = [];
  const power = { started: 0, stopped: 0 };
  let jobSeq = 0;
  let docSeq = 0;
  const deps: PipelineDeps = {
    userData: dirs.userData,
    edition: 'public',
    settings: () => settings,
    policy: defaultPipelinePolicy,
    resolvers: () => [new UrlResolver(), new FileResolver(), new ClipboardResolver()],
    laneRouter: () => buildLaneRouter([]),
    fetchUrl: fakeFetch(),
    endFetchJob: async () => {},
    createExtractRunner: (jobId) => {
      const r = inProcess(jobId);
      return {
        extract: (s, x) => {
          extractCalls.push(s.ref);
          return r.extract(s, x);
        },
        dispose: () => r.dispose(),
      };
    },
    tasks,
    llmInfo: () => ({ id: fake.id, model: fake.model }),
    hasApiKey: async () => true,
    library: libraryPort(lib, typeof o.libraryOver === 'function' ? o.libraryOver(lib) : o.libraryOver),
    docTheme: () => ({
      theme: { id: 'default', version: '1', tokens: {}, footer: 'Made with ELI5 Learner' },
      source: 'default',
    }),
    normalizeImage: passThroughNormalizer,
    docRuntime: docRuntime(),
    sectionIds: new SeededIdSource(5),
    onMergeCheck: async (docId) => {
      mergeChecks.push(docId);
    },
    powerSave: {
      start: () => ++power.started,
      stop: () => {
        power.stopped++;
      },
    },
    clock,
    ids: {
      jobId: () => `01JTEST${String(++jobSeq + (o.from ? 5000 : 0)).padStart(6, '0')}`,
      docId: () => `00000000-0000-4000-8000-${String(++docSeq + (o.from ? 5000 : 0)).padStart(12, '0')}`,
    },
    sleep: async () => {},
    ...o.deps,
  };
  const queue = new JobQueue(deps);
  const events: JobSnapshot[] = [];
  const done: JobDoneEvent[] = [];
  queue.on('changed', (s) => events.push(s));
  queue.on('done', (e) => done.push(e));
  if (o.init !== false) await queue.init();

  const reached = (jobId: string, status: JobSnapshot['status']): Promise<JobSnapshot> =>
    new Promise((resolve) => {
      const hit = events.find((e) => e.id === jobId && e.status === status);
      if (hit) return resolve(hit);
      const off = queue.on('changed', (s) => {
        if (s.id === jobId && s.status === status) {
          off();
          resolve(s);
        }
      });
    });

  const finished = (jobId: string): Promise<Job> =>
    new Promise((resolve) => {
      const check = (): boolean => {
        const j = queue.get(jobId);
        if (j && isTerminal(j.status)) {
          // Wait for the run to wind down (done event, staging cleanup, merge check trigger).
          void queue.settled(jobId).then(() => resolve(queue.get(jobId) ?? j));
          return true;
        }
        return false;
      };
      if (check()) return;
      const off = queue.on('changed', () => {
        if (check()) off();
      });
    });

  return {
    queue,
    deps,
    fake,
    lib,
    userData: dirs.userData,
    clock,
    events,
    done,
    mergeChecks,
    extractCalls,
    power,
    finished,
    reached,
    lines: (jobId) => events.filter((e) => e.id === jobId).map((e) => e.statusLine),
  };
}
