// Production wiring for the pipeline (06 §2): every dependency comes from the frozen registry, the
// settings store, the Keychain, the library, and injected Electron services, so Node tests can pass fakes.
import path from 'node:path';
import type { Settings } from '../config';
import { account, type KeyStore } from '../config';
import {
  createNativeImageNormalizer,
  defaultDocTheme,
  passThroughNormalizer,
  resolveDocTheme,
  type NativeImageModule,
} from '../document';
import type { CapabilityRegistry } from '../editions';
import {
  ExtractWorkerHost,
  PdfRenderWindow,
  utilityProcessFork,
  type ImageNormalizer,
  type PdfPageRenderer,
} from '../extract';
import { endFetchJob as defaultEndFetchJob, fetchUrl as defaultFetchUrl } from '../fetch';
import { createNativeImageReencoder, createTasks, PromptCatalogue, SkillLibrary, type LlmTasks } from '../llm';
import { collectPhotoSlots, createNativePhotoOps, isStockStub, resolvePhotos } from '../photos';
import { log as defaultLog, type Logger } from '../security';
import { inProcessExtractRunner } from './runner';
import { parseThemeDarkTokens, parseThemeTokens } from './theme';
import type { ExtractRunner, JobId, PipelineDeps, PipelineLibrary, PipelinePhotos } from './types';

/** The Electron surface the pipeline needs; injected so Node tests can pass fakes. */
export interface PipelineElectron {
  utilityProcess: Parameters<typeof utilityProcessFork>[0];
  BrowserWindow: typeof Electron.BrowserWindow;
  MessageChannelMain: typeof Electron.MessageChannelMain;
  session: typeof Electron.session;
  nativeImage: NativeImageModule;
  powerSaveBlocker: { start(type: 'prevent-app-suspension'): number; stop(id: number): void };
}

export interface CreatePipelineDepsOptions {
  /** The frozen capability registry (01 §6.3). */
  registry: CapabilityRegistry;
  /** Current settings (SettingsStore.get). */
  settings: () => Settings;
  keyStore: Pick<KeyStore, 'has'>;
  /** FsLibrary; `runMergeCheck` is used for the post-save trigger when present (06 §10). */
  library: PipelineLibrary & { runMergeCheck?(docId: string): Promise<unknown> };
  /** Electron app.getPath('userData'). */
  userData: string;
  /** config resourcePath(): resources/ in dev, process.resourcesPath packaged (01 §8.3). */
  resourcePath: (rel: string) => string;
  /** Bundled extract worker entry: path.join(import.meta.dirname, 'extract-worker.js') (04 §10.4). */
  workerEntry: string;
  /** Directory holding pdf.mjs + pdf.worker.mjs for the render window (04 §6.3). */
  pdfjsDir?: string;
  /** Packaged builds: ELI5_PDFJS_WORKER_SRC for the worker (04 acceptance). */
  pdfjsWorkerSrc?: string;
  /** Enterprise prompt override directories, highest priority first (HOOK-LLM-02). */
  promptOverrideDirs?: readonly string[];
  /** Default `<userData>/skills` (02 §11). */
  userSkillsDir?: string;
  watchSkills?: boolean;
  /** Absent in Node: extraction runs in-process with `extractServices`. */
  electron?: PipelineElectron;
  /** Node-only extraction services when `electron` is absent. */
  extractServices?: { renderPdfPages: PdfPageRenderer; normalizeImage: ImageNormalizer };
  /** Security hook for the render window (12 §7), e.g. registerSurface. */
  prepareRenderWebContents?: (wc: Electron.WebContents) => void;
  fetchUrl?: PipelineDeps['fetchUrl'];
  endFetchJob?: PipelineDeps['endFetchJob'];
  /** false when the fake LLM is active (ELI5_LLM_FAKE): no Keychain key is required. */
  requireApiKey?: boolean;
  log?: Logger;
  /** Anything else (clock, ids, sectionRunner, docRuntime...) passes straight through. */
  overrides?: Partial<PipelineDeps>;
}

export interface PipelineRuntime {
  deps: PipelineDeps;
  prompts: PromptCatalogue;
  skills: SkillLibrary;
  tasks: LlmTasks;
  /** Stops the skills watcher. */
  dispose(): void;
}

