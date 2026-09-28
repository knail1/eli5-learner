import { access } from 'node:fs/promises';
import path from 'node:path';
import {
  BrowserWindow,
  Menu,
  WebContentsView,
  app,
  shell as electronShell,
  nativeTheme,
  screen,
  dialog,
  protocol,
  session,
} from 'electron';
import { IPC, type UiRoute, type ViewerBounds } from '../../preload/contract';
import { resourcePath } from '../config';
import { APP_CSP_DEV, APP_CSP_PROD, SECURE_WEB_PREFERENCES, log, registerSurface, safeOpenExternal } from '../security';
import {
  MENU_SHORTCUT_KEYS,
  appMenuTemplate,
  libraryItemMenuTemplate,
  type LibraryItemMenuActions,
  type MenuShortcutId,
} from './app-menu';
import { APP_ENTRY_URL, APP_SCHEME, createAppProtocolHandler, isAppRendererUrl } from './app-protocol';
import type { FolderChooserDeps } from './choose-folder';
import { createHelpOpener, type HelpOpener } from './menu-help';
import { createSettingsServices } from './settings-services';
import { ERROR_PAGE, RELOAD_FRAGMENT, closeAction, crashTracker, shell, viewerErrorPage } from './lifecycle';
import { installViewerKeyHandoff } from './viewer-keys';
import {
  WINDOW_DEFAULTS,
  debounce,
  fitToDisplays,
  loadWindowState,
  saveWindowState,
  windowStatePath,
  type WindowState,
} from './window-state';

/** Main window, viewer WebContentsView and application menu (11 §3, §5.1). */

export const VIEWER_PARTITION = 'eli5-viewer';

export interface ShellHooks {
  /** Loads a document into the viewer (09/07 `viewer.open`); wired by bootstrap in M2. */
  openDocument?(slug: string): void;
  /** Reveals a document folder in Finder (09 `library.reveal`); wired by bootstrap in M2. */
  revealDocument?(slug: string): void;
  /** Edit > Undo/Redo Document Change for the document in the viewer (09 §4.1). */
  docHistory?(dir: 'undo' | 'redo'): void;
}

export interface ShellPaths {
  preloadDir: string;
  rendererDir: string;
  /** Vite dev server URL in dev; undefined in builds. */
  devServerUrl: string | undefined;
  /** Optional collaborators; the shell degrades to navigation only without them. */
  hooks?: ShellHooks;
}

let paths: ShellPaths | undefined;
let mainWindow: BrowserWindow | undefined;
let viewerView: WebContentsView | undefined;
let viewerAttached = false;
let lastBounds: ViewerBounds | undefined;
let trayAvailable = true;
let showingErrorPage = false;
let cspInstalled = false;

export function initShell(p: ShellPaths): void {
  paths = p;
}

function need(): ShellPaths {
  if (!paths) throw new Error('initShell() must run before the shell is used');
  return paths;
}

export function shellHooks(): ShellHooks {
  return paths?.hooks ?? {};
}

/** Called by tray.ts; without a Tray, closing the window quits (11 §13). */
export function setTrayAvailable(v: boolean): void {
  trayAvailable = v;
}

export function mainWebContents(): Electron.WebContents | undefined {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined;
}

export function viewerWebContents(): Electron.WebContents | undefined {
  return viewerView && !viewerView.webContents.isDestroyed() ? viewerView.webContents : undefined;
}

/** App renderer origin check used by the IPC sender guard (12 §7.2 step 6). */
export function isAppUrl(url: URL): boolean {
  return isAppRendererUrl(url, need().devServerUrl);
}

/** Builds load over eli5app://, never file:// (GrantFileProtocolExtraPrivileges is off, 12 §7.8). */
function rendererEntry(): string {
  return need().devServerUrl ?? APP_ENTRY_URL;
}

