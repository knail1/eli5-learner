import { LIMITS, type Limits } from './constants';
import { abortError } from './errors';
import type { FetchSkipCode } from './types';

/**
 * Hidden BrowserWindow fallback orchestration (05 §8): the pooled slot semaphore, the wait
 * strategy, snapshot, watchdog and teardown. The Electron specifics (window, session lockdown,
 * isolated-world probes) live behind `RenderBackend` (render-electron.ts) so this runs under
 * Vitest with a fake renderer.
 */

/** Per-render state read by the slot's session listeners (§8.2). */
export interface RenderState {
  webContentsId: number | null;
  topUrl: string;
  allowPrivate: boolean;
  inflight: Map<number, number>; // request id → start time (webSocket never counted)
  privateCache: Map<string, boolean>;
  blockedPrivate: boolean; // a main-frame request hit the private-address guard
  loginRedirect: string | null; // navigation matched a login pattern (§8.2 Navigation)
  crashed: boolean; // render-process-gone
}

export interface ProbeResult {
  textLength: number;
  nodeCount: number;
  readyState: string;
}

export type LoadResult = { ok: true } | { ok: false; errorCode: string }; // e.g. 'ERR_NAME_NOT_RESOLVED'

/** One hidden window. Every method runs in the isolated world except the backend's dialog override. */
export interface RenderWindow {
  load(url: string): Promise<LoadResult>;
  probe(): Promise<ProbeResult>;
  scroll(toBottom: boolean): Promise<void>;
  snapshot(maxBytes: number): Promise<string>;
  currentUrl(): string;
  /** Idempotent: stop + destroy (never close(), so beforeunload cannot block). */
  destroy(): void;
}

export interface RenderBackend {
  /** Creates the window on the slot's pooled partition (configured once, lazily). */
  open(slot: number, state: RenderState): Promise<RenderWindow>;
  /** clearStorageData + clearCache on the slot's session; a throw marks the slot dirty (§8.4 step 4). */
  reset(slot: number): Promise<void>;
}

export type RenderResult =
  | { ok: true; html: string; finalUrl: string; timedOut: boolean }
  | { ok: false; code: FetchSkipCode; finalUrl?: string };

export interface RenderOptions {
  signal: AbortSignal;
  timeoutMs: number; // RENDER_TIMEOUT_MS capped by the remaining URL budget (§8.3 step 6)
  /** Absolute end of the URL budget (Date.now clock). The hard timeout is re-capped after the pool wait (§8.5). */
  budgetEnd?: number;
  allowPrivate: boolean;
}

export interface SlotPermit {
  slot: number;
  release(dirty: boolean): void;
}

/**
 * MAX_RENDER_WINDOWS pooled partition slots (§8.1, §8.5). Renders queue for a usable slot, not a bare
 * counter, so a retired (dirty) slot shrinks capacity instead of handing out a permit with no slot.
 */
export class RenderPool {
  private readonly free: number[];
  private readonly dirty = new Set<number>();
  private readonly waiters: Array<(slot: number | null) => void> = [];
  private readonly states = new Map<number, RenderState>();

  constructor(readonly size: number = LIMITS.MAX_RENDER_WINDOWS) {
    this.free = Array.from({ length: size }, (_, i) => i);
  }

  get usable(): number {
    return this.size - this.dirty.size;
  }

  /** The active render's state for a slot; session listeners cancel requests when it is absent. */
  state(slot: number): RenderState | undefined {
    return this.states.get(slot);
  }

  attach(slot: number, st: RenderState): void {
    this.states.set(slot, st);
  }

  detach(slot: number): void {
    this.states.delete(slot);
  }

