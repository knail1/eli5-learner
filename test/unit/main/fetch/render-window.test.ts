import { describe, expect, it } from 'vitest';
import {
  loadErrorToSkip,
  RenderPool,
  renderInHiddenWindow,
  type LoadResult,
  type ProbeResult,
  type RenderBackend,
  type RenderState,
  type RenderWindow,
} from '../../../../src/main/fetch/render-window';
import { testLimits } from './helpers';

/** Orchestration of the hidden-window fallback against a fake renderer (05 §8.3–8.5). */

const L = testLimits({
  RENDER_MIN_WAIT_MS: 60,
  RENDER_QUIET_MS: 40,
  RENDER_POLL_MS: 10,
  RENDER_IDLE_MS: 20,
  RENDER_EARLY_EXIT_MS: 20,
  RENDER_EARLY_EXIT_TEXT: 3000,
  RENDER_SCROLL_BACK_MS: 15,
  RENDER_WATCHDOG_EXTRA_MS: 100,
  RENDER_LONG_POLL_MS: 5000,
});

interface Script {
  load?: () => Promise<LoadResult>;
  probe?: (n: number, st: RenderState) => Promise<ProbeResult>;
  snapshot?: () => Promise<string>;
  onOpen?: (st: RenderState) => void;
  url?: string;
}

class FakeBackend implements RenderBackend {
  opened: number[] = [];
  destroyed = 0;
  resets: number[] = [];
  live = 0;
  maxLive = 0;
  scrolls: boolean[] = [];
  failReset = false;
  constructor(private readonly script: Script = {}) {}

  async open(slot: number, st: RenderState): Promise<RenderWindow> {
    this.opened.push(slot);
    this.live += 1;
    this.maxLive = Math.max(this.maxLive, this.live);
    st.webContentsId = 100 + slot;
    this.script.onOpen?.(st);
    let n = 0;
    let destroyed = false;
    return {
      load: () => this.script.load?.() ?? Promise.resolve({ ok: true }),
      probe: () =>
        this.script.probe?.(n++, st) ?? Promise.resolve({ textLength: 3500, nodeCount: 40, readyState: 'complete' }),
      scroll: async (b) => void this.scrolls.push(b),
      snapshot: () => this.script.snapshot?.() ?? Promise.resolve('<html><body><p>rendered</p></body></html>'),
      currentUrl: () => this.script.url ?? 'https://spa.example.test/app',
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        this.destroyed += 1;
        this.live -= 1;
      },
    };
  }
  async reset(slot: number): Promise<void> {
    this.resets.push(slot);
    if (this.failReset) throw new Error('clear failed');
  }
}

const opts = (o: Partial<{ signal: AbortSignal; timeoutMs: number; allowPrivate: boolean }> = {}) => ({
  signal: new AbortController().signal,
  timeoutMs: 400,
  allowPrivate: false,
  ...o,
});

