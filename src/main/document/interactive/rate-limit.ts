// Sliding-window rate limit (08 §6.1 step 1a): at most 10 section actions per minute per document.

export const SECTION_ACTIONS_PER_MINUTE = 10;
export const RATE_WINDOW_MS = 60_000;

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(o: { max?: number; windowMs?: number; now?: () => number } = {}) {
    this.max = o.max ?? SECTION_ACTIONS_PER_MINUTE;
    this.windowMs = o.windowMs ?? RATE_WINDOW_MS;
    this.now = o.now ?? Date.now;
  }

  /** Counts one request for `key`; false when the window is already full. */
  take(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }

  /** Gives back the latest slot of a request that was refused later (only accepted requests count). */
  refund(key: string): void {
    this.hits.get(key)?.pop();
  }
}
