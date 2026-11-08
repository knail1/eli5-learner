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

/**
 * 12 §7.2: the viewer allows exactly one kind of subframe navigation, a direct child of the
 * document loading `about:srcdoc` (an animation frame, 07 §7.1).
 */
export function isViewerSubframeNavigationAllowed(url: string, directChild: boolean): boolean {
  return directChild && url === 'about:srcdoc';
}

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

/**
 * Sync consent page (12 §7.5, 16 §3.2). The personal-sync sign-in opens only this fixed Google URL
 * plus query parameters built in main; it never comes from renderer input.
 */
export const SYNC_CONSENT_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

/** True only for the fixed consent endpoint (same origin and path, no fragment) that also passes the §7.5 checks. */
export function isSyncConsentUrl(raw: string): boolean {
  if (!isSafeExternalUrl(raw)) return false;
  const u = new URL(raw);
  const fixed = new URL(SYNC_CONSENT_URL);
  return u.origin === fixed.origin && u.pathname === fixed.pathname && u.hash === '';
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
    // 12 §9: nothing in the app uses WebRTC, and CSP does not cover its ICE/STUN traffic, so no
    // renderer (a document's animation frame included) may send UDP outside a proxy.
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');

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
      if (surfaceOf(wc) === 'viewer') {
        // 07 §7.1: a document's only subframes are its sandboxed animation frames, which load
        // their srcdoc once; any other subframe navigation (network, data:, a frame re-navigating
        // itself) is denied.
        if (!isViewerSubframeNavigationAllowed(details.url, details.frame?.parent === wc.mainFrame))
          details.preventDefault();
        return;
      }
      if (!allowed(wc, details.url)) details.preventDefault();
    });

    if (app.isPackaged) wc.on('devtools-opened', () => wc.closeDevTools());
  });
}
