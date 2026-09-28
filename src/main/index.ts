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
import { initPaths, migrateLegacyUserData, resourcePath, resolveUserDataDir } from './config/paths';
import { Registry } from './editions/registry';
import { registerPublicCapabilities } from './editions/public';
import { loadOverlay } from './editions/load-overlay';
import { edition } from './editions/types';
import { prepareRealRun, startRealRun } from './devtools';
import { createElectronViewerPort, createInteractiveReading } from './document';
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
  APP_SCHEME_PRIVILEGES,
  createMainWindow,
  createNotificationControls,
  createNotifier,
  createTray,
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

/** Bootstrap order (01 §6.3). */
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
  if (__ELI5_TEST__ && process.env.ELI5_LLM_FAKE === '1') {
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

  // 3. overlay (enterprise only; fatal on failure)
  await loadOverlay(registry);
  // 4. re-validate settings against the extended schema
  await settings.applyExtension(registry.settingsExtension());
  // Dev-only budget-capped real run: wraps the LLM providers before the freeze; inert unless
  // ELI5_REAL_RUN_URLS is set, and never reachable in packaged builds (scripts/real-run/README.md).
  const realRun = app.isPackaged
    ? undefined
    : prepareRealRun({ env: process.env, isPackaged: app.isPackaged, userData, registry });
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

  // Crash sweep of pre-job clipboard drafts older than 24 h (03 §6.1 step 6); never rejects.
  void sweepStaleDrafts(userData);

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
  const fakeLlm = __ELI5_TEST__ && process.env.ELI5_LLM_FAKE === '1';
  const pipeline = createPipelineDeps({
    registry,
    settings: () => settings.get(),
    keyStore,
    library,
    userData,
    resourcePath,
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
  // 11 §14.2: one "Document ready" per finished create job, through the notifier slot.
  jobs.on(
    'done',
    notifyOnCreateDone(() => m3.notifier),
  );
  // Crash recovery (06 §9.4) finishes before IPC exists, so the renderer's first eli5:jobs:list
  // already sees resumed jobs. A failure here must not stop the app from opening the Library.
  await jobs.init().catch((err: unknown) => log.error('pipeline.init-failed', {}, err));
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
  if (realRun) {
    void startRealRun({
      session: realRun,
      jobs,
      library,
      provider: () => registry.llm(),
      glossary: settings.get().glossary.defaultOn,
      quit: (code) => {
        exitCode = code;
        app.quit();
      },
    });
    return;
  }

  // The viewer loads catalogued documents only through main (09 §11, 12 §7.7).
  const openDocument = (slug: string): void => openInViewer(viewerWebContents(), slug);
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
    viewer: { setBounds: setViewerBounds, setVisible: setViewerVisible, focus: focusViewer },
    sendToApp,
    sendToViewer,
    jobs,
    library,
    documents: { open: openDocument, reveal: revealDocument, revealRoot: revealLibraryRoot },
    sources: { userData, clipboard: () => snapshotClipboard(clipboard) },
    apiKeyReady,
    services: m3.services,
  });
  initShell({
    preloadDir: path.join(import.meta.dirname, '../preload'),
    rendererDir: path.join(import.meta.dirname, '../renderer'),
    devServerUrl: app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
    hooks: { openDocument, revealDocument, docHistory: docHistoryFromMenu },
  });
  createMainWindow();
  viewerPort.attach();
  createTray();
  seedTray({ catalog: library.list(), jobs: jobs.list() });
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
      // 01 §6.3: an enterprise overlay failure never starts with a partial capability set.
      dialog.showErrorBox('ELI5 Learner could not start', err instanceof Error ? err.message : String(err));
      app.exit(1);
    });
}
