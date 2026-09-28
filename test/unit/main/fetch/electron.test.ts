import { EventEmitter } from 'node:events';
import type { Session } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Electron adapters with a mocked `electron` module: the net.request transport (05 §4.2, §4.4) and
 * the hidden-window lockdown (§8.1–8.2). The real behavior is covered by the Playwright suite.
 */

/**
 * Models Electron's manual-redirect contract (electron.d.ts, ClientRequest `redirect`):
 * followRedirect() is accepted only synchronously during the 'redirect' emit; otherwise the
 * redirect is cancelled with an error once the emit returns.
 */
class FakeRequest extends EventEmitter {
  headers: Record<string, string> = {};
  followed = 0;
  aborted = false;
  ended = false;
  private inRedirect = false;
  constructor(readonly opts: Record<string, unknown>) {
    super();
  }
  setHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event !== 'redirect') return super.emit(event, ...args);
    this.inRedirect = true;
    const before = this.followed;
    try {
      return super.emit(event, ...args);
    } finally {
      this.inRedirect = false;
      if (this.followed === before) {
        const wasAborted = this.aborted;
        this.aborted = true;
        if (!wasAborted) super.emit('error', new Error('Redirect was cancelled'));
      }
    }
  }
  followRedirect() {
    if (!this.inRedirect) throw new Error('followRedirect() called, but was not waiting for a redirect');
    this.followed += 1;
  }
  abort() {
    this.aborted = true;
  }
  end() {
    this.ended = true;
  }
}

class FakeWebContents extends EventEmitter {
  static nextId = 1;
  id = FakeWebContents.nextId++;
  ua = '';
  muted = false;
  openHandler: (() => unknown) | null = null;
  url = '';
  stopped = false;
  isolated: string[] = [];
  mainWorld: string[] = [];
  setUserAgent(ua: string) {
    this.ua = ua;
  }
  setAudioMuted(m: boolean) {
    this.muted = m;
  }
  setWindowOpenHandler(h: () => unknown) {
    this.openHandler = h;
  }
  getURL() {
    return this.url;
  }
  stop() {
    this.stopped = true;
  }
  async executeJavaScript(code: string) {
    this.mainWorld.push(code);
  }
  async executeJavaScriptInIsolatedWorld(_w: number, scripts: Array<{ code: string }>) {
    this.isolated.push(scripts[0]!.code);
    return 'snap';
  }
}

class FakeBrowserWindow {
  static created: FakeBrowserWindow[] = [];
  webContents = new FakeWebContents();
  destroyed = false;
  loaded: string[] = [];
  constructor(readonly options: Record<string, unknown>) {
    FakeBrowserWindow.created.push(this);
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
  }
  async loadURL(url: string) {
    this.loaded.push(url);
    this.webContents.url = url;
    setTimeout(() => this.webContents.emit('did-finish-load'), 1);
  }
}

type BeforeRequest = (d: Record<string, unknown>, cb: (r: { cancel?: boolean }) => void) => void;
class FakeSession extends EventEmitter {
  beforeRequest: BeforeRequest | null = null;
  cleared: unknown[] = [];
  cacheCleared = 0;
  webRequest = {
    onBeforeRequest: (fn: BeforeRequest) => (this.beforeRequest = fn),
    onCompleted: () => {},
    onErrorOccurred: () => {},
  };
  setPermissionRequestHandler = vi.fn();
  setPermissionCheckHandler = vi.fn();
  setProxy = vi.fn(async () => {});
  getUserAgent = () => 'Mozilla/5.0 Chrome';
  async clearStorageData(o?: unknown) {
    this.cleared.push(o);
  }
  async clearCache() {
    this.cacheCleared += 1;
  }
}

const sessions = new Map<string, FakeSession>();
const requests: FakeRequest[] = [];

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0', getPreferredSystemLanguages: () => ['en-US'], on: vi.fn() },
  net: {
    request: (o: Record<string, unknown>) => {
      const r = new FakeRequest(o);
      requests.push(r);
      return r;
    },
  },
  session: {
    fromPartition: (p: string, o?: unknown) => {
      let s = sessions.get(p);
      if (!s) {
        s = new FakeSession();
        (s as unknown as { opts: unknown }).opts = o;
        sessions.set(p, s);
      }
      return s;
    },
  },
  shell: { openExternal: vi.fn() },
  BrowserWindow: FakeBrowserWindow,
}));

// The ?nodeWorker import only resolves under electron-vite.
vi.mock('../../../../src/main/fetch/readability-thread', () => ({ createThreadPool: vi.fn() }));

const { electronTransport } = await import('../../../../src/main/fetch/electron');
const { createElectronRenderBackend } = await import('../../../../src/main/fetch/render-electron');
const { RenderPool, newRenderState } = await import('../../../../src/main/fetch/render-window');

beforeEach(() => {
  requests.length = 0;
  sessions.clear();
  FakeBrowserWindow.created = [];
});