/** Serves out/renderer over eli5app:// on the default session (the app renderer's) in builds. */
export function installAppProtocol(): void {
  const p = need();
  if (p.devServerUrl || protocol.isProtocolHandled(APP_SCHEME)) return;
  protocol.handle(APP_SCHEME, createAppProtocolHandler({ rendererDir: p.rendererDir }));
}

/** App renderer CSP as a response header for the dev server; builds use the meta tag in index.html. */
function installAppCsp(): void {
  if (cspInstalled) return;
  cspInstalled = true;
  const csp = app.isPackaged ? APP_CSP_PROD : APP_CSP_DEV;
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const headers = { ...details.responseHeaders };
    if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
      headers['Content-Security-Policy'] = [csp];
    }
    cb({ responseHeaders: headers });
  });
}

/** Sends `eli5:app:navigate` to the app renderer (11 §10). */
export function navigate(route: UiRoute): void {
  mainWebContents()?.send(IPC.app.navigate, { route });
}

/** Rate-limit key for links main opens on its own behalf (Help menu, Settings help links). */
const MAIN_SENDER_ID = -1;
let help: HelpOpener | undefined;

/** HOOK-UI-02 help links, shared by the Help menu and `eli5:settings:open-help` (11 §7). */
export function helpOpener(): HelpOpener {
  help ??= createHelpOpener({
    resourcePath,
    exists: (p) =>
      access(p).then(
        () => true,
        () => false,
      ),
    openPath: (p) => electronShell.openPath(p),
    showItemInFolder: (p) => electronShell.showItemInFolder(p),
    openExternal: (url) => safeOpenExternal(url, MAIN_SENDER_ID),
  });
  return help;
}

/** The Settings slots for IpcServices (11 §7): the folder panel sheets on the main window when open. */
export function settingsServices(
  d: Pick<FolderChooserDeps, 'settings' | 'libraryRoot'>,
): ReturnType<typeof createSettingsServices> {
  return createSettingsServices({
    ...d,
    showOpenDialog: (opts) => {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      return win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts);
    },
    help: helpOpener(),
  });
}

/** Menu item for a window shortcut: run it in the app renderer, even when the viewer had focus (11 §9). */
function forwardShortcut(id: MenuShortcutId): void {
  showMainWindow();
  const wc = mainWebContents();
  if (!wc) return;
  wc.focus();
  const keyCode = MENU_SHORTCUT_KEYS[id];
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['meta'] });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['meta'] });
}

export function installAppMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate(
        {
          hideWindow: () => requestCloseMainWindow(),
          openSettings: () => {
            showMainWindow();
            navigate({ view: 'settings' });
          },
          shortcut: forwardShortcut,
          // Cmd+R reloads the document, never the app renderer (11 §9).
          reloadViewer: () => {
            if (viewerAttached) viewerWebContents()?.reload();
          },
          docHistory: (dir) => shellHooks().docHistory?.(dir),
          openHelp: (topic) => {
            void helpOpener()
              .open(topic)
              .then((ok) => {
                if (!ok) log.warn('help.unavailable', { kind: topic });
              });
          },
        },
        { appName: 'ELI5 Learner', devTools: !app.isPackaged },
      ),
    ),
  );
}

function initialState(): { file: string; state: WindowState } {
  const file = windowStatePath(app.getPath('userData'));
  const saved = loadWindowState(file);
  const state = fitToDisplays(
    saved,
    screen.getAllDisplays().map((d) => d.workArea),
    screen.getPrimaryDisplay().workArea,
  );
  return { file, state };
}

/**
 * Close policy shared by the red close button and Cmd+W / Cmd+Q: hide normally, quit when no Tray
 * exists to come back from (11 §3.2 step 1, §13).
 */
export function requestCloseMainWindow(): void {
  const action = closeAction({ isQuitting: shell.isQuitting, trayAvailable });
  if (action === 'hide') {
    hideMainWindow();
    return;
  }
  shell.isQuitting = true;
  app.quit();
}