  /** Waits for a usable slot. Resolves null when every slot is dirty (renders then return render-failed). */
  async acquire(signal: AbortSignal): Promise<SlotPermit | null> {
    if (signal.aborted) throw abortError();
    if (this.usable === 0) return null;
    const slot =
      this.free.shift() ??
      (await new Promise<number | null>((resolve, reject) => {
        const w = (s: number | null): void => {
          signal.removeEventListener('abort', onAbort);
          resolve(s);
        };
        const onAbort = (): void => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        this.waiters.push(w);
      }));
    if (slot === null) return null;
    let done = false;
    return {
      slot,
      release: (dirty) => {
        if (done) return;
        done = true;
        this.release(slot, dirty);
      },
    };
  }

  private release(slot: number, dirty: boolean): void {
    if (dirty) {
      this.dirty.add(slot);
      if (this.usable === 0) for (const w of this.waiters.splice(0)) w(null);
      return;
    }
    const w = this.waiters.shift();
    if (w) w(slot);
    else this.free.push(slot);
  }
}

export function newRenderState(url: string, allowPrivate: boolean): RenderState {
  return {
    webContentsId: null,
    topUrl: url,
    allowPrivate,
    inflight: new Map(),
    privateCache: new Map(),
    blockedPrivate: false,
    loginRedirect: null,
    crashed: false,
  };
}

/** did-fail-load error name → skip code (§8.3 step 1). */
export function loadErrorToSkip(errorCode: string): FetchSkipCode {
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/.test(errorCode)) return 'dns-failure';
  if (/ERR_CERT_|ERR_SSL_/.test(errorCode)) return 'tls-error';
  if (/ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT/.test(errorCode)) return 'timeout';
  return 'render-failed';
}

type Raced<T> = { done: true; value: T } | { done: false };

/** Waits for `p` at most `ms`; rejects on abort. A rejected `p` rejects. */
function within<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<Raced<T>> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => finish(() => resolve({ done: false })), Math.max(0, ms));
    const onAbort = (): void => finish(() => reject(abortError()));
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (value) => finish(() => resolve({ done: true, value })),
      (e: unknown) => finish(() => reject(e)),
    );
  });
}

export interface RenderDeps {
  backend: RenderBackend;
  pool: RenderPool;
  limits?: Limits;
  now?: () => number;
}