/** Assembles PipelineDeps; also returns the prompts, skills and tasks that 08 and 09 share. */
export function createPipelineDeps(o: CreatePipelineDepsOptions): PipelineRuntime {
  const log = o.log ?? defaultLog;
  const reg = o.registry;
  const prompts = PromptCatalogue.load([...(o.promptOverrideDirs ?? []), o.resourcePath('prompts')]);
  const skills = new SkillLibrary([o.userSkillsDir ?? path.join(o.userData, 'skills'), o.resourcePath('skills')]);
  // Names only (no content): lets the packaged smoke check skills resolved from resourcesPath (01 §8.3).
  const skillNames = skills
    .list()
    .map((s) => s.name)
    .sort();
  log.info('pipeline.skills-loaded', { count: skillNames.length, kind: skillNames.join(',').slice(0, 200) });
  if (o.watchSkills !== false) skills.watch();
  const tasks = createTasks({
    provider: () => reg.llm(),
    prompts,
    skills,
    policy: () => reg.promptPolicy(),
    settings: o.settings,
    ...(o.electron ? { reencodeImage: createNativeImageReencoder() } : {}),
  });

  const createExtractRunner = ((): ((jobId: JobId) => ExtractRunner) => {
    const electron = o.electron;
    if (electron) {
      const env: Record<string, string> = o.pdfjsWorkerSrc ? { ELI5_PDFJS_WORKER_SRC: o.pdfjsWorkerSrc } : {};
      const fork = utilityProcessFork(electron.utilityProcess, o.workerEntry, env);
      return () => {
        // One render window and one worker per job, torn down at job end (04 §6.3, §10.4).
        const win = new PdfRenderWindow({
          electron,
          roots: { pdfRender: o.resourcePath('pdf-render'), pdfjs: o.pdfjsDir ?? o.resourcePath('pdfjs') },
          preloadPath: o.resourcePath('pdf-render/preload.cjs'),
          ...(o.prepareRenderWebContents ? { prepareWebContents: o.prepareRenderWebContents } : {}),
          log: (msg) => log.debug('pipeline.render-window', { kind: msg.slice(0, 80) }),
        });
        const host = new ExtractWorkerHost({
          fork,
          renderPdfPages: win.renderPdfPages,
          normalizeImage: win.normalizeImage,
          log: (msg) => log.debug('pipeline.extract-worker', { kind: msg.slice(0, 80) }),
        });
        return {
          extract: (source, x) => host.extract(source, x),
          dispose: () => {
            host.dispose();
            win.destroy();
          },
        };
      };
    }
    if (o.extractServices) return inProcessExtractRunner({ ...o.extractServices });
    return () => {
      throw new Error('createPipelineDeps: no extraction backend (pass electron or extractServices)');
    };
  })();

  const docTheme: PipelineDeps['docTheme'] = () => {
    const overlay = reg.docTheme();
    const r = resolveDocTheme({
      skill: parseThemeTokens(skills.themeCss()),
      skillDark: parseThemeDarkTokens(skills.themeCss()),
      ...(overlay !== defaultDocTheme ? { overlay } : {}),
    });
    for (const w of r.warnings) log.warn('pipeline.theme-warning', { kind: w.slice(0, 80) });
    return { theme: r.theme, source: r.source };
  };

  const library = o.library;
  const runMergeCheck = library.runMergeCheck?.bind(library);
  const electron = o.electron;
  // 07 §7.4: stock photos need nativeImage for sizing, so they exist only in the app.
  const photos: PipelinePhotos | undefined = electron
    ? {
        available: () => !isStockStub(reg.stockImages()),
        resolve: (drafts, { jobId, signal }) =>
          resolvePhotos(collectPhotoSlots(drafts), {
            provider: reg.stockImages(),
            image: createNativePhotoOps(electron.nativeImage),
            pick: async (req) => {
              const r = await tasks.pickPhotos(req);
              return { picks: r.draft.picks, ...(r.prompt ? { prompt: r.prompt } : {}) };
            },
            signal,
            log,
            jobId,
          }),
      }
    : undefined;
  const deps: PipelineDeps = {
    userData: o.userData,
    edition: reg.edition,
    settings: o.settings,
    policy: reg.pipelinePolicy(),
    resolvers: () => reg.resolvers(),
    laneRouter: () => reg.laneRouter(),
    mcp: () => reg.mcp(),
    fetchUrl: o.fetchUrl ?? defaultFetchUrl,
    endFetchJob: o.endFetchJob ?? defaultEndFetchJob,
    createExtractRunner,
    tasks,
    llmInfo: () => {
      const p = reg.llm();
      return { id: p.id, model: p.model };
    },
    ...(o.requireApiKey === false
      ? {}
      : {
          hasApiKey: async () => {
            const id = o.settings().llm.provider;
            // The enterprise backend authenticates through its own broker (HOOK-LLM-01).
            if (id !== 'claude' && id !== 'openai') return true;
            return o.keyStore.has(account(id));
          },
        }),
    library,
    docTheme,
    referenceFormatter: reg.referenceFormatter(),
    normalizeImage: electron ? createNativeImageNormalizer(electron.nativeImage) : passThroughNormalizer,
    ...(photos ? { photos } : {}),
    ...(runMergeCheck ? { onMergeCheck: (docId: string) => runMergeCheck(docId) } : {}),
    ...(electron
      ? {
          powerSave: {
            start: () => electron.powerSaveBlocker.start('prevent-app-suspension'),
            stop: (id: number) => electron.powerSaveBlocker.stop(id),
          },
        }
      : {}),
    log,
    ...o.overrides,
  };
  return { deps, prompts, skills, tasks, dispose: () => skills.close() };
}