describe('electronTransport (05 §4.2)', () => {
  it('uses net.request with redirect: manual; each approved hop is a new request (async checks)', async () => {
    const ses = new FakeSession() as unknown as Session;
    const hops: string[] = [];
    const p = electronTransport(ses).request({
      url: 'https://a.example.test/',
      headers: { 'User-Agent': 'UA', DNT: '1' },
      signal: new AbortController().signal,
      onRedirect: async (h) => {
        await new Promise((r) => setTimeout(r, 5)); // like the DNS lookup in checkHop
        hops.push(h.redirectUrl);
        return true;
      },
    });
    const req = requests[0]!;
    expect(req.opts).toMatchObject({ method: 'GET', redirect: 'manual', session: ses, useSessionCookies: true });
    expect(req.headers).toEqual({ 'User-Agent': 'UA', DNT: '1' });
    expect(req.ended).toBe(true);
    req.emit('redirect', 302, 'GET', 'https://b.example.test/next', {});
    expect(req.aborted).toBe(true); // stopped synchronously, never followed late
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const req2 = requests[1]!;
    expect(req2.opts).toMatchObject({ url: 'https://b.example.test/next', redirect: 'manual', session: ses });
    expect(req2.headers).toEqual({ 'User-Agent': 'UA', DNT: '1' });
    const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string[]> };
    res.statusCode = 200;
    res.headers = { 'Content-Type': ['text/html'] };
    req2.emit('response', res);
    const out = await p;
    expect(out).toMatchObject({
      url: 'https://b.example.test/next',
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    const chunks: string[] = [];
    const reading = (async () => {
      for await (const c of out.body) chunks.push(Buffer.from(c).toString());
    })();
    res.emit('data', Buffer.from('<p>'));
    res.emit('data', Buffer.from('hi</p>'));
    res.emit('end');
    await reading;
    expect(chunks.join('')).toBe('<p>hi</p>');
    expect(hops).toEqual(['https://b.example.test/next']);
    expect(req2.aborted).toBe(false);
  });

  it('stopping the body early cancels the request and detaches listeners (§4.5)', async () => {
    const p = electronTransport(new FakeSession() as unknown as Session).request({
      url: 'https://a.example.test/big.mp4',
      headers: {},
      signal: new AbortController().signal,
      onRedirect: async () => true,
    });
    const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string[]> };
    res.statusCode = 200;
    res.headers = {};
    requests[0]!.emit('response', res);
    const out = await p;
    const it = out.body[Symbol.asyncIterator]();
    await it.return?.(); // never started: must still cancel
    expect(requests[0]!.aborted).toBe(true);
    expect(res.listenerCount('data')).toBe(0);
  });

  it('aborts the request when a hop is refused', async () => {
    const p = electronTransport(new FakeSession() as unknown as Session).request({
      url: 'https://a.example.test/',
      headers: {},
      signal: new AbortController().signal,
      onRedirect: async () => false,
    });
    requests[0]!.emit('redirect', 302, 'GET', 'http://127.0.0.1/', {});
    await expect(p).rejects.toMatchObject({ name: 'RedirectStopped' });
    expect(requests[0]!.aborted).toBe(true);
  });

  it('maps net errors', async () => {
    const p = electronTransport(new FakeSession() as unknown as Session).request({
      url: 'https://a.example.test/',
      headers: {},
      signal: new AbortController().signal,
      onRedirect: async () => true,
    });
    requests[0]!.emit('error', new Error('net::ERR_NAME_NOT_RESOLVED'));
    await expect(p).rejects.toMatchObject({ name: 'TransportError', kind: 'dns' });
  });
});