export function createMainWindow(): BrowserWindow {
  installAppCsp();
  installAppProtocol();
  installAppMenu();
  const { file, state } = initialState();
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: WINDOW_DEFAULTS.minWidth,
    minHeight: WINDOW_DEFAULTS.minHeight,
    show: false,
    title: 'ELI5 Learner',
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1a' : '#fbfaf7',
    webPreferences: { ...SECURE_WEB_PREFERENCES, preload: path.join(need().preloadDir, 'app.cjs') },
  });
  mainWindow = win;
  registerSurface(win.webContents, 'app', (url) => isAppUrl(url));
  if (state.maximized) win.maximize();

  // Bounds persistence, debounced 500 ms (11 §3.1). Sidebar fields are carried through unchanged.
  const persist = debounce(() => {
    if (win.isDestroyed()) return;
    const b = win.getNormalBounds();
    const next: WindowState = { ...state, ...b, maximized: win.isMaximized() };
    try {
      saveWindowState(file, next);
    } catch (err) {
      log.warn('shell.window-state-save-failed', { errorKind: err instanceof Error ? err.name : 'unknown' });
    }
  }, 500);
  win.on('resize', () => persist());
  win.on('move', () => persist());
  win.on('maximize', () => persist());
  win.on('unmaximize', () => persist());
  win.on('resize', () => {
    if (lastBounds) setViewerBounds(lastBounds);
  });

  win.on('close', (e) => {
    persist.flush();
    const action = closeAction({ isQuitting: shell.isQuitting, trayAvailable });
    if (action === 'close') return;
    if (action === 'quit') {
      shell.isQuitting = true;
      app.quit();
      return;
    }
    e.preventDefault();
    hideMainWindow();
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined;
    viewerView = undefined;
    viewerAttached = false;
  });
  win.once('ready-to-show', () => win.show());

  // Every reload of the app renderer detaches the viewer first: the reloaded renderer starts on a
  // non-doc route, and its ViewerSlot re-attaches the view when a doc route mounts (11 §5.1).
  const reloadRenderer = (): void => {
    showingErrorPage = false;
    setViewerVisible(false);
    void win.loadURL(rendererEntry());
  };
  const crashes = crashTracker();
  win.webContents.on('render-process-gone', (_e, d) => {
    log.warn('renderer.gone', { kind: d.reason });
    if (shell.isQuitting || win.isDestroyed()) return;
    if (crashes.record(Date.now()) === 'reload') {
      reloadRenderer();
    } else {
      showingErrorPage = true;
      setViewerVisible(false);
      void win.loadURL(ERROR_PAGE);
    }
  });
  // Error page recovery: the Reload link (a navigation to the sentinel, held here) or Return (11 §3.2).
  win.webContents.on('will-navigate', (e, url) => {
    if (!showingErrorPage || url !== RELOAD_FRAGMENT) return;
    e.preventDefault();
    reloadRenderer();
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (!showingErrorPage || input.type !== 'keyDown' || input.key !== 'Enter') return;
    e.preventDefault();
    reloadRenderer();
  });

  viewerView = new WebContentsView({
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      partition: VIEWER_PARTITION,
      preload: path.join(need().preloadDir, 'doc.cjs'),
    },
  });
  const viewer = viewerView;
  // The document the viewer last crashed on (01 §9); the crash page's Retry may navigate back to it.
  let crashedDocUrl: string | undefined;
  registerSurface(viewer.webContents, 'viewer', (url) => {
    const current = viewer.webContents.getURL();
    if (!current) return false;
    if (current.startsWith('data:')) return crashedDocUrl !== undefined && url.href === crashedDocUrl;
    const cur = new URL(current);
    // Same document only; fragment changes allowed (12 §7.2 step 3).
    return url.protocol === 'eli5doc:' && url.host === cur.host && url.pathname === cur.pathname;
  });
  // Viewer crash (01 §9): reload the document once; a second crash within 60 s shows "Could not
  // display this document" in the viewer slot, with Retry back to that document.
  const viewerCrashes = crashTracker();
  viewer.webContents.on('render-process-gone', (_e, d) => {
    log.warn('viewer.gone', { kind: d.reason });
    const wc = viewer.webContents;
    if (shell.isQuitting || wc.isDestroyed()) return;
    const url = wc.getURL();
    if (url.startsWith('eli5doc:')) crashedDocUrl = url;
    if (!crashedDocUrl) return;
    if (viewerCrashes.record(Date.now()) === 'reload') void wc.loadURL(crashedDocUrl);
    else void wc.loadURL(viewerErrorPage(crashedDocUrl));
  });
  // F6, Shift+F6 and Cmd+1…9 pressed in the viewer go back to the app renderer (11 §12).
  installViewerKeyHandoff(viewer.webContents, mainWebContents, (dir) =>
    mainWebContents()?.send(IPC.app.cycleRegion, { dir }),
  );
  // Detached until the renderer shows the doc route (11 §5.1).
  viewer.setVisible(false);
  viewerAttached = false;

  void win.loadURL(rendererEntry());
  return win;
}

