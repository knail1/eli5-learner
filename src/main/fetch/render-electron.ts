import { BrowserWindow, session, type Session, type WebContents } from 'electron';
import { denyAllPermissions, registerSurface, SECURE_WEB_PREFERENCES } from '../security';
import { renderPartition } from './constants';
import { isLoginHop } from './login-wall';
import type { LoadResult, ProbeResult, RenderBackend, RenderPool, RenderState, RenderWindow } from './render-window';
import type { LoginSignature, NetworkConfigurator } from './types';
import { isPrivateHostName, isPrivateTarget, type HostLookup } from './url';

/**
 * Electron RenderBackend (05 §8.1–8.2): pooled non-persistent partitions eli5-render-<slot>, one
 * combined listener per webRequest event, lockdown handlers, isolated-world probes. Exercised by
 * the Playwright `_electron` suite; orchestration is unit-tested in render-window.ts.
 */

const ISOLATED_WORLD = 999;
const BLOCKED_TYPES = new Set(['media', 'font', 'image', 'object', 'ping', 'cspReport']);
const PROBE = `({ textLength: document.body ? document.body.innerText.length : 0,
  nodeCount: document.getElementsByTagName('*').length, readyState: document.readyState })`;
const NO_DIALOGS = 'window.alert = () => undefined; window.confirm = () => false; window.prompt = () => null;';

export interface ElectronRenderOptions {
  pool: RenderPool;
  configureSession: NetworkConfigurator;
  userAgent: string;
  lookup: HostLookup;
  loginSignatures: readonly LoginSignature[];
}

/** RenderState plus the hook that ends a pending load when a lockdown handler stops the render. */
type Notify = () => void;

export function createElectronRenderBackend(o: ElectronRenderOptions): RenderBackend {
  const sessions = new Map<number, Promise<Session>>();
  const notifiers = new Map<number, Notify>();

  const current = (slot: number): RenderState | undefined => o.pool.state(slot);

  function installSessionHandlers(ses: Session, slot: number): void {
    denyAllPermissions(ses);
    ses.on('will-download', (_e, item) => item.cancel());
    // Electron keeps one listener per webRequest event: all concerns are combined here (§8.2).
    ses.webRequest.onBeforeRequest((d, cb) => {
      const st = current(slot);
      if (!st || d.webContentsId !== st.webContentsId) return cb({ cancel: true });
      if (BLOCKED_TYPES.has(d.resourceType)) return cb({ cancel: true });
      if (!/^(https?|wss?):/i.test(d.url)) return cb({ cancel: true });
      const admit = (): void => {
        if (d.resourceType !== 'webSocket') st.inflight.set(d.id, Date.now());
        cb({});
      };
      if (st.allowPrivate) return admit();
      isPrivateTarget(d.url, o.lookup, st.privateCache).then(
        (priv) => {
          if (!priv) return admit();
          if (d.resourceType === 'mainFrame') {
            st.blockedPrivate = true;
            notifiers.get(slot)?.();
          }
          cb({ cancel: true });
        },
        () => cb({ cancel: true }),
      );
    });
    ses.webRequest.onCompleted((d) => current(slot)?.inflight.delete(d.id));
    ses.webRequest.onErrorOccurred((d) => current(slot)?.inflight.delete(d.id));
  }

  function slotSession(slot: number): Promise<Session> {
    let p = sessions.get(slot);
    if (!p) {
      p = (async () => {
        const ses = session.fromPartition(renderPartition(slot), { cache: false }); // no 'persist:'
        await o.configureSession(ses); // HOOK-FETCH-01
        installSessionHandlers(ses, slot);
        return ses;
      })();
      sessions.set(slot, p);
      p.catch(() => sessions.delete(slot));
    }
    return p;
  }

  function lockDown(wc: WebContents, st: RenderState, slot: number): void {
    registerSurface(wc, 'fetch', (u) => u.protocol === 'http:' || u.protocol === 'https:');
    wc.setAudioMuted(true);
    wc.setUserAgent(o.userAgent);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-prevent-unload', (e) => e.preventDefault());
    wc.on('render-process-gone', () => {
      st.crashed = true;
      notifiers.get(slot)?.();
    });
    const guard = (e: { url: string; preventDefault(): void }): void => {
      let u: URL;
      try {
        u = new URL(e.url);
      } catch {
        e.preventDefault();
        return;
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return e.preventDefault();
      if (!st.allowPrivate && isPrivateHostName(u.hostname)) return e.preventDefault(); // DNS case: onBeforeRequest
      if (isLoginHop(e.url, st.topUrl, o.loginSignatures)) {
        e.preventDefault();
        st.loginRedirect = e.url;
        notifiers.get(slot)?.();
      }
    };
    wc.on('will-navigate', (e) => guard(e));
    wc.on('will-redirect', (e) => guard(e));
    // The one deliberate main-world call: dialogs become no-ops (§8.2 Dialogs).
    wc.on('dom-ready', () => {
      wc.executeJavaScript(NO_DIALOGS).catch(() => {});
    });
  }

  return {
    async open(slot, st): Promise<RenderWindow> {
      await slotSession(slot); // partition configured before the window uses it
      const win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 2000,
        paintWhenInitiallyHidden: true,
        webPreferences: {
          ...SECURE_WEB_PREFERENCES,
          partition: renderPartition(slot), // pooled, non-persistent, configured in slotSession
          javascript: true,
          images: false,
          webgl: false,
          plugins: false,
          backgroundThrottling: false,
          spellcheck: false,
          // no preload: the page gets no bridge
        },
      });
      const wc = win.webContents;
      st.webContentsId = wc.id;
      lockDown(wc, st, slot);
      const isolated = <T>(code: string): Promise<T> =>
        wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code }]) as Promise<T>;

      return {
        load: (url) =>
          new Promise<LoadResult>((resolve) => {
            const done = (r: LoadResult): void => {
              wc.off('did-finish-load', onFinish);
              wc.off('did-fail-load', onFail);
              notifiers.delete(slot);
              resolve(r);
            };
            const onFinish = (): void => done({ ok: true });
            const onFail = (_e: unknown, code: number, desc: string, _u: string, isMainFrame: boolean): void => {
              if (!isMainFrame || code === -3) return; // ERR_ABORTED: our own navigation block or a client redirect
              done({ ok: false, errorCode: desc || `ERR_${code}` });
            };
            notifiers.set(slot, () => done({ ok: false, errorCode: 'ERR_ABORTED' }));
            wc.on('did-finish-load', onFinish);
            wc.on('did-fail-load', onFail);
            win.loadURL(url, { userAgent: o.userAgent }).catch((err: unknown) => {
              const m = /ERR_[A-Z_]+/.exec(err instanceof Error ? err.message : '');
              if (m && m[0] !== 'ERR_ABORTED') done({ ok: false, errorCode: m[0] });
            });
          }),
        probe: () => isolated<ProbeResult>(PROBE),
        scroll: (toBottom) =>
          isolated<void>(
            toBottom ? 'window.scrollTo(0, document.body ? document.body.scrollHeight : 0)' : 'window.scrollTo(0, 0)',
          ),
        snapshot: (maxBytes) =>
          isolated<string>(`document.documentElement.outerHTML.slice(0, ${Math.floor(maxBytes)})`),
        currentUrl: () => (win.isDestroyed() ? '' : wc.getURL()),
        destroy: () => {
          notifiers.delete(slot);
          if (!win.isDestroyed()) {
            wc.stop();
            win.destroy();
          }
        },
      };
    },
    async reset(slot) {
      const ses = await slotSession(slot);
      await ses.clearStorageData();
      await ses.clearCache();
    },
  };
}
