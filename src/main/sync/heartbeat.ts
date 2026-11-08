/**
 * Heartbeat (16 §4.3): a metadata-only `touch(deviceFile, {seen})` every 5 minutes while the app
 * runs (window or menu bar). A metadata update creates no revision and keeps the change feed small.
 * The phone shows "Your Mac was last seen <relative time>" from the newest primary `seen`.
 */
import { log } from '../security';
import type { SyncStore } from './types';

export const HEARTBEAT_MS = 5 * 60 * 1000;

export interface HeartbeatTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface HeartbeatDeps {
  /** The store and this device's own device file, or null while sync is not running. */
  target(): { store: Pick<SyncStore, 'touch'>; fileId: string } | null;
  now(): number;
  intervalMs?: number;
  timers?: HeartbeatTimers;
}

const realTimers: HeartbeatTimers = {
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    return t;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/** `seen` is epoch seconds (16 §4.3). */
export function seenNow(nowMs: number): number {
  return Math.floor(nowMs / 1000);
}

export class Heartbeat {
  private handle: unknown;
  private inflight: Promise<void> | undefined;

  constructor(private readonly deps: HeartbeatDeps) {}

  get running(): boolean {
    return this.handle !== undefined;
  }

  /** Starts the timer (idempotent). The first beat is the caller's: the engine writes on start. */
  start(): void {
    if (this.handle !== undefined) return;
    const timers = this.deps.timers ?? realTimers;
    this.handle = timers.setInterval(() => void this.beat(), this.deps.intervalMs ?? HEARTBEAT_MS);
  }

  stop(): void {
    if (this.handle === undefined) return;
    (this.deps.timers ?? realTimers).clearInterval(this.handle);
    this.handle = undefined;
  }

  /** One heartbeat now. Never rejects; a failure is logged and the next beat tries again. */
  beat(): Promise<void> {
    if (this.inflight) return this.inflight;
    const t = this.deps.target();
    if (!t) return Promise.resolve();
    this.inflight = t.store
      .touch(t.fileId, { seen: seenNow(this.deps.now()) })
      .catch((err: unknown) => {
        log.warn('sync.heartbeat-failed', { code: (err as { code?: string }).code ?? 'unknown' });
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
}
