import { describe, expect, it } from 'vitest';
import { LLMError } from '../../../../src/main/llm/errors';
import { Limiter } from '../../../../src/main/llm/limiter';
import {
  classifyError,
  DEFAULT_RETRY,
  parseRetryAfter,
  retryPolicyFromPipeline,
  withRetry,
} from '../../../../src/main/llm/retry';
import { withTimeouts } from '../../../../src/main/llm/timeouts';
import type { LLMErrorKind } from '../../../../src/main/llm/types';

const apiError = (status: number, message = 'x', headers: Record<string, string> = {}, code?: string): object =>
  Object.assign(new Error(message), { status, headers: new Headers(headers), ...(code ? { code } : {}) });

describe('classifyError (02 §3.1, §7.1 step 1)', () => {
  it.each<[number, string, LLMErrorKind]>([
    [401, 'invalid key', 'auth'],
    [403, 'forbidden', 'auth'],
    [400, 'roles must alternate', 'bad_request'],
    [404, 'model not found', 'bad_request'],
    [400, 'prompt is too long: 250000 tokens > 200000 maximum', 'context_overflow'],
    [413, 'request too large', 'context_overflow'],
    [429, 'slow down', 'rate_limited'],
    [529, 'overloaded', 'overloaded'],
    [503, 'unavailable', 'overloaded'],
    [500, 'boom', 'server'],
    [502, 'bad gateway', 'server'],
    [504, 'gateway timeout', 'server'],
    [408, 'request timeout', 'timeout'],
  ])('HTTP %i (%s) -> %s', (status, msg, kind) => {
    expect(classifyError(apiError(status, msg)).kind).toBe(kind);
  });

  it('uses vendor error codes and SDK/network error shapes', () => {
    expect(classifyError(apiError(400, 'too long', {}, 'context_length_exceeded')).kind).toBe('context_overflow');
    expect(classifyError(Object.assign(new Error('x'), { name: 'APIUserAbortError' })).kind).toBe('cancelled');
    expect(classifyError(Object.assign(new Error('x'), { name: 'APIConnectionTimeoutError' })).kind).toBe('timeout');
    expect(classifyError(Object.assign(new Error('x'), { name: 'APIConnectionError' })).kind).toBe('network');
    expect(classifyError(Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } })).kind).toBe('network');
    expect(classifyError(new TypeError('fetch failed')).kind).toBe('network');
    // A programming error is not retried as a network failure.
    const bug = classifyError(new TypeError("Cannot read properties of undefined (reading 'x')"));
    expect(bug.kind).toBe('bad_request');
    expect(bug.retryable).toBe(false);
    expect(classifyError(new Error('bug')).kind).toBe('bad_request');
    const own = new LLMError('refusal', 'no');
    expect(classifyError(own)).toBe(own);
  });

  it('messages are human readable and never echo the provider body for non-400s', () => {
    const e = classifyError(apiError(401, 'secret-bearing vendor text'), 'Claude');
    expect(e.message).toBe('Claude API key rejected. Check Settings.');
    expect(e.retryable).toBe(false);
    expect(e.status).toBe(401);
  });

  it('parses retry-after-ms, retry-after seconds and HTTP dates', () => {
    expect(classifyError(apiError(429, 'x', { 'retry-after': '3' })).retryAfterMs).toBe(3000);
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '250', 'retry-after': '9' }))).toBe(250);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter({ 'Retry-After': 'Thu, 01 Jan 2026 00:00:10 GMT' }, () => now)).toBe(10_000);
    expect(parseRetryAfter(new Headers())).toBeUndefined();
    expect(parseRetryAfter({ 'retry-after': 'soon' })).toBeUndefined();
  });
});

