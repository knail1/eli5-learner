import { getDomain } from 'tldts';
import { LIMITS } from './constants';
import { abortError } from './errors';

/** Per-host and global concurrency plus per-host spacing (05 §9). */

export type Release = () => void;

/** Abortable sleep; rejects with AbortError. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** FIFO counting semaphore with abortable waits. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<{ grant: () => void }> = [];

  constructor(private readonly max: number) {}

  get inUse(): number {
    return this.active;
  }
  get waiting(): number {
    return this.waiters.length;
  }

  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise<Release>((resolve, reject) => {
      const w = {
        grant: (): void => {
          signal?.removeEventListener('abort', onAbort);
          this.active += 1;
          resolve(this.releaser());
        },
      };
      const onAbort = (): void => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(w);
    });
  }

  private releaser(): Release {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active -= 1;
      this.waiters.shift()?.grant();
    };
  }
}

/** Registrable domain via the public suffix list (tldts); IPs and single labels are their own key. */
export function hostKey(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return url;
  }
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

export interface PolitenessOptions {
  maxGlobal?: number;
  hostIntervalMs?: number;
  now?: () => number;
}

export interface PoliteSlot {
  /** Waits until HOST_MIN_INTERVAL_MS has passed since the host's last request start, then records a start. */
  beforeRequest(signal?: AbortSignal): Promise<void>;
  release: Release;
}

export class Politeness {
  private readonly global: Semaphore;
  private readonly hosts = new Map<string, Semaphore>();
  private readonly lastStart = new Map<string, number>();
  private readonly interval: number;
  private readonly now: () => number;

  constructor(opts: PolitenessOptions = {}) {
    this.global = new Semaphore(opts.maxGlobal ?? LIMITS.MAX_GLOBAL_FETCHES);
    this.interval = opts.hostIntervalMs ?? LIMITS.HOST_MIN_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
  }

  get activeGlobal(): number {
    return this.global.inUse;
  }

  /** One per-host permit (1 per registrable domain), then one global permit (4). */
  async acquire(url: string, signal?: AbortSignal): Promise<PoliteSlot> {
    const key = hostKey(url);
    let host = this.hosts.get(key);
    if (!host) {
      host = new Semaphore(1);
      this.hosts.set(key, host);
    }
    const releaseHost = await host.acquire(signal);
    let releaseGlobal: Release;
    try {
      releaseGlobal = await this.global.acquire(signal);
    } catch (e) {
      releaseHost();
      throw e;
    }
    const h = host;
    return {
      beforeRequest: async (sig) => {
        const last = this.lastStart.get(key);
        const wait = last === undefined ? 0 : last + this.interval - this.now();
        if (wait > 0) await sleep(wait, sig);
        this.lastStart.set(key, this.now());
      },
      release: () => {
        releaseGlobal();
        releaseHost();
        if (h.inUse === 0 && h.waiting === 0) this.hosts.delete(key);
      },
    };
  }
}
