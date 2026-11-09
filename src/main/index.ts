import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  BrowserWindow,
  MessageChannelMain,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  session,
  shell as electronShell,
  utilityProcess,
} from 'electron';
import { IPC, type IpcChannel, type UiRoute } from '../preload/contract';
import { effectiveModel } from './config';
import { SettingsStore } from './config/store';
import { createKeyStore } from './config/keystore';
import {
  initPaths,
  migrateLegacyUserData,
  promptsPath,
  resolvePromptSet,
  resourcePath,
  resolveUserDataDir,
} from './config/paths';
import { Registry } from './editions/registry';
import { registerPublicCapabilities } from './editions/public';
import { loadOverlay } from './editions/load-overlay';
import { edition } from './editions/types';
import {
  failHeadlessRun,
  prepareRealRun,
  realRunRequested,
  rebuildPlanInputs,
  startRealRun,
  startRebuildRun,
  type RealRunSession,
} from './devtools';
import { createElectronViewerPort, createInteractiveReading, parseDocument } from './document';
import { PDF_RENDER_SCHEME_PRIVILEGES } from './extract';
import { configureFetch } from './fetch';
import {
  createQuitHandler,
  openInViewer,
  providerKeyPresent,
  registerIpc,
  snapshotClipboard,
  type IpcServices,
  type QuitStep,
} from './ipc';
import { JobQueue, createPipelineDeps, type SectionRunner } from './pipeline';
import { sweepStaleDrafts } from './sources/drafts';
import { mintInputId, sniffFile, type SourceInput } from './sources';
import {
  DOC_SCHEME,
  createDocProtocolHandler,
  createMergeSuggestions,
  gitCheckIgnored,
  installDocProtocol,
  openLibrary,
} from './library';
import { configureLlmRuntime, createLlmFetch, inputBudget, limitsFor, retryPolicyFromPipeline } from './llm';
import { createPublishService } from './publish';
import { hardenApp } from './security/harden';
import { RotatingFileSink, createLogger, installLogger, log } from './security/log';
import { registerSurface, safeOpenExternal } from './security';
import {
  FOCUS_POLL_GAP_MS,
  GoogleOAuth,
  InboxLedger,
  SyncEngine,
  SyncInbox,
  SyncStateStore,
  checkoutOutcomeOf,
  createSyncService,
  openSyncStore,
  syncActive,
} from './sync';
import {
  APP_SCHEME_PRIVILEGES,
  createMainWindow,
  createNotificationControls,
  createNotifier,
  createTray,
  findInDocument,
  focusViewer,
  initShell,
  isAppUrl,
  mainWebContents,
  notifyOnCreateDone,
  observeAppEvent,
  seedTray,
  setViewerBounds,
  setViewerVisible,
  settingsServices,
  shell,
  showMainWindow,
  stopFindInDocument,
  VIEWER_PARTITION,
  viewerWebContents,
  type Notifier,
} from './shell';

// Privileges must be registered at module load, before ready (12 §7.7).
protocol.registerSchemesAsPrivileged([
  {
    scheme: DOC_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: false,
      bypassCSP: false,
      stream: false,
    },
  },
  // pdf-render window pages and pdf.js (04 §6.3, 01 §2).
  PDF_RENDER_SCHEME_PRIVILEGES,
  // The app renderer in builds: file:// inside app.asar is refused with the fuse off (12 §7.8).
  APP_SCHEME_PRIVILEGES,
]);

