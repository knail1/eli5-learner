import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadabilityPool, ReadabilityTimeout, type WorkerLike } from '../../../../src/main/fetch/readability';
import { runReadability, type ReadabilityJob } from '../../../../src/main/fetch/readability-core';

/** A fake thread that runs the real core asynchronously, or hangs when told to (05 §5.2). */
class FakeWorker extends EventEmitter implements WorkerLike {
  static all: FakeWorker[] = [];
  terminated = false;
  constructor(private readonly hang: (job: ReadabilityJob) => boolean) {
    super();
    FakeWorker.all.push(this);
  }
  postMessage(msg: unknown): void {
    const { id, job } = msg as { id: number; job: ReadabilityJob };
    if (this.hang(job)) return;
    setTimeout(() => {
      if (!this.terminated) this.emit('message', { id, ok: true, result: runReadability(job) });
    }, 5);
  }
  terminate(): void {
    this.terminated = true;
  }
}

afterEach(() => {
  FakeWorker.all = [];
  vi.useRealTimers();
});

const job = (text: string): ReadabilityJob => ({
  html: `<html><head><title>${text}</title></head><body><p>${text}</p></body></html>`,
  url: 'https://site.example/',
});

describe('ReadabilityPool', () => {
  it('starts workers lazily, never more than the pool size, and runs queued jobs', async () => {
    const pool = new ReadabilityPool({ createWorker: () => new FakeWorker(() => false), size: 2 });
    expect(pool.workerCount).toBe(0);
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((t) => pool.run(job(t))));
    expect(results.map((r) => r.signals.titleText)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(FakeWorker.all.length).toBe(2);
    await pool.close();
  });

  it('terminates and replaces a worker whose job exceeds the timeout', async () => {
    const pool = new ReadabilityPool({
      createWorker: () => new FakeWorker((j) => j.html.includes('HANG')),
      size: 1,
      timeoutMs: 30,
    });
    await expect(pool.run(job('HANG'))).rejects.toBeInstanceOf(ReadabilityTimeout);
    expect(FakeWorker.all[0]!.terminated).toBe(true);
    const ok = await pool.run(job('after'));
    expect(ok.signals.titleText).toBe('after');
    expect(FakeWorker.all.length).toBe(2);
    await pool.close();
  });

  it('terminates idle workers after idleMs', async () => {
    const pool = new ReadabilityPool({ createWorker: () => new FakeWorker(() => false), idleMs: 20 });
    await pool.run(job('x'));
    expect(pool.workerCount).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(pool.workerCount).toBe(0);
    expect(FakeWorker.all[0]!.terminated).toBe(true);
  });

  it('rejects with AbortError on abort and replaces a busy worker', async () => {
    const pool = new ReadabilityPool({ createWorker: () => new FakeWorker(() => true), size: 1 });
    const ac = new AbortController();
    const p = pool.run(job('x'), ac.signal);
    const queued = pool.run(job('y'), ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.all[0]!.terminated).toBe(true);
    await pool.close();
  });

  it('a crashed worker rejects its job and is replaced', async () => {
    const pool = new ReadabilityPool({ createWorker: () => new FakeWorker((j) => j.html.includes('CRASH')), size: 1 });
    const p = pool.run(job('CRASH'));
    FakeWorker.all[0]!.emit('error', new Error('boom'));
    await expect(p).rejects.toMatchObject({ name: 'ReadabilityFailed' });
    await expect(pool.run(job('ok'))).resolves.toBeTruthy();
    await pool.close();
  });
});
