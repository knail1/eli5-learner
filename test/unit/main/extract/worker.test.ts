/**
 * Extract worker isolation (04 §10.4): the host against a fake process, and the real worker loop
 * wired in-process. A crash or a stuck parse fails one source; the next source gets a fresh worker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EXTRACT_LIMITS,
  ExtractWorkerHost,
  JobImageBudget,
  type ExtractResult,
  type Extractor,
  type ForkWorker,
  type WorkerProcess,
} from '../../../../src/main/extract';
import { newContent } from '../../../../src/main/extract/text-util';
import type { HostToWorker, WorkerToHost } from '../../../../src/main/extract/worker-protocol';
import { runWorker } from '../../../../src/main/extract/worker-runtime';
import { fakeServices, fixtureSource, textSource } from '../../../contracts/extractor.contract';

afterEach(() => {
  vi.useRealTimers();
});

/** A WorkerProcess that runs the real worker loop in-process (messages cloned like postMessage). */
function inProcessFork(extractors?: readonly Extractor[]): { fork: ForkWorker; forks: () => number } {
  let forks = 0;
  const fork: ForkWorker = () => {
    forks++;
    let toHost: (m: unknown) => void = () => undefined;
    let toWorker: (m: unknown) => void = () => undefined;
    let dead = false;
    runWorker(
      {
        postMessage: (m: WorkerToHost) => queueMicrotask(() => !dead && toHost(structuredClone(m))),
        onMessage: (cb) => {
          toWorker = cb;
        },
      },
      extractors,
    );
    return {
      postMessage: (m: HostToWorker) => queueMicrotask(() => !dead && toWorker(structuredClone(m))),
      onMessage: (cb) => {
        toHost = cb;
      },
      onExit: () => undefined,
      kill: () => {
        dead = true;
      },
    };
  };
  return { fork, forks: () => forks };
}

/** A scripted fake process for crash and hang cases. */
class FakeProcess implements WorkerProcess {
  sent: HostToWorker[] = [];
  killed = false;
  private msg: (m: unknown) => void = () => undefined;
  private exit: (c: number) => void = () => undefined;
  constructor(private readonly behave: (p: FakeProcess, m: HostToWorker) => void) {}
  postMessage(m: HostToWorker): void {
    this.sent.push(m);
    this.behave(this, m);
  }
  onMessage(cb: (m: unknown) => void): void {
    this.msg = cb;
  }
  onExit(cb: (c: number) => void): void {
    this.exit = cb;
  }
  kill(): void {
    this.killed = true;
  }
  reply(m: WorkerToHost): void {
    this.msg(m);
  }
  die(code: number): void {
    this.exit(code);
  }
}

const opts = (): { signal: AbortSignal; limits: typeof DEFAULT_EXTRACT_LIMITS; budget: JobImageBudget } => ({
  signal: new AbortController().signal,
  limits: DEFAULT_EXTRACT_LIMITS,
  budget: new JobImageBudget(),
});

describe('ExtractWorkerHost with the real worker loop', () => {
  it('extracts in the worker and routes render/normalize round trips through main', async () => {
    const services = fakeServices();
    const { fork } = inProcessFork();
    const host = new ExtractWorkerHost({
      fork,
      renderPdfPages: services.renderPdfPages,
      normalizeImage: services.normalizeImage,
    });
    const budget = new JobImageBudget();
    const r = await host.extract(fixtureSource('sources/pdf/scanned-3p.pdf'), { ...opts(), budget });
    expect(r.ok && r.content.format).toBe('pdf-scanned');
    expect(services.renderCalls).toEqual([[1, 2, 3]]);
    expect(services.normalizeCalls).toHaveLength(3);
    // The worker's reservations come back to the job's budget.
    expect(budget.snapshot().usedImages).toBe(3);
    const t = await host.extract(textSource('hello'), opts());
    expect(t.ok).toBe(true);
    host.dispose();
  });
});

