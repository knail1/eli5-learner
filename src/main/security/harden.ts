import { app, session, shell, type Session, type WebContents, type WebPreferences } from 'electron';
import { log } from './log';

/** Electron security baseline (12 §7). hardenApp() runs before any window is created. */

/** Every window uses these (12 §7.1). Callers add `preload` and `partition` only. */
export const SECURE_WEB_PREFERENCES: Readonly<WebPreferences> = Object.freeze({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  navigateOnDragDrop: false,
  spellcheck: false,
});

export type Surface = 'app' | 'viewer' | 'fetch' | 'other';

/** Main registers each webContents with its surface so guards can apply the right allowlist. */
const surfaces = new Map<number, { surface: Surface; allowNavigation: (url: URL) => boolean }>();

export function registerSurface(wc: WebContents, surface: Surface, allowNavigation: (url: URL) => boolean): void {
  surfaces.set(wc.id, { surface, allowNavigation });
  wc.once('destroyed', () => surfaces.delete(wc.id));
}

export function surfaceOf(wc: WebContents): Surface {
  return surfaces.get(wc.id)?.surface ?? 'other';
}

const BLOCKED_SCHEMES = new Set(['file:', 'data:', 'javascript:']);

function allowed(wc: WebContents, target: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (BLOCKED_SCHEMES.has(url.protocol)) return false;
  const entry = surfaces.get(wc.id);
  if (!entry) return false;
  if (entry.surface === 'fetch') return url.protocol === 'http:' || url.protocol === 'https:';
  return entry.allowNavigation(url);
}

// ---- shell.openExternal (12 §7.5) ----

const openTimes = new Map<number, number[]>();

export function isSafeExternalUrl(raw: string): boolean {
  if (raw.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !u.username && !u.password;
}

/** Validates and rate-limits (2/s, 20/min per sender) before opening in the default browser. */
export async function safeOpenExternal(raw: string, senderId: number, now: number = Date.now()): Promise<boolean> {
  if (!isSafeExternalUrl(raw)) {
    log.warn('open-external.rejected', { kind: 'url' });
    return false;
  }
  const times = (openTimes.get(senderId) ?? []).filter((t) => now - t < 60_000);
  if (times.filter((t) => now - t < 1000).length >= 2 || times.length >= 20) {
    log.warn('open-external.rate-limited', { count: times.length });
    return false;
  }
  times.push(now);
  openTimes.set(senderId, times);
  await shell.openExternal(raw, { activate: true });
  return true;
}

// ---- permissions (12 §7.3) ----

export function denyAllPermissions(ses: Session): void {
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
}

/** App-wide guards on every webContents (12 §7.2). */
export function hardenApp(): void {
  app.enableSandbox();

  app.on('session-created', (ses) => denyAllPermissions(ses));
  app
    .whenReady()
    .then(() => denyAllPermissions(session.defaultSession))
    .catch(() => {});

  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (ev) => ev.preventDefault());

    wc.setWindowOpenHandler(({ url }) => {
      if (surfaceOf(wc) === 'viewer' && isSafeExternalUrl(url)) void safeOpenExternal(url, wc.id);
      return { action: 'deny' };
    });

    const guard = (ev: Electron.Event, url: string): void => {
      if (!allowed(wc, url)) {
        ev.preventDefault();
        log.warn('navigation.blocked', { kind: surfaceOf(wc) });
        if (surfaceOf(wc) === 'viewer' && isSafeExternalUrl(url)) void safeOpenExternal(url, wc.id);
      }
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('will-frame-navigate', (details) => {
      if (details.isMainFrame) return;
      if (surfaceOf(wc) === 'viewer' || !allowed(wc, details.url)) details.preventDefault();
    });

    if (app.isPackaged) wc.on('devtools-opened', () => wc.closeDevTools());
  });
}