describe('Electron render backend lockdown (05 §8.1–8.2)', () => {
  function setup(sigs = [] as Array<{ urlPattern?: RegExp; kind: 'strong' | 'conclusive' }>) {
    const pool = new RenderPool(2);
    const configureSession = vi.fn(async () => {});
    const backend = createElectronRenderBackend({
      pool,
      configureSession,
      userAgent: 'UA ELI5Learner/0.1.0',
      lookup: async (h) => (h === 'lan.example.test' ? ['192.168.1.5'] : ['203.0.113.9']),
      loginSignatures: sigs,
    });
    return { pool, backend, configureSession };
  }

  it('creates a locked-down hidden window on the pooled partition', async () => {
    const { pool, backend, configureSession } = setup();
    const st = newRenderState('https://a.example.test/', false);
    pool.attach(1, st);
    const win = await backend.open(1, st);
    const bw = FakeBrowserWindow.created[0]!;
    const wp = bw.options.webPreferences as Record<string, unknown>;
    expect(bw.options).toMatchObject({ show: false, width: 1280, height: 2000, paintWhenInitiallyHidden: true });
    expect(wp).toMatchObject({
      partition: 'eli5-render-1',
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      javascript: true,
      images: false,
      webgl: false,
      plugins: false,
      backgroundThrottling: false,
    });
    expect(wp.preload).toBeUndefined();
    expect(sessions.get('eli5-render-1')).toBeDefined();
    expect((sessions.get('eli5-render-1') as unknown as { opts: unknown }).opts).toEqual({ cache: false });
    expect(configureSession).toHaveBeenCalledOnce();
    const wc = bw.webContents;
    expect(wc.muted).toBe(true);
    expect(wc.ua).toBe('UA ELI5Learner/0.1.0');
    expect(wc.openHandler?.()).toEqual({ action: 'deny' });
    expect(st.webContentsId).toBe(wc.id);

    // Load, probe and snapshot go through the isolated world; only the dialog override is main-world.
    expect(await win.load('https://a.example.test/')).toEqual({ ok: true });
    wc.emit('dom-ready');
    await win.probe();
    await win.snapshot(100);
    expect(wc.isolated.some((c) => c.includes('innerText.length'))).toBe(true);
    expect(wc.isolated.some((c) => c.includes('outerHTML.slice(0, 100)'))).toBe(true);
    expect(wc.mainWorld).toEqual([
      'window.alert = () => undefined; window.confirm = () => false; window.prompt = () => null;',
    ]);

    win.destroy();
    expect(bw.destroyed && wc.stopped).toBe(true);
    await backend.reset(1);
    const ses = sessions.get('eli5-render-1')!;
    expect(ses.cleared).toEqual([undefined]);
    expect(ses.cacheCleared).toBe(1);
  });

  it('one combined onBeforeRequest blocks other contents, heavy types and private targets', async () => {
    const { pool, backend } = setup();
    const st = newRenderState('https://a.example.test/', false);
    pool.attach(0, st);
    await backend.open(0, st);
    const ses = sessions.get('eli5-render-0')!;
    const ask = (d: Record<string, unknown>) =>
      new Promise<{ cancel?: boolean }>((resolve) =>
        ses.beforeRequest!({ id: 1, webContentsId: st.webContentsId, ...d }, resolve),
      );

    expect(await ask({ url: 'https://a.example.test/app.js', resourceType: 'script' })).toEqual({});
    expect(st.inflight.size).toBe(1);
    for (const t of ['image', 'font', 'media', 'object', 'ping', 'cspReport']) {
      expect(await ask({ url: 'https://a.example.test/x', resourceType: t })).toEqual({ cancel: true });
    }
    expect(await ask({ url: 'https://a.example.test/x', resourceType: 'xhr', webContentsId: 9999 })).toEqual({
      cancel: true,
    });
    expect(await ask({ url: 'http://127.0.0.1:8080/admin', resourceType: 'xhr' })).toEqual({ cancel: true });
    expect(await ask({ url: 'http://printer.local/', resourceType: 'subFrame' })).toEqual({ cancel: true });
    expect(await ask({ url: 'https://lan.example.test/', resourceType: 'fetch' })).toEqual({ cancel: true });
    expect(st.blockedPrivate).toBe(false);
    expect(await ask({ url: 'https://lan.example.test/', resourceType: 'mainFrame' })).toEqual({ cancel: true });
    expect(st.blockedPrivate).toBe(true);
    pool.detach(0);
    expect(await ask({ url: 'https://a.example.test/late.js', resourceType: 'script' })).toEqual({ cancel: true });
  });

  it('a user-typed private URL allows private subrequests', async () => {
    const { pool, backend } = setup();
    const st = newRenderState('http://127.0.0.1:5173/', true);
    pool.attach(0, st);
    await backend.open(0, st);
    const ses = sessions.get('eli5-render-0')!;
    const r = await new Promise((resolve) =>
      ses.beforeRequest!(
        { id: 2, webContentsId: st.webContentsId, url: 'http://127.0.0.1:5173/api', resourceType: 'xhr' },
        resolve,
      ),
    );
    expect(r).toEqual({});
  });

  it('navigation guard: non-http blocked, login pattern ends the render', async () => {
    const { pool, backend } = setup();
    const st = newRenderState('https://a.example.test/', false);
    pool.attach(0, st);
    const win = await backend.open(0, st);
    const wc = FakeBrowserWindow.created[0]!.webContents;
    const nav = (url: string) => {
      const e = {
        url,
        prevented: false,
        preventDefault() {
          this.prevented = true;
        },
      };
      wc.emit('will-navigate', e);
      return e.prevented;
    };
    expect(nav('https://a.example.test/page2')).toBe(false);
    expect(nav('file:///etc/hosts')).toBe(true);
    expect(nav('http://localhost:3000/')).toBe(true);
    const pending = win.load('https://a.example.test/'); // resolves early once the guard fires
    expect(nav('https://a.example.test/login?next=%2F')).toBe(true);
    expect(st.loginRedirect).toBe('https://a.example.test/login?next=%2F');
    expect(await pending).toEqual({ ok: false, errorCode: 'ERR_ABORTED' });
  });
});
