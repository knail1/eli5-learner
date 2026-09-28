/**
 * Per-provider concurrency limiter (02 §7.3): FIFO with a priority lane for viewer section actions,
 * and a provider-wide pause after a rate_limited response so parallel chunks do not stampede.
 */
export type LimiterPriority = 'interactive' | 'normal';

interface Waiter {
  start: () => void;
}

export class Limiter {
  private active = 0;
  private readonly high: Waiter[] = [];
  private readonly normal: Waiter[] = [];
  private pauses = 0;

  constructor(
    private max: number,
    /** Injected for tests; resolves after `ms`. */
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.high.length + this.normal.length;
  }

  setMaxConcurrency(n: number): void {
    this.max = Math.max(1, n);
    this.pump();
  }

  get paused(): boolean {
    return this.pauses > 0;
  }

  /** Pause new dispatches for `ms`; overlapping pauses last until the longest one ends. */
  pauseFor(ms: number): void {
    this.pauses++;
    void this.sleep(ms).then(() => {
      this.pauses--;
      this.pump();
    });
  }

  run<T>(fn: () => Promise<T>, priority: LimiterPriority = 'normal', signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        start: () => {
          signal?.removeEventListener('abort', onAbort);
          this.active++;
          fn()
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              this.pump();
            });
        },
      };
      const onAbort = (): void => {
        const q = priority === 'interactive' ? this.high : this.normal;
        const i = q.indexOf(waiter);
        if (i >= 0) q.splice(i, 1);
        reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      (priority === 'interactive' ? this.high : this.normal).push(waiter);
      this.pump();
    });
  }

  private pump(): void {
    if (this.pauses > 0) return;
    while (this.active < this.max) {
      const next = this.high.shift() ?? this.normal.shift();
      if (!next) return;
      next.start();
    }
  }
}
