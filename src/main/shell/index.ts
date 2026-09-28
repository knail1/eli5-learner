import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, Menu, Tray, WebContentsView, app, nativeImage, session } from 'electron';
import { SECURE_WEB_PREFERENCES, registerSurface } from '../security';
import { APP_CSP_DEV, APP_CSP_PROD } from '../security';
import { log } from '../security';

/**
 * M0 shell: main window that hides on close, a WebContentsView for documents, and the menu bar
 * item with Open / Quit. Full layout, recents and routes are 11 (M1b).
 */

export const VIEWER_PARTITION = 'eli5-viewer';

/** Set only by the Tray Quit item (11 §3.2). Electron's app has no isQuitting; do not add one. */
export const shell = { isQuitting: false };

let mainWindow: BrowserWindow | undefined;
let viewerView: WebContentsView | undefined;
let tray: Tray | undefined;

interface ShellPaths {
  preloadDir: string;
  rendererDir: string;
  /** Vite dev server URL in dev; undefined in builds. */
  devServerUrl: string | undefined;
}
let paths: ShellPaths;

export function initShell(p: ShellPaths): void {
  paths = p;
}

export function mainWebContents(): Electron.WebContents | undefined {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined;
}

export function viewerWebContents(): Electron.WebContents | undefined {
  return viewerView && !viewerView.webContents.isDestroyed() ? viewerView.webContents : undefined;
}

/** App renderer origin check used by the IPC sender guard (12 §7.2 step 6). */
export function isAppUrl(url: URL): boolean {
  if (paths.devServerUrl) return url.origin === new URL(paths.devServerUrl).origin;
  const index = pathToFileURL(path.join(paths.rendererDir, 'index.html'));
  return url.protocol === 'file:' && url.pathname === index.pathname;
}

function rendererEntry(): string {
  return paths.devServerUrl ?? pathToFileURL(path.join(paths.rendererDir, 'index.html')).toString();
}

/** App renderer CSP as a response header for the dev server; builds use the meta tag in index.html. */
function installAppCsp(): void {
  const csp = app.isPackaged ? APP_CSP_PROD : APP_CSP_DEV;
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const headers = { ...details.responseHeaders };
    if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
      headers['Content-Security-Policy'] = [csp];
    }
    cb({ responseHeaders: headers });
  });
}

export function createMainWindow(): BrowserWindow {
  installAppCsp();
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'ELI5 Learner',
    webPreferences: { ...SECURE_WEB_PREFERENCES, preload: path.join(paths.preloadDir, 'app.cjs') },
  });
  mainWindow = win;
  registerSurface(win.webContents, 'app', (url) => isAppUrl(url));

  win.on('close', (e) => {
    if (shell.isQuitting) return;
    e.preventDefault();
    win.hide();
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('render-process-gone', (_e, d) => {
    log.warn('renderer.gone', { kind: d.reason });
    if (!shell.isQuitting) win.webContents.reload();
  });

  const viewer = new WebContentsView({
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      partition: VIEWER_PARTITION,
      preload: path.join(paths.preloadDir, 'doc.cjs'),
    },
  });
  viewerView = viewer;
  registerSurface(viewer.webContents, 'viewer', (url) => {
    const current = viewer.webContents.getURL();
    if (!current) return false;
    const cur = new URL(current);
    // Same document only; fragment changes allowed (12 §7.2 step 3).
    return url.protocol === 'eli5doc:' && url.host === cur.host && url.pathname === cur.pathname;
  });
  viewer.setVisible(false);
  win.contentView.addChildView(viewer);

  void win.loadURL(rendererEntry());
  return win;
}

export function setViewerBounds(b: { x: number; y: number; width: number; height: number }): void {
  viewerView?.setBounds({
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(0, Math.round(b.width)),
    height: Math.max(0, Math.round(b.height)),
  });
}

export function setViewerVisible(v: boolean): void {
  viewerView?.setVisible(v);
}

export function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  else {
    mainWindow.show();
    mainWindow.focus();
  }
}

export function createTray(): Tray {
  // M1b replaces the text title with template icons from resources/tray (11 §4).
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('ELI5');
  tray.setToolTip('ELI5 Learner');
  rebuildTrayMenu();
  return tray;
}

export function rebuildTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open ELI5 Learner', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          shell.isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}