/**
 * Viewer rectangle from `ViewerSlot` in CSS px; scaled by the app renderer's zoom so the native
 * view follows 200% zoom (11 §12).
 */
export function setViewerBounds(b: ViewerBounds): void {
  lastBounds = b;
  const zoom = mainWebContents()?.getZoomFactor() ?? 1;
  viewerView?.setBounds({
    x: Math.round(b.x * zoom),
    y: Math.round(b.y * zoom),
    width: Math.max(0, Math.round(b.width * zoom)),
    height: Math.max(0, Math.round(b.height * zoom)),
  });
}

/** Non-doc routes remove the view from the window; returning re-adds it (11 §5.1). */
export function setViewerVisible(v: boolean): void {
  const win = mainWindow;
  const view = viewerView;
  if (!win || win.isDestroyed() || !view) return;
  if (v) {
    if (!viewerAttached) {
      win.contentView.addChildView(view);
      viewerAttached = true;
    }
    if (lastBounds) setViewerBounds(lastBounds);
    view.setVisible(true);
  } else {
    view.setVisible(false);
    if (viewerAttached) {
      win.contentView.removeChildView(view);
      viewerAttached = false;
    }
  }
}

/** F6 into the viewer (11 §12): focus the view; the doc runtime then focuses its active tab. */
export function focusViewer(): void {
  if (viewerAttached) viewerWebContents()?.focus();
}

export function isViewerAttached(): boolean {
  return viewerAttached;
}

/** Hide the window and the Dock icon; jobs keep running (11 §3.2 step 1). */
export function hideMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  app.dock?.hide();
  // Electron ignores dock.hide() within 1 s of dock.show() (a macOS multiple-icon workaround), so
  // a quick show-then-hide re-asserts the hide once that window has passed.
  clearTimeout(dockRecheck);
  const wait = lastDockShow + DOCK_SHOW_GUARD_MS - Date.now();
  if (wait > 0) {
    dockRecheck = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) app.dock?.hide();
    }, wait);
  }
}

const DOCK_SHOW_GUARD_MS = 1100;
let lastDockShow = 0;
let dockRecheck: ReturnType<typeof setTimeout> | undefined;

/** Dock icon first, then show and focus (11 §3.2 step 6). */
export function showMainWindow(): void {
  clearTimeout(dockRecheck);
  lastDockShow = Date.now();
  void app.dock?.show();
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Native Library item menu for `eli5:app:context-menu` (11 §5.2, §10); the IPC handler calls this. */
export function showLibraryItemMenu(slug: string, a: LibraryItemMenuActions): void {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  Menu.buildFromTemplate(libraryItemMenuTemplate(slug, a)).popup(win ? { window: win } : {});
}
