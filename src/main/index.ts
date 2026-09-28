import path from 'node:path';
import fs from 'node:fs';
import { app, dialog, ipcMain, protocol, session, shell as electronShell } from 'electron';
import { IPC, type IpcChannel } from '../preload/contract';
import { SettingsStore } from './config/store';
import { createKeyStore } from './config/keystore';
import { initPaths, resourcePath, resolveUserDataDir } from './config/paths';
import { Registry } from './editions/registry';
import { registerPublicCapabilities } from './editions/public';
import { loadOverlay } from './editions/load-overlay';
import { edition } from './editions/types';
import { PDF_RENDER_SCHEME_PRIVILEGES } from './extract';
import { configureFetch } from './fetch';
import { registerIpc } from './ipc';
import { DOC_SCHEME, createDocProtocolHandler, gitCheckIgnored, installDocProtocol, openLibrary } from './library';
import { configureLlmRuntime, createLlmFetch, retryPolicyFromPipeline } from './llm';
import { hardenApp } from './security/harden';
import { RotatingFileSink, createLogger, installLogger, log } from './security/log';
import {
  createMainWindow,
  createTray,
  initShell,
  isAppUrl,
  mainWebContents,
  observeAppEvent,
  seedTray,
  setViewerBounds,
  setViewerVisible,
  shell,
  showMainWindow,
  VIEWER_PARTITION,
  viewerWebContents,
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
]);

// Dev and test runs never touch the real profile (12 §4.1).
app.setPath(
  'userData',
  resolveUserDataDir({ isPackaged: app.isPackaged, defaultDir: app.getPath('userData'), env: process.env }),
);

hardenApp();

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
    registry.registerLLMProvider(provider, () => new FakeProvider(script, { id: provider, readFile: read }));
  }

  // 3. overlay (enterprise only; fatal on failure)
  await loadOverlay(registry);
  // 4. re-validate settings against the extended schema
  await settings.applyExtension(registry.settingsExtension());
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
  app.on('before-quit', () => {
    void library.close();
  });
  // eli5doc:// is served on the viewer session only (12 §7.7 step 2).
  installDocProtocol(
    session.fromPartition(VIEWER_PARTITION),
    createDocProtocolHandler({
      root: library.root,
      isCatalogued: (slug) => library.hasSlug(slug),
      helpRoot: resourcePath('help'),
    }),
  );

  // Every push to the app renderer also feeds the Tray (11 §4.2).
  const sendToApp = (channel: IpcChannel, payload: unknown): void => {
    observeAppEvent(channel, payload);
    mainWebContents()?.send(channel, payload);
  };
  library.on('changed', () => sendToApp(IPC.library.changed, { entries: library.list() }));

  // 6. IPC, windows, Tray
  registerIpc({
    ipc: ipcMain,
    ids: { appWebContents: mainWebContents, viewerWebContents, isAppUrl },
    settings,
    keyStore,
    registry,
    viewer: { setBounds: setViewerBounds, setVisible: setViewerVisible },
    sendToApp,
  });
  initShell({
    preloadDir: path.join(import.meta.dirname, '../preload'),
    rendererDir: path.join(import.meta.dirname, '../renderer'),
    devServerUrl: app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
    // openDocument (viewer.open) is wired with the viewer loader in M2.
    hooks: { revealDocument: (slug) => electronShell.showItemInFolder(library.docPath(slug)) },
  });
  createMainWindow();
  createTray();
  seedTray({ catalog: library.list() });
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
