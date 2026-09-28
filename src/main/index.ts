import path from 'node:path';
import fs from 'node:fs';
import { app, dialog, ipcMain, protocol } from 'electron';
import { SettingsStore } from './config/store';
import { createKeyStore } from './config/keystore';
import { initPaths, resolveUserDataDir } from './config/paths';
import { Registry } from './editions/registry';
import { registerPublicCapabilities } from './editions/public';
import { loadOverlay } from './editions/load-overlay';
import { edition } from './editions/types';
import { registerIpc } from './ipc';
import { hardenApp } from './security/harden';
import { RotatingFileSink, createLogger, installLogger, log } from './security/log';
import {
  createMainWindow,
  createTray,
  initShell,
  isAppUrl,
  mainWebContents,
  setViewerBounds,
  setViewerVisible,
  shell,
  showMainWindow,
  viewerWebContents,
} from './shell';

// Privileges must be registered at module load, before ready (12 §7.7).
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'eli5doc',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: false,
      bypassCSP: false,
      stream: false,
    },
  },
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

  // 6. IPC, windows, Tray
  registerIpc({
    ipc: ipcMain,
    ids: { appWebContents: mainWebContents, viewerWebContents, isAppUrl },
    settings,
    keyStore,
    registry,
    viewer: { setBounds: setViewerBounds, setVisible: setViewerVisible },
    sendToApp: (channel, payload) => mainWebContents()?.send(channel, payload),
  });
  initShell({
    preloadDir: path.join(import.meta.dirname, '../preload'),
    rendererDir: path.join(import.meta.dirname, '../renderer'),
    devServerUrl: app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
  });
  createMainWindow();
  createTray();
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