/** 05 §8.3–8.4. Never throws except AbortError (after teardown). */
export async function renderInHiddenWindow(url: string, opts: RenderOptions, deps: RenderDeps): Promise<RenderResult> {
  const L = deps.limits ?? LIMITS;
  const now = deps.now ?? Date.now;
  const { signal } = opts;
  if (signal.aborted) throw abortError();

  const permit = await deps.pool.acquire(signal); // queued wait counts against the URL budget
  if (!permit) return { ok: false, code: 'render-failed' };
  const start = now();
  let timeoutMs = Math.max(0, opts.timeoutMs);
  if (opts.budgetEnd !== undefined) {
    // §8.5: the queue wait counted against the budget. Re-check what is left, and end the hard timeout
    // early enough that the snapshot's grace also fits before the budget abort (§8.3 steps 6–7).
    const remaining = opts.budgetEnd - start;
    if (remaining < L.RENDER_MIN_BUDGET_MS) {
      permit.release(false);
      return { ok: false, code: 'timeout' };
    }
    timeoutMs = Math.min(timeoutMs, remaining - L.RENDER_WATCHDOG_EXTRA_MS);
  }
  const deadline = start + timeoutMs;
  const left = (): number => deadline - now();
  const state = newRenderState(url, opts.allowPrivate);
  deps.pool.attach(permit.slot, state);
  let win: RenderWindow | null = null;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;

  try {
    win = await deps.backend.open(permit.slot, state);
    const w = win;
    watchdog = setTimeout(() => w.destroy(), timeoutMs + L.RENDER_WATCHDOG_EXTRA_MS);

    const early = (): RenderResult | null => {
      if (state.loginRedirect) return { ok: false, code: 'login-required', finalUrl: state.loginRedirect };
      if (state.blockedPrivate) return { ok: false, code: 'blocked-private-address' };
      if (state.crashed) return { ok: false, code: 'render-failed' };
      return null;
    };

    // Step 1: load.
    let load: Raced<LoadResult>;
    try {
      load = await within(w.load(url), left(), signal);
    } catch (e) {
      if (signal.aborted) throw e;
      load = { done: true, value: { ok: false, errorCode: 'ERR_FAILED' } };
    }
    const stop = early();
    if (stop) return stop;
    if (load.done && !load.value.ok && !/ERR_ABORTED/.test(load.value.errorCode)) {
      return { ok: false, code: loadErrorToSkip(load.value.errorCode) };
    }

    // Steps 2–5: scroll once, then poll until settled or the hard timeout.
    const loadedAt = now();
    let timedOut = !load.done;
    if (!timedOut) {
      await within(
        w.scroll(true).catch(() => {}),
        Math.min(left(), 1_000),
        signal,
      );
    }
    let scrolledBack = false;
    let last: ProbeResult | null = null;
    let changedAt = now();
    let idleSince: number | null = null;
    while (!timedOut) {
      const t = now();
      if (!scrolledBack && t - loadedAt >= L.RENDER_SCROLL_BACK_MS) {
        scrolledBack = true;
        await within(
          w.scroll(false).catch(() => {}),
          Math.min(left(), 1_000),
          signal,
        );
      }
      const probed = await within(w.probe(), left(), signal).catch((e: unknown) => {
        if (signal.aborted) throw e;
        return { done: false } as Raced<ProbeResult>;
      });
      const s = early();
      if (s) return s;
      if (left() <= 0) {
        timedOut = true;
        break;
      }
      if (probed.done) {
        const p = probed.value;
        if (!last || p.textLength !== last.textLength || p.nodeCount !== last.nodeCount) changedAt = now();
        last = p;
      }
      const tt = now();
      const active = [...state.inflight.values()].filter((st) => tt - st < L.RENDER_LONG_POLL_MS).length;
      if (active > 0) idleSince = null;
      else idleSince ??= tt;
      const stableFor = tt - changedAt;
      const settled =
        probed.done &&
        last !== null &&
        ((tt - loadedAt >= L.RENDER_MIN_WAIT_MS &&
          idleSince !== null &&
          tt - idleSince >= L.RENDER_IDLE_MS &&
          stableFor >= L.RENDER_QUIET_MS) ||
          (last.textLength >= L.RENDER_EARLY_EXIT_TEXT && stableFor >= L.RENDER_EARLY_EXIT_MS));
      if (settled) break;
      await within(new Promise<void>((r) => setTimeout(r, L.RENDER_POLL_MS)), left(), signal);
      if (left() <= 0) timedOut = true;
    }

    // Step 7: snapshot (anyway on timeout). A hung renderer is cut off by the watchdog budget.
    const snap = await within(w.snapshot(L.MAX_HTML_BYTES), Math.max(left(), 0) + L.RENDER_WATCHDOG_EXTRA_MS, signal)
      .then((r) => (r.done ? r.value : null))
      .catch((e: unknown) => {
        if (signal.aborted) throw e;
        return null;
      });
    const s2 = early();
    if (s2) return s2;
    if (snap === null) return { ok: false, code: 'render-failed' }; // hung renderer: the watchdog path (§8.2 Dialogs)
    if (timedOut && (last?.textLength ?? 0) === 0 && !/<body[^>]*>[\s\S]*\S[\s\S]*<\/body>/i.test(snap)) {
      return { ok: false, code: 'timeout' };
    }
    let finalUrl = url;
    try {
      finalUrl = w.currentUrl() || url;
    } catch {
      /* destroyed */
    }
    return { ok: true, html: snap, finalUrl, timedOut };
  } finally {
    // §8.4: detach state, destroy, clear the partition, release (always, including abort).
    deps.pool.detach(permit.slot);
    clearTimeout(watchdog);
    try {
      win?.destroy();
    } catch {
      /* already destroyed */
    }
    win = null;
    try {
      await deps.backend.reset(permit.slot);
    } catch {
      dirty = true;
    }
    permit.release(dirty);
  }
}