// Builds before productName "ELI5 Learner" kept their data under the package name; move it once,
// before anything opens userData (12 §4.1). Dev and test runs use their own folder and skip this.
const legacyMigration = app.isPackaged
  ? migrateLegacyUserData({
      appData: app.getPath('appData'),
      target: app.getPath('userData'),
      legacyNames: ['eli5-learner'],
      isAlive: (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      hostname: os.hostname(),
    })
  : undefined;

// Dev and test runs never touch the real profile (12 §4.1).
app.setPath(
  'userData',
  resolveUserDataDir({ isPackaged: app.isPackaged, defaultDir: app.getPath('userData'), env: process.env }),
);

hardenApp();

/** safeOpenExternal rate-limit bucket for opens that main starts itself (11 §14.6, 12 §7.5). */
const MAIN_SENDER_ID = -1;
/** config/electron-builder.yml appId; macOS Notification settings deep link (11 §14.7). */
const APP_BUNDLE_ID = 'io.github.eli5-learner';

/** Section headings of a document's in-depth tab, for the sync manifest (16 §4.4); [] when it does not parse. */
function documentHeadings(html: Uint8Array): string[] {
  try {
    const { model } = parseDocument(Buffer.from(html.buffer, html.byteOffset, html.byteLength).toString('utf8'));
    const tab = model.tabs.find((t) => t.kind === 'indepth');
    return (tab?.sections ?? []).filter((x) => x.kind === 'content').map((x) => x.heading);
  } catch {
    return [];
  }
}

/** The name this Mac shows to the phone (16 §4.3): the host name without `.local`. */
function deviceName(): string {
  return (
    os
      .hostname()
      .replace(/\.local$/i, '')
      .slice(0, 100) || 'Mac'
  );
}

/** Bootstrap order (01 §6.3). */
/** The armed headless run, so a bootstrap failure after prepareRealRun can release its ledger lock. */
let headlessSession: RealRunSession | undefined;

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData');
  installLogger(
    createLogger({
      sink: new RotatingFileSink(path.join(userData, 'logs', 'main.log')),
      strictFields: !app.isPackaged,
      appRoot: app.getAppPath(),
    }),
  );
  log.info('app.start', { kind: edition, status: app.isPackaged ? 'packaged' : 'dev' });
  if (legacyMigration && legacyMigration.status !== 'nothing-to-migrate') {
    log.info('app.user-data-migration', { status: legacyMigration.status });
  }
  initPaths({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });

  const fakeLlm = __ELI5_TEST__ && process.env.ELI5_LLM_FAKE === '1';

  // 1. settings
  // The provider check needs the registry, which needs settings; resolve the cycle lazily.
  const late: { registry?: Registry } = {};
  const settings = new SettingsStore({
    dir: userData,
    onIssue: (event, f) => log.warn(event, f),
    isProviderAvailable: (id) => late.registry?.info().llmProviders.find((p) => p.id === id)?.available ?? false,
  });
  await settings.load();
  const keyStore = createKeyStore({ isPackaged: app.isPackaged, env: process.env });

  // 2. public capabilities
  const registry = new Registry({
    edition,
    getSettings: () => settings.get(),
    onReplace: (kind, id) => log.info('registry.replaced', { kind, capability: id }),
    appVersion: app.getVersion(),
  });
  late.registry = registry;
  registerPublicCapabilities(registry);
  // 3. overlay (enterprise only; fatal on failure)
  await loadOverlay(registry);
  // 4. re-validate settings against the extended schema
  await settings.applyExtension(registry.settingsExtension());
  // Test builds with ELI5_LLM_FAKE=1: the fake goes in after the overlay and the re-validated
  // settings and before the freeze, so it registers under the final provider name and replaces
  // whatever the overlay put there (13 §6.1). Packaged and dev builds never reach this.
  if (fakeLlm) {
    const { FakeProvider, loadFakeScript } = await import('./llm/testing/fake');
    const scriptPath =
      process.env.ELI5_LLM_FAKE_SCRIPT ?? path.join(app.getAppPath(), 'test/fixtures/llm/default.json');
    const read = (p: string): string => fs.readFileSync(p, 'utf8');
    const script = fs.existsSync(scriptPath) ? loadFakeScript(scriptPath, read) : { responses: {} };
    const provider = settings.get().llm.provider;
    // e2e reads every recorded request from main (13 §8.2 E2: "Fake recorded one image").
    const made: InstanceType<typeof FakeProvider>[] = [];
    (globalThis as { __eli5FakeProviders?: unknown }).__eli5FakeProviders = made;
    registry.registerLLMProvider(provider, () => {
      const fake = new FakeProvider(script, { id: provider, readFile: read });
      made.push(fake);
      return fake;
    });
  }

  // Test builds with ELI5_SYNC_FAKE=1 (13 §6.1): an in-memory store under the shipped store id and a
  // stand-in for the browser and Google's token endpoints, so e2e drives Settings > Sync offline.
  let syncFake: { openExternal(u: string): Promise<boolean>; fetch: typeof fetch } | undefined;
  if (__ELI5_TEST__ && process.env.ELI5_SYNC_FAKE === '1') {
    const { MemorySyncStore, fakeGoogle } = await import('./sync/testing');
    const store = new MemorySyncStore();
    (globalThis as { __eli5FakeSyncStore?: unknown }).__eli5FakeSyncStore = store;
    registry.registerSyncStore(store.id, () => store);
    syncFake = fakeGoogle();
  }

  // Dev-only budget-capped real run: wraps the LLM providers before the freeze; inert unless
  // ELI5_REAL_RUN_URLS or ELI5_REAL_RUN_REBUILD is set, and never reachable in packaged builds
  // (scripts/real-run/README.md). A rebuild with ELI5_LLM_FAKE=1 is a rehearsal (test builds only).
  const realRun = app.isPackaged
    ? undefined
    : prepareRealRun({ env: process.env, isPackaged: app.isPackaged, testBuild: __ELI5_TEST__, userData, registry });
  headlessSession = realRun;
  // 5. freeze
  registry.freeze();

  // Process-wide wiring that the frozen registry feeds (02 §4, 05 §4.2).
  const network = registry.networkConfigurator();
  configureFetch({ configureSession: network, loginSignatures: registry.loginSignatures() });
  const pipelinePolicy = registry.pipelinePolicy();
  configureLlmRuntime({
    keys: keyStore,
    fetch: await createLlmFetch(network),
    retry: retryPolicyFromPipeline(pipelinePolicy),
    timeouts: pipelinePolicy.llmTimeoutOverride,
  });

  // Drafts live only in the window's memory, so any draft from before this launch is an orphan
  // (03 §6.1 step 6); the live draft is created after launch and never matches. Never rejects.
  void sweepStaleDrafts(userData, { before: Date.now() - process.uptime() * 1000 });

  // Library root, process lock, catalog and reconcile (09 §3.1, §7, §8.4).
  const library = await openLibrary({
    rootInput: { isPackaged: app.isPackaged, repoRoot: app.getAppPath(), userData, env: process.env },
    policy: registry.libraryPolicy(),
    appVersion: app.getVersion(),
    devChecks: !app.isPackaged,
    processLock: {
      startedAt: new Date(Date.now() - process.uptime() * 1000),
      executableName: path.basename(process.execPath),
    },
    checkIgnored: app.isPackaged ? undefined : gitCheckIgnored,
  });
  // One ordered quit (06 §4.3, §9.1): later steps are prepended as the pipeline comes up.
  const quitSteps: QuitStep[] = [{ name: 'library', run: () => library.close() }];
  let exitCode = 0;
  app.on('before-quit', createQuitHandler({ steps: quitSteps, exit: () => app.exit(exitCode) }));
  // eli5doc:// is served on the viewer session only (12 §7.7 step 2).
  installDocProtocol(
    session.fromPartition(VIEWER_PARTITION),
    createDocProtocolHandler({
      root: library.root,
      isCatalogued: (slug) => library.hasSlug(slug),
      helpRoot: resourcePath('help'),
    }),
  );

  // Every push to the app renderer also feeds the Tray (11 §4.2): recents and "Quit (N jobs will resume)".
  const sendToApp = (channel: IpcChannel, payload: unknown): void => {
    observeAppEvent(channel, payload);
    mainWebContents()?.send(channel, payload);
  };
  // M→D pushes (08 §4.1): only ever to the viewer.
  const sendToViewer = (channel: IpcChannel, payload: unknown): void => viewerWebContents()?.send(channel, payload);

  // ---------------------------------------------------------------------------------------------
  // M3 feature slots (dependency injection points). Each feature builds its service in its own
  // module and is plugged in below; an empty slot's channels answer "Not implemented yet"
  // (ipc/services.ts), so a missing service never stops the app.
  //   sectionRunner  08  src/main/document/interactive/   (SectionRunner, 06 §8.2)
  //   services       08  sectionActions   SectionActions      src/main/document/interactive/
  //                  09  suggestions      MergeSuggestions    src/main/library/merge/
  //                  10  publish          PublishService      src/main/publish/service.ts
  //                  11  notifications    NotificationControls src/main/shell/notifications.ts
  //                  11  folders          FolderChooser       src/main/shell/choose-folder.ts
  //                  11  help             HelpLinks           src/main/shell/menu-help.ts
  //                  (folders and help are plugged: settingsServices(), src/main/shell/window.ts)
  //   notifier       11  Notifier (createNotifier)             src/main/shell/notifications.ts
  // ---------------------------------------------------------------------------------------------
  const m3: { sectionRunner?: SectionRunner; services: Partial<IpcServices>; notifier?: Notifier } = {
    services: {},
  };

  // Generation pipeline (06 §2). Fake-LLM test runs need no Keychain key (13 §8.1).
  const pipeline = createPipelineDeps({
    registry,
    settings: () => settings.get(),
    keyStore,
    library,
    userData,
    resourcePath,
    // 02 §9: config/prompts (dev) or <Resources>/prompts; the set from ELI5_PROMPT_SET (dev only)
    // or settings llm.promptSet; HOOK-LLM-02 override files win over both.
    promptsRoot: promptsPath(),
    promptSet: resolvePromptSet(settings.get(), process.env, app.isPackaged),
    promptOverrideDirs: [registry.promptPolicy().overridesDir].filter((d): d is string => !!d),
    workerEntry: path.join(import.meta.dirname, 'extract-worker.js'),
    pdfjsDir: app.isPackaged
      ? path.join(process.resourcesPath, 'pdfjs')
      : path.join(app.getAppPath(), 'node_modules/pdfjs-dist/build'),
    ...(app.isPackaged
      ? { pdfjsWorkerSrc: pathToFileURL(path.join(process.resourcesPath, 'pdfjs/pdf.worker.mjs')).href }
      : {}),
    electron: { utilityProcess, BrowserWindow, MessageChannelMain, session, nativeImage, powerSaveBlocker },
    prepareRenderWebContents: (wc) => registerSurface(wc, 'other', (u) => u.protocol === 'eli5res:'),
    requireApiKey: !fakeLlm,
  });
  const apiKeyReady = fakeLlm ? async () => true : () => providerKeyPresent(settings.get().llm.provider, keyStore);
  // 08: section actions and their runner. The 60% section budget (08 §6.2 step 5) is read from the
  // live model settings with no system prompt counted (02 §8).
  const viewerPort = createElectronViewerPort(viewerWebContents);
  const interactive = createInteractiveReading({
    library,
    tasks: pipeline.tasks,
    viewer: viewerPort,
    hasApiKey: apiKeyReady,
    sectionIds: pipeline.deps.sectionIds,
    inputBudgetTokens: () => {
      const s = settings.get();
      return inputBudget(limitsFor(s.llm.provider, effectiveModel(s)), 0, s.llm.maxOutputTokens);
    },
    log,
  });
  m3.sectionRunner = interactive.runner;
  m3.services.sectionActions = interactive.actions;
  // 09 §4.1, 08 §6.7: one-level undo/redo; the Edit menu items act on the document in the viewer.
  m3.services.docHistory = interactive.history;
  const docHistoryFromMenu = (dir: 'undo' | 'redo'): void => {
    const slug = viewerPort.currentSlug();
    if (!slug) return;
    interactive.history[dir](slug).catch((err: unknown) =>
      log.info('document.history-refused', { slug, kind: dir, code: (err as { code?: string }).code ?? 'unknown' }),
    );
  };
  // 09 §10: merge suggestions. Created after reconcile; attaching makes library.runMergeCheck live.
  const merge = createMergeSuggestions({
    library,
    judge: (summary, candidates, signal) => pipeline.tasks.matchMerge(summary, candidates, signal),
    // 09 §10.3: Merge in weaves the new document in with one `merge-weave` call.
    planner: async (input) => {
      const r = await pipeline.tasks.weaveMerge(input);
      log.info('merge.weave-usage', { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens });
      return { draft: r.draft, prompt: r.prompt };
    },
    eligibility: registry.mergeEligibility(),
    retentionDays: registry.libraryPolicy().resolvedSuggestionRetentionDays,
  });
  m3.services.suggestions = merge.service;
  // An accept rewrites the target: the engine already pushes eli5:doc:updated; the viewer reloads
  // and scrolls to the marker when it shows the target (09 §10.6 step 12, 08 §7.4).
  merge.service.onDocUpdated((e) => interactive.refreshViewer(e));
  const jobs = new JobQueue({
    ...pipeline.deps,
    ...(m3.sectionRunner ? { sectionRunner: m3.sectionRunner } : {}),
  });
  jobs.on('done', (e) => log.info('pipeline.job-done', { jobId: e.jobId, kind: e.kind }));
  // "Documents generated at once" applies immediately: waiting jobs that now fit start (06 §4.1).
  settings.onChanged((_s, changed) => {
    if (changed.includes('pipeline.maxConcurrentJobs')) jobs.slotsChanged();
  });
  // 11 §14.2: one "Document ready" per finished create job, through the notifier slot.
  jobs.on(
    'done',
    notifyOnCreateDone(() => m3.notifier),
  );
  // Crash recovery (06 §9.4) finishes before IPC exists, so the renderer's first eli5:jobs:list
  // already sees resumed jobs. A failure here must not stop the app from opening the Library.
  // A headless real run or rebuild holds leftover jobs, so only the driver's own jobs spend (design §5).
  await jobs
    .init({ holdLeftovers: realRun !== undefined })
    .catch((err: unknown) => log.error('pipeline.init-failed', {}, err));
  interactive.attachJobs(jobs);
  // Running and queued jobs are persisted and resume on the next launch (06 §4.3, 11 §3.2): the
  // queue flushes before the Library lock is released and the process exits.
  quitSteps.unshift(
    { name: 'jobs', run: () => jobs.close() },
    { name: 'pipeline', run: () => pipeline.dispose() },
    { name: 'merge', run: () => merge.dispose() },
  );
  quitSteps.unshift({ name: 'interactive', run: () => interactive.dispose() });

  // Headless real run: no IPC, windows or Tray; the driver prints a summary and quits.
  const quitRealRun = (code: number): void => {
    exitCode = code;
    app.quit();
  };
  if (realRun?.config.rebuild) {
    // Design §5: rebuild existing documents as new versions; the key is read in-process (D23).
    startRebuildRun({
      session: realRun,
      jobs,
      library,
      provider: () => registry.llm(),
      promptSet: pipeline.prompts.set,
      keyPresent: () => providerKeyPresent(settings.get().llm.provider, keyStore),
      planInputs: rebuildPlanInputs({
        prompts: pipeline.prompts,
        skills: pipeline.skills,
        contextTokens: () => registry.llm().limits.contextTokens,
        maxOutputSetting: () => settings.get().llm.maxOutputTokens,
      }),
      stockPhotos: settings.get().images.stockPhotos,
      quit: quitRealRun,
    }).catch((err: unknown) => failHeadlessRun({ err, session: realRun, exit: quitRealRun }));
    return;
  }
  if (realRun) {
    startRealRun({
      session: realRun,
      jobs,
      library,
      provider: () => registry.llm(),
      glossary: settings.get().glossary.defaultOn,
      quit: quitRealRun,
    }).catch((err: unknown) => failHeadlessRun({ err, session: realRun, exit: quitRealRun }));
    return;
  }

  // v2 (16 §8): optional personal sync, created after the library. While `sync.enabled` is false
  // (the default) or the policy does not allow it (HOOK-SYNC-01), nothing is built, read or sent.
  const syncOAuth = new GoogleOAuth({
    keys: keyStore,
    enabled: () => syncActive(registry, settings.get()),
    clientSource: () => registry.syncPolicy().clientSource,
    openExternal: syncFake?.openExternal ?? ((u) => safeOpenExternal(u, MAIN_SENDER_ID)),
    isPackaged: app.isPackaged,
    env: process.env,
    onSignedOut: () => sync.refresh(),
    ...(syncFake ? { fetch: syncFake.fetch } : {}),
  });
  const syncDir = path.join(userData, 'sync');
  const syncState = new SyncStateStore({ dir: syncDir });
  // 16 §5.3: the phone inbox. Jobs reach the pipeline only through `startFromMain` with origin
  // 'inbox' (no renderer drop ids; URLs never get the private-address exception).
  const inbox = new SyncInbox({
    ledger: new InboxLedger({ dir: syncDir }),
    dir: path.join(syncDir, 'inbox'),
    enabled: () => settings.get().sync.inbox.enabled,
    enqueue: async (c) => {
      const inputs: SourceInput[] = [
        ...c.urls.map((url): SourceInput => ({ id: mintInputId(), kind: 'url', origin: 'inbox', url })),
        ...c.files.map((f): SourceInput => ({ id: mintInputId(), kind: 'file', origin: 'inbox', path: f.path })),
      ];
      const { jobId } = await jobs.startFromMain(
        { inputs, options: { clarifyingInput: c.clarifyingInput, glossary: settings.get().glossary.defaultOn } },
        { origin: 'inbox', ref: c.jobId, root: c.root },
      );
      return { pipelineJobId: jobId };
    },
    // Honoured only while the job waits in its lane (16 §5.2 step 3): a running job is left alone.
    cancel: async (id) => {
      if (jobs.get(id)?.status !== 'queued') return false;
      try {
        await jobs.cancel(id);
        return true;
      } catch {
        return false;
      }
    },
    checkout: async (docId, versionId) => {
      const entry = library.list().find((e) => e.id === docId);
      if (!entry) return { kind: 'not-found' };
      try {
        await interactive.history.checkout({ slug: entry.topicSlug, versionId });
        return { kind: 'done' };
      } catch (err) {
        return checkoutOutcomeOf((err as { code?: string }).code);
      }
    },
    knownJob: (id) => jobs.findByOrigin(id),
    sniff: async (file, name, mime) => {
      const r = await sniffFile(file, name, mime);
      return r.ok ? r.mediaType : null;
    },
    kick: () => sync.schedulePush(),
  });
  jobs.on('changed', (s) => {
    const origin = jobs.originOf(s.id);
    if (origin?.kind !== 'inbox') return;
    inbox
      .reportJob(origin.ref, s)
      .catch((err: unknown) =>
        log.warn('sync.inbox.report-failed', { code: (err as { code?: string }).code ?? 'unknown' }),
      );
  });
  const sync = new SyncEngine({
    library,
    state: syncState,
    active: () => syncActive(registry, settings.get()),
    openStore: (guard) => openSyncStore(registry, settings.get(), { auth: syncOAuth, sessions: syncState }, guard),
    auth: { configured: () => syncOAuth.configured(), signedIn: () => syncOAuth.signedIn() },
    history: () => settings.get().sync.history,
    pollSeconds: () => settings.get().sync.pollSeconds,
    policy: () => registry.syncPolicy(),
    outline: documentHeadings,
    isBusy: (slug) => interactive.isBusy(slug),
    device: { name: deviceName(), appVersion: app.getVersion() },
    inbox,
  });
  // 16 §4.5 trigger and §4.8 cadence: library events push (debounced 5 s); resume and focus poll.
  library.on('changed', (e) => sync.schedulePush(e.slugs));
  library.on('organization', () => sync.schedulePush());
  library.on('moved', () => sync.schedulePush());
  settings.onChanged((_s, changed) => {
    if (changed.some((c) => c === 'sync' || c.startsWith('sync.'))) sync.refresh();
  });
  powerMonitor.on('resume', () => sync.pollSoon());
  app.on('browser-window-focus', () => sync.pollSoon(FOCUS_POLL_GAP_MS));
  quitSteps.unshift({ name: 'sync', run: async () => sync.stop() });
  sync.start();
  // Settings > Sync and the sidebar indicator (16 §8): `eli5:sync:*`, app window only.
  m3.services.sync = createSyncService({
    engine: sync,
    oauth: syncOAuth,
    state: syncState,
    policy: () => registry.syncPolicy(),
    active: () => syncActive(registry, settings.get()),
    edition,
    disable: async () => {
      await settings.set({ sync: { enabled: false } });
    },
    canDisable: () => !settings.isLocked('sync.enabled'),
  });

  // The viewer loads catalogued documents only through main (09 §11, 12 §7.7). A trashed one is not
  // loaded; the renderer's route shows it in the Trash with Put Back (11 §8).
  // An older document first gets the bundled runtime (D12 a, 07 §5.5); the refresh never rejects.
  // Only the newest open loads, so a slow refresh cannot replace a document opened after it.
  let openSeq = 0;
  const openDocument = (slug: string): void => {
    if (!library.hasSlug(slug)) return;
    const n = ++openSeq;
    void interactive.refreshRuntimeOnOpen(slug).then(() => {
      // Trashed or deleted while the refresh ran: nothing to load.
      if (n === openSeq && library.hasSlug(slug)) openInViewer(viewerWebContents(), slug);
    });
  };
  // Tray and context-menu callers pass slugs unchecked; only catalogued documents are revealed.
  const revealDocument = (slug: string): void => {
    if (library.hasSlug(slug)) electronShell.showItemInFolder(library.docPath(slug));
  };
  // Settings > Library "Reveal in Finder" (11 §7): the root itself, never a renderer path.
  const revealLibraryRoot = (): void => electronShell.showItemInFolder(library.root);

  // 10: publishing. Links open through safeOpenExternal bound to the app window (12 §7.5).
  const publish = createPublishService({
    registry,
    library,
    settings: () => settings.get(),
    clipboard,
    openExternal: (u) => safeOpenExternal(u, mainWebContents()?.id ?? MAIN_SENDER_ID),
    openPath: (p) => electronShell.openPath(p),
    showItemInFolder: (p) => electronShell.showItemInFolder(p),
  });
  m3.services.publish = publish;
  // 10 §11: abort running publishes first, before the queue and the Library close.
  quitSteps.unshift({ name: 'publish', run: () => publish.dispose() });
  // 11 §14: "Document ready" notifications; clicks are main-originated, so they share one fixed
  // rate-limit sender id (11 §14.6).
  const navigate = (route: UiRoute): void => sendToApp(IPC.app.navigate, { route });
  // 13 §8.2 E16: fake-LLM test runs post through a spy that e2e reads from main, never natively.
  const notifySpy =
    __ELI5_TEST__ && fakeLlm ? (await import('./shell/notification-spy')).createNotificationSpy() : undefined;
  if (notifySpy) (globalThis as { __eli5NotificationSpy?: unknown }).__eli5NotificationSpy = notifySpy;
  m3.notifier = createNotifier({
    Notification: notifySpy?.Notification ?? Notification,
    isSupported: notifySpy ? () => true : () => Notification.isSupported(),
    now: Date.now,
    showMainWindow,
    openInApp: (slug) => {
      openDocument(slug);
      navigate({ view: 'doc', slug });
    },
    navigate,
    openExternal: async (u) => {
      if (!(await safeOpenExternal(u, MAIN_SENDER_ID))) throw new Error('refused');
    },
    getMeta: async (slug) => (library.hasSlug(slug) ? library.getMeta(slug) : null),
    settings: () => settings.get().notifications,
    policy: () => registry.notificationPolicy(),
  });
  m3.services.notifications = createNotificationControls({
    notifier: m3.notifier,
    openExternal: (u) => electronShell.openExternal(u),
    now: Date.now,
    ...(app.isPackaged ? { bundleId: APP_BUNDLE_ID } : {}),
  });
  // 11 §7: Settings folder chooser and help links (the Help menu shares the same opener).
  Object.assign(m3.services, settingsServices({ settings, libraryRoot: library.root }));

  // 6. IPC, windows, Tray
  registerIpc({
    ipc: ipcMain,
    ids: { appWebContents: mainWebContents, viewerWebContents, isAppUrl },
    settings,
    keyStore,
    registry,
    viewer: {
      setBounds: setViewerBounds,
      setVisible: setViewerVisible,
      focus: focusViewer,
      find: findInDocument,
      stopFind: stopFindInDocument,
    },
    sendToApp,
    sendToViewer,
    jobs,
    library,
    documents: { open: openDocument, reveal: revealDocument, revealRoot: revealLibraryRoot },
    sources: { userData, clipboard: () => snapshotClipboard(clipboard) },
    apiKeyReady,
    connectionTestSystem: () => pipeline.prompts.fragment('connection-test').text,
    services: m3.services,
  });
  initShell({
    preloadDir: path.join(import.meta.dirname, '../preload'),
    rendererDir: path.join(import.meta.dirname, '../renderer'),
    devServerUrl: app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
    hooks: {
      openDocument,
      revealDocument,
      docHistory: docHistoryFromMenu,
      // 09 §4.2: the item menu's Move to / Archive / Move to Trash; `moved` reaches the app's toast.
      organizeMenu: (slug) => {
        const e = library.getEntry(slug);
        return e && !library.readOnly ? { folders: library.folders(), location: library.locationOf(e.id) } : undefined;
      },
      moveDocument: (slug, to) => {
        library
          .moveDocument(slug, to)
          .catch((err: unknown) =>
            log.info('library.move-refused', { slug, code: (err as { code?: string }).code ?? 'unknown' }),
          );
      },
    },
  });
  createMainWindow();
  viewerPort.attach();
  createTray();
  seedTray({
    catalog: library.list(),
    archived: new Set(library.list().flatMap((e) => (library.locationOf(e.id) === 'archive' ? [e.id] : []))),
    jobs: jobs.list(),
  });
  log.info('app.ready', { kind: edition });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
  // The app lives in the menu bar; closing the window never quits (11 §3).
  app.on('window-all-closed', () => {});
  app.on('activate', () => showMainWindow());
  // OS-initiated quits (log out, shut down, Dock > Quit) are never blocked (11 §3.2 step 4).
  app.on('before-quit', () => {
    shell.isQuitting = true;
  });
  app
    .whenReady()
    .then(bootstrap)
    .catch((err: unknown) => {
      log.error('app.bootstrap-failed', {}, err);
      // A headless real run or rebuild has no one to dismiss a modal: print, release, exit.
      if (realRunRequested(process.env, app.isPackaged)) {
        failHeadlessRun({ err, session: headlessSession, exit: (code) => app.exit(code) });
        return;
      }
      // 01 §6.3: an enterprise overlay failure never starts with a partial capability set.
      dialog.showErrorBox('ELI5 Learner could not start', err instanceof Error ? err.message : String(err));
      app.exit(1);
    });
}