describe('renderInHiddenWindow', () => {
  it('settles, snapshots via the backend, then destroys the window and clears the slot', async () => {
    const backend = new FakeBackend({ url: 'https://spa.example.test/final' });
    const pool = new RenderPool(2);
    const r = await renderInHiddenWindow('https://spa.example.test/', opts(), { backend, pool, limits: L });
    expect(r).toEqual({
      ok: true,
      html: '<html><body><p>rendered</p></body></html>',
      finalUrl: 'https://spa.example.test/final',
      timedOut: false,
    });
    expect(backend.scrolls).toEqual([true, false]); // scroll to bottom, then back to top
    expect(backend.destroyed).toBe(1);
    expect(backend.resets).toEqual([0]);
    expect(pool.state(0)).toBeUndefined();
  });

  it('waits for the minimum wait, network idle and a quiet DOM', async () => {
    const t0 = Date.now();
    let inflightUntil = 0;
    const backend = new FakeBackend({
      onOpen: (st) => {
        st.inflight.set(1, Date.now());
        inflightUntil = Date.now() + 100;
      },
      probe: async (n, st) => {
        if (Date.now() >= inflightUntil) st.inflight.clear();
        return { textLength: Math.min(n * 100, 800), nodeCount: 30, readyState: 'complete' };
      },
    });
    const r = await renderInHiddenWindow('https://spa.example.test/', opts(), {
      backend,
      pool: new RenderPool(),
      limits: L,
    });
    expect(r.ok && !r.timedOut).toBe(true);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(100 + L.RENDER_IDLE_MS);
    expect(elapsed).toBeLessThan(400);
  });

  it('exits early once 3000+ chars are stable, before the minimum wait', async () => {
    const backend = new FakeBackend({
      onOpen: (st) => st.inflight.set(1, Date.now()), // never idle
    });
    const t0 = Date.now();
    const r = await renderInHiddenWindow('https://spa.example.test/', opts(), {
      backend,
      pool: new RenderPool(),
      limits: L,
    });
    expect(r.ok && !r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(L.RENDER_MIN_WAIT_MS + 30);
  });

  it('a page that never goes network-idle is snapshotted at the hard timeout', async () => {
    const backend = new FakeBackend({
      onOpen: (st) => st.inflight.set(1, Date.now()),
      probe: async () => ({ textLength: 900, nodeCount: 20, readyState: 'complete' }),
    });
    const r = await renderInHiddenWindow('https://spa.example.test/', opts({ timeoutMs: 150 }), {
      backend,
      pool: new RenderPool(),
      limits: L,
    });
    expect(r.ok && r.timedOut).toBe(true);
    expect(backend.destroyed).toBe(1);
  });

  it('timeout with an empty snapshot → timeout', async () => {
    const backend = new FakeBackend({
      onOpen: (st) => st.inflight.set(1, Date.now()),
      probe: async () => ({ textLength: 0, nodeCount: 3, readyState: 'loading' }),
      snapshot: async () => '<html><head></head><body></body></html>',
    });
    const r = await renderInHiddenWindow('https://spa.example.test/', opts({ timeoutMs: 120 }), {
      backend,
      pool: new RenderPool(),
      limits: L,
    });
    expect(r).toEqual({ ok: false, code: 'timeout' });
  });

  it('a hung renderer (probe and snapshot never answer) → render-failed, window still destroyed', async () => {
    const never = new Promise<never>(() => {});
    const backend = new FakeBackend({ probe: () => never, snapshot: () => never });
    const r = await renderInHiddenWindow('https://spa.example.test/', opts({ timeoutMs: 100 }), {
      backend,
      pool: new RenderPool(),
      limits: L,
    });
    expect(r).toEqual({ ok: false, code: 'render-failed' });
    expect(backend.destroyed).toBe(1);
    expect(backend.resets).toEqual([0]);
  });

  it('maps main-frame load failures', async () => {
    const backend = new FakeBackend({ load: async () => ({ ok: false, errorCode: 'ERR_NAME_NOT_RESOLVED' }) });
    const r = await renderInHiddenWindow('https://nx.example.test/', opts(), {
      backend,
      pool: new RenderPool(),
      limits: L,
    });
    expect(r).toEqual({ ok: false, code: 'dns-failure' });
    expect(loadErrorToSkip('ERR_CERT_AUTHORITY_INVALID')).toBe('tls-error');
    expect(loadErrorToSkip('ERR_TIMED_OUT')).toBe('timeout');
    expect(loadErrorToSkip('ERR_FAILED')).toBe('render-failed');
  });

  it('a login navigation or a private main-frame target ends the render', async () => {
    const login = new FakeBackend({
      load: async () => ({ ok: false, errorCode: 'ERR_ABORTED' }),
      onOpen: (st) => (st.loginRedirect = 'https://sso.example.test/login'),
    });
    expect(
      await renderInHiddenWindow('https://a.example.test/', opts(), {
        backend: login,
        pool: new RenderPool(),
        limits: L,
      }),
    ).toEqual({ ok: false, code: 'login-required', finalUrl: 'https://sso.example.test/login' });
    const priv = new FakeBackend({ onOpen: (st) => (st.blockedPrivate = true) });
    expect(
      await renderInHiddenWindow('https://a.example.test/', opts(), {
        backend: priv,
        pool: new RenderPool(),
        limits: L,
      }),
    ).toEqual({
      ok: false,
      code: 'blocked-private-address',
    });
    const crash = new FakeBackend({
      probe: async (_n, st) => ((st.crashed = true), { textLength: 0, nodeCount: 0, readyState: '' }),
    });
    expect(
      await renderInHiddenWindow('https://a.example.test/', opts(), {
        backend: crash,
        pool: new RenderPool(),
        limits: L,
      }),
    ).toEqual({
      ok: false,
      code: 'render-failed',
    });
  });

  it('abort tears down (destroy + clear) and then rethrows AbortError', async () => {
    const backend = new FakeBackend({
      onOpen: (st) => st.inflight.set(1, Date.now()),
      probe: async () => ({ textLength: 10, nodeCount: 5, readyState: 'complete' }),
    });
    const ac = new AbortController();
    const p = renderInHiddenWindow('https://a.example.test/', opts({ signal: ac.signal }), {
      backend,
      pool: new RenderPool(),
      limits: L,
    });
    setTimeout(() => ac.abort(), 30);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(backend.destroyed).toBe(1);
    expect(backend.resets).toEqual([0]);
  });

  it('never runs more than 2 windows; many renders reuse only slots 0 and 1', async () => {
    const backend = new FakeBackend();
    const pool = new RenderPool(2);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        renderInHiddenWindow(`https://s${i}.example.test/`, opts(), { backend, pool, limits: L }),
      ),
    );
    expect(backend.maxLive).toBeLessThanOrEqual(2);
    expect(new Set(backend.opened)).toEqual(new Set([0, 1]));
    expect(backend.resets).toHaveLength(12);
    expect(backend.destroyed).toBe(12);
  });

  it('a slot whose clear fails is retired; with no usable slots renders fail fast', async () => {
    const backend = new FakeBackend();
    backend.failReset = true;
    const pool = new RenderPool(1);
    const first = await renderInHiddenWindow('https://a.example.test/', opts(), { backend, pool, limits: L });
    expect(first.ok).toBe(true);
    expect(pool.usable).toBe(0);
    const second = await renderInHiddenWindow('https://b.example.test/', opts(), { backend, pool, limits: L });
    expect(second).toEqual({ ok: false, code: 'render-failed' });
    expect(backend.opened).toEqual([0]);
  });
});