describe('ExtractWorkerHost isolation', () => {
  it('skips a source whose worker crashes and starts a fresh worker for the next', async () => {
    const procs: FakeProcess[] = [];
    const fork: ForkWorker = () => {
      const p = new FakeProcess((self, m) => {
        if (m.type !== 'extract') return;
        if (procs.length === 1) queueMicrotask(() => self.die(1));
        else {
          const content = newContent(m.source, { blocks: [{ kind: 'paragraph', text: 'ok' }] });
          queueMicrotask(() =>
            self.reply({ type: 'result', reqId: m.reqId, result: { ok: true, content }, budget: m.budget }),
          );
        }
      });
      procs.push(p);
      return p;
    };
    const host = new ExtractWorkerHost({ fork, ...fakeServices() });
    const crashed = await host.extract(textSource('a'), opts());
    expect(crashed).toMatchObject({ ok: false, skipped: { code: 'internal-error' } });
    const next = await host.extract(textSource('b'), opts());
    expect(next.ok).toBe(true);
    expect(procs).toHaveLength(2);
  });

  it('reports an out-of-memory exit as too-large', async () => {
    const fork: ForkWorker = () =>
      new FakeProcess((self, m) => m.type === 'extract' && queueMicrotask(() => self.die(134)));
    const host = new ExtractWorkerHost({ fork, ...fakeServices() });
    expect(await host.extract(textSource('a'), opts())).toMatchObject({ ok: false, skipped: { code: 'too-large' } });
  });

  it('kills a worker stuck past its timeout and skips the source as timeout', async () => {
    vi.useFakeTimers();
    const procs: FakeProcess[] = [];
    const fork: ForkWorker = () => {
      const p = new FakeProcess(() => undefined);
      procs.push(p);
      return p;
    };
    const host = new ExtractWorkerHost({ fork, ...fakeServices(), killSlackMs: 1000 });
    const pending = host.extract(textSource('a'), opts());
    await vi.advanceTimersByTimeAsync(10_000 + 1000 + 1);
    expect(await pending).toEqual({
      ok: false,
      skipped: { ref: 'Pasted text', code: 'timeout', reason: 'Took too long to read (over 10s)' },
    });
    expect(procs[0]!.killed).toBe(true);
    void host.extract(textSource('b'), opts());
    await vi.advanceTimersByTimeAsync(0);
    expect(procs).toHaveLength(2);
    host.dispose();
  });

  it('forwards cancellation to the worker', async () => {
    const ac = new AbortController();
    let proc: FakeProcess | undefined;
    const fork: ForkWorker = () => {
      proc = new FakeProcess((self, m) => {
        if (m.type === 'cancel') {
          const extract = self.sent.find((x) => x.type === 'extract');
          if (extract?.type === 'extract') {
            const result: ExtractResult = {
              ok: false,
              skipped: { ref: 'Pasted text', code: 'timeout', reason: 'Took too long to read' },
            };
            queueMicrotask(() => self.reply({ type: 'result', reqId: m.reqId, result, budget: extract.budget }));
          }
        }
      });
      return proc;
    };
    const host = new ExtractWorkerHost({ fork, ...fakeServices() });
    const p = host.extract(textSource('a'), { ...opts(), signal: ac.signal });
    ac.abort();
    expect(await p).toMatchObject({ ok: false });
    expect(proc!.sent.map((m) => m.type)).toEqual(['extract', 'cancel']);
  });

  it('runs sources of one job one at a time', async () => {
    const order: string[] = [];
    const fork: ForkWorker = () =>
      new FakeProcess((self, m) => {
        if (m.type !== 'extract') return;
        order.push(`start ${m.source.payload.kind === 'text' ? m.source.payload.text : ''}`);
        setTimeout(() => {
          order.push('end');
          self.reply({
            type: 'result',
            reqId: m.reqId,
            result: { ok: false, skipped: { ref: 'r', code: 'empty', reason: 'x' } },
            budget: m.budget,
          });
        }, 5);
      });
    const host = new ExtractWorkerHost({ fork, ...fakeServices() });
    await Promise.all([host.extract(textSource('a'), opts()), host.extract(textSource('b'), opts())]);
    expect(order).toEqual(['start a', 'end', 'start b', 'end']);
  });
});
