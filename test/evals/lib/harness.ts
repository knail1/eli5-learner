/**
 * Headless generation pipeline for evals (13 §9.3 step 1). Same wiring as the integration harness
 * (test/integration/pipeline.test.ts): real registry, resolvers, fetch path (local fixture server),
 * extractors, tasks, document builder and library, plus 08's section-action runner, with the given
 * LLMProvider registered as the active provider and SeededIdSource for SectionIds.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { MemoryKeyStore } from '../../../src/main/config';
import type { Settings } from '../../../src/main/config/schema';
import {
  bundledDocRuntime,
  createInteractiveReading,
  parseDocument,
  type DocRuntime,
  type InteractiveReading,
  type SectionId,
} from '../../../src/main/document';
import { registerPublicCapabilities } from '../../../src/main/editions/public';
import { Registry } from '../../../src/main/editions/registry';
import { createFetcher, inProcessReadability, nodeTransport, type Fetcher } from '../../../src/main/fetch';
import { requestHeaders } from '../../../src/main/fetch/network';
import { Politeness } from '../../../src/main/fetch/politeness';
import { openLibrary, type DocumentMeta, type FsLibrary } from '../../../src/main/library';
import type { LLMProvider } from '../../../src/main/llm';
import { createPipelineDeps, isTerminal, JobQueue, type Job, type PipelineRuntime } from '../../../src/main/pipeline';
import type { MenuAction, SourceInput } from '../../../src/preload/contract';
import { fakeServices } from '../../contracts/extractor.contract';
import { STUB_RUNTIME } from '../../fixtures/documents/runtime';
import { SeededIdSource } from '../../helpers/ids';

const REPO = path.resolve(import.meta.dirname, '../../..');

const runtime = (): DocRuntime => {
  try {
    return bundledDocRuntime();
  } catch {
    return STUB_RUNTIME;
  }
};

export interface SavedDoc {
  slug: string;
  html: string;
  meta: DocumentMeta;
}

export interface SectionInfo {
  id: SectionId;
  heading: string;
  kind?: string;
}

export interface Harness {
  /** One create job; resolves when it is terminal. */
  generate(
    inputs: SourceInput[],
    options: { clarifyingInput: string; glossary: boolean },
  ): Promise<{ job: Job; doc?: SavedDoc }>;
  /** One section job on a saved document (08 §6); resolves with the job and the rewritten document. */
  sectionAction(
    slug: string,
    r: { tabKey: string; sectionId: SectionId; action: MenuAction; selectionText: string; note?: string },
  ): Promise<{ job: Job; doc: SavedDoc }>;
  sections(html: string, tabKey: string): SectionInfo[];
  read(slug: string): Promise<SavedDoc>;
  dispose(): Promise<void>;
}

export async function createHarness(o: {
  provider: LLMProvider;
  settings: Settings;
  workDir: string;
  /** Deterministic clock for library timestamps; default the wall clock. */
  now?: () => Date;
}): Promise<Harness> {
  const userData = path.join(o.workDir, 'userData');
  const libraryDir = path.join(o.workDir, 'library');
  await mkdir(userData, { recursive: true });
  await mkdir(libraryDir, { recursive: true });
  const clock = { now: o.now ?? (() => new Date()) };
  const settings = o.settings;
  const registry = new Registry({ edition: 'public', getSettings: () => settings });
  registerPublicCapabilities(registry);
  registry.registerLLMProvider(settings.llm.provider, () => o.provider);
  registry.freeze();
  const lib: FsLibrary = await openLibrary({
    rootInput: { isPackaged: false, repoRoot: '/nonexistent-repo', userData, env: { ELI5_LIBRARY_DIR: libraryDir } },
    appVersion: '0.0.0-eval',
    clock,
    ids: new SeededIdSource(3),
    processLock: false,
  });
  const fetcher: Fetcher = createFetcher({
    transport: nodeTransport(),
    headers: requestHeaders('Mozilla/5.0 EvalChromium ELI5Learner/0.0.0', ['en-US']),
    readability: inProcessReadability,
    lookup: async () => ['203.0.113.10'], // TEST-NET-3: "public" for the private-address guard (local fixture server only)
    politeness: new Politeness({ hostIntervalMs: 0 }),
    sleep: async () => {},
  });
  const services = fakeServices();
  let jobSeq = 0;
  let docSeq = 0;
  const sectionIds = new SeededIdSource(9);
  const rt: PipelineRuntime = createPipelineDeps({
    registry,
    settings: () => settings,
    keyStore: new MemoryKeyStore(),
    requireApiKey: false, // the eval provider holds its own key (ELI5_EVAL_API_KEY_*)
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
        jobId: () => `01JEVAL${String(++jobSeq).padStart(6, '0')}`,
        docId: () => `00000000-0000-4000-8000-${String(++docSeq).padStart(12, '0')}`,
      },
      sectionIds,
      docRuntime: runtime(),
    },
  });
  // 08: section actions through the same service the app uses, with a viewer that shows the target.
  let viewing: string | null = null;
  const interactive: InteractiveReading = createInteractiveReading({
    library: lib,
    tasks: rt.tasks,
    viewer: {
      currentSlug: () => viewing,
      reload: () => {},
      onLoadStart: () => () => {},
      onLoadFinish: () => () => {},
      onLoadFail: () => () => {},
    },
    sectionIds,
    clock,
    rateLimit: { max: 1_000, windowMs: 60_000 },
  });
  rt.deps.sectionRunner = interactive.runner;
  const queue = new JobQueue(rt.deps);
  interactive.attachJobs(queue);
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

  const read = async (slug: string): Promise<SavedDoc> => ({
    slug,
    html: await readFile(lib.docPath(slug), 'utf8'),
    meta: JSON.parse(await readFile(lib.docPath(slug, 'meta.json'), 'utf8')) as DocumentMeta,
  });

  return {
    async generate(inputs, options) {
      const { jobId } = await queue.start({ inputs, options });
      const job = await finished(jobId);
      const slug = job.status === 'done' ? job.result?.topicSlug : undefined;
      return slug ? { job, doc: await read(slug) } : { job };
    },
    async sectionAction(slug, r) {
      viewing = slug;
      const req = {
        slug,
        tabKey: r.tabKey,
        sectionId: r.sectionId,
        selectionText: r.selectionText,
        ...(r.note ? { note: r.note } : {}),
      };
      const { jobId } =
        r.action === 'eli5-tab'
          ? await interactive.actions.createSectionEli5(req)
          : await interactive.actions.regenerateSection({ ...req, action: r.action });
      const job = await finished(jobId);
      return { job, doc: await read(slug) };
    },
    sections(html, tabKey) {
      const tab = parseDocument(html).model.tabs.find((t) => t.key === tabKey);
      return (tab?.sections ?? []).map((s) => ({ id: s.id, heading: s.heading, ...(s.kind ? { kind: s.kind } : {}) }));
    },
    read,
    async dispose() {
      await queue.close();
      interactive.dispose();
      rt.dispose();
    },
  };
}