describe('withRetry (02 §7.1)', () => {
  const sleeper = (): { sleeps: number[]; sleep: (ms: number) => Promise<void> } => {
    const sleeps: number[] = [];
    return { sleeps, sleep: (ms) => (sleeps.push(ms), Promise.resolve()) };
  };

  it('backs off 2 s / 8 s / 30 s with ±20% jitter, then gives up after 3 retries', async () => {
    const s = sleeper();
    let n = 0;
    const e = await withRetry(
      () => {
        n++;
        return Promise.reject(new LLMError('server', 's'));
      },
      DEFAULT_RETRY,
      { sleep: s.sleep, random: () => 1 },
    ).catch((x: unknown) => x);
    expect((e as LLMError).kind).toBe('server');
    expect(n).toBe(4);
    expect(s.sleeps).toEqual([2400, 9600, 36000]);
  });

  it('never retries auth or bad_request', async () => {
    for (const kind of ['auth', 'bad_request', 'context_overflow', 'refusal', 'invalid_output'] as const) {
      const s = sleeper();
      let n = 0;
      await withRetry(() => (n++, Promise.reject(new LLMError(kind, 'k'))), DEFAULT_RETRY, { sleep: s.sleep }).catch(
        () => undefined,
      );
      expect(n).toBe(1);
      expect(s.sleeps).toEqual([]);
    }
  });

  it('uses max(backoff, retry-after) and stops when retry-after exceeds the cap', async () => {
    const s = sleeper();
    const errs = [new LLMError('rate_limited', 'r', 429, 5000), new LLMError('rate_limited', 'r', 429, 500)];
    let i = 0;
    const r = await withRetry(
      () => {
        const e = errs[i++];
        return e ? Promise.reject(e) : Promise.resolve('ok');
      },
      DEFAULT_RETRY,
      { sleep: s.sleep, random: () => 0.5 },
    );
    expect(r).toEqual({ value: 'ok', attempts: 3 });
    expect(s.sleeps).toEqual([5000, 8000]);

    const capped = await withRetry(
      () => Promise.reject(new LLMError('rate_limited', 'r', 429, 121_000)),
      DEFAULT_RETRY,
      {
        sleep: s.sleep,
      },
    ).catch((x: unknown) => x);
    expect((capped as LLMError).kind).toBe('rate_limited');
  });

  it('stops with cancelled when the signal fires during a wait, and reports waits via onRetry', async () => {
    const ac = new AbortController();
    const waits: number[] = [];
    const e = await withRetry(
      () => Promise.reject(new LLMError('network', 'n')),
      { ...DEFAULT_RETRY, backoffMs: [60_000] },
      {
        signal: ac.signal,
        onRetry: (_a, w) => {
          waits.push(w);
          setTimeout(() => ac.abort(), 5);
        },
      },
    ).catch((x: unknown) => x);
    expect((e as LLMError).kind).toBe('cancelled');
    expect(waits).toHaveLength(1);
  });

  it('PipelinePolicy overrides only the numbers (HOOK-PIPE-01)', async () => {
    expect(retryPolicyFromPipeline(undefined)).toBe(DEFAULT_RETRY);
    const p = retryPolicyFromPipeline({
      llmRetryOverride: { maxAttempts: { server: 2 }, baseMs: 100, maxRetryAfterMs: 1000 },
    });
    expect(p.backoffMs).toEqual([100, 400, 1500]);
    expect(p.maxRetryAfterMs).toBe(1000);
    let n = 0;
    await withRetry(() => (n++, Promise.reject(new LLMError('server', 's'))), p, {
      sleep: () => Promise.resolve(),
    }).catch(() => undefined);
    expect(n).toBe(2);
  });
});

describe('Limiter (02 §7.3)', () => {
  const deferred = (): { p: Promise<void>; resolve: () => void } => {
    let resolve = (): void => undefined;
    const p = new Promise<void>((r) => (resolve = r));
    return { p, resolve };
  };

  it('caps concurrency, serves FIFO, and lets interactive work jump the queue', async () => {
    const lim = new Limiter(1);
    const order: string[] = [];
    const gate = deferred();
    const a = lim.run(async () => {
      order.push('a');
      await gate.p;
    });
    const b = lim.run(async () => void order.push('b'));
    const c = lim.run(async () => void order.push('c'), 'interactive');
    expect(lim.running).toBe(1);
    expect(lim.queued).toBe(2);
    gate.resolve();
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'c', 'b']);
  });

  it('pauses all dispatch after a rate limit until the pause ends', async () => {
    const release = deferred();
    const lim = new Limiter(2, () => release.p);
    lim.pauseFor(1000);
    let ran = false;
    const job = lim.run(async () => void (ran = true));
    await Promise.resolve();
    expect(ran).toBe(false);
    expect(lim.paused).toBe(true);
    release.resolve();
    await job;
    expect(ran).toBe(true);
  });

  it('removes queued work when its signal aborts', async () => {
    const lim = new Limiter(1);
    const gate = deferred();
    const a = lim.run(() => gate.p);
    const ac = new AbortController();
    const b = lim.run(() => Promise.resolve('b'), 'normal', ac.signal);
    ac.abort(new LLMError('cancelled', 'c'));
    await expect(b).rejects.toMatchObject({ kind: 'cancelled' });
    expect(lim.queued).toBe(0);
    gate.resolve();
    await a;
  });
});

describe('withTimeouts (02 §7.2)', () => {
  it('total cap fires even while the stream keeps touching', async () => {
    const e = await withTimeouts(undefined, { idleMs: 1000, totalMs: 30 }, ({ signal, touch }) => {
      const t = setInterval(touch, 5);
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => {
          clearInterval(t);
          reject(new Error('sdk abort'));
        }),
      );
    }).catch((x: unknown) => x);
    expect((e as LLMError).kind).toBe('timeout');
    expect((e as LLMError).message).toContain('total');
  });

  it('outer abort becomes cancelled; a fast call is unaffected', async () => {
    const ac = new AbortController();
    const p = withTimeouts(ac.signal, { idleMs: 1000, totalMs: 1000 }, () => new Promise(() => undefined));
    ac.abort();
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
    await expect(withTimeouts(undefined, { idleMs: 50, totalMs: 50 }, () => Promise.resolve(7))).resolves.toBe(7);
  });
});
