import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostKey, Politeness, Semaphore, sleep } from '../../../../src/main/fetch/politeness';

/** 05 §9 scheduling, with fake timers. */

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('hostKey', () => {
  it('groups by registrable domain using the public suffix list', () => {
    expect(hostKey('https://a.example.co.uk/x')).toBe('example.co.uk');
    expect(hostKey('https://b.example.co.uk/y')).toBe('example.co.uk');
    expect(hostKey('https://news.example.com/')).toBe('example.com');
    expect(hostKey('http://127.0.0.1:8080/')).toBe('127.0.0.1');
    expect(hostKey('http://localhost:3000/')).toBe('localhost');
  });
});

describe('Politeness', () => {
  it('allows one fetch per registrable domain at a time', async () => {
    const p = new Politeness();
    const a = await p.acquire('https://a.example.com/1');
    let second = false;
    const b = p.acquire('https://b.example.com/2').then((s) => {
      second = true;
      return s;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toBe(false);
    a.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toBe(true);
    (await b).release();
  });

  it('caps global concurrency at 4', async () => {
    const p = new Politeness();
    const slots = await Promise.all([1, 2, 3, 4].map((i) => p.acquire(`https://site${i}.example/`)));
    expect(p.activeGlobal).toBe(4);
    let fifth = false;
    const f = p.acquire('https://site5.example/').then((s) => {
      fifth = true;
      return s;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fifth).toBe(false);
    slots[0]!.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(fifth).toBe(true);
    for (const s of slots.slice(1)) s.release();
    (await f).release();
  });

  it('spaces request starts on the same host by at least 1 s', async () => {
    const p = new Politeness();
    const starts: number[] = [];
    const s1 = await p.acquire('https://x.example/a');
    await s1.beforeRequest();
    starts.push(Date.now());
    s1.release();
    const s2 = await p.acquire('https://x.example/b');
    const pending = s2.beforeRequest().then(() => starts.push(Date.now()));
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1000);
    // Different host: no wait.
    const s3 = await p.acquire('https://y.example/a');
    await s3.beforeRequest();
    s2.release();
    s3.release();
  });

  it('an aborted wait leaves no permit behind', async () => {
    const p = new Politeness();
    const a = await p.acquire('https://x.example/');
    const ac = new AbortController();
    const b = p.acquire('https://x.example/', ac.signal);
    ac.abort();
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
    a.release();
    const c = await p.acquire('https://x.example/');
    c.release();
  });
});

describe('Semaphore and sleep', () => {
  it('release is idempotent', async () => {
    const s = new Semaphore(1);
    const r = await s.acquire();
    r();
    r();
    expect(s.inUse).toBe(0);
  });

  it('sleep rejects on abort', async () => {
    const ac = new AbortController();
    const p = sleep(10_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
