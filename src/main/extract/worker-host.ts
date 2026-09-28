/**
 * Main-process side of the extract worker (04 §10.4). One host per job: it forks the worker lazily,
 * runs that job's sources one at a time, routes render/normalize round trips to the pdf-render
 * window, and isolates failures. A crash skips the source (internal-error, or too-large when the
 * exit looks like out-of-memory); a worker stuck past its timeout is killed and the source skipped
 * as timeout. Either way a fresh worker serves the next source. Main only routes messages here.
 */
import type { UtilityProcess } from 'electron';
import type { ResolvedSource } from '../sources';
import type { JobImageBudget } from './images';
import { timeoutFor } from './limits';
import { skip } from './skip';
import type { ExtractLimits, ExtractResult, ImageNormalizer, PdfPageRenderer } from './types';
import { isWorkerMessage, type HostToWorker, type WorkerToHost } from './worker-protocol';

export interface WorkerProcess {
  postMessage(msg: HostToWorker): void;
  onMessage(cb: (msg: unknown) => void): void;
  onExit(cb: (code: number) => void): void;
  kill(): void;
}

export type ForkWorker = () => WorkerProcess;

export interface ExtractWorkerHostOptions {
  fork: ForkWorker;
  renderPdfPages: PdfPageRenderer;
  normalizeImage: ImageNormalizer;
  /** Debug log (codes only). */
  log?: (msg: string) => void;
  /** Extra time past the per-format timeout before the worker is killed. */
  killSlackMs?: number;
}

/** Heap cap for the worker (04 §10.4). */
export const WORKER_EXEC_ARGV = ['--max-old-space-size=1024'];

/**
 * Exit codes seen when V8 aborts on heap exhaustion (SIGABRT/SIGTRAP surfaced as 134/133, or 5 on
 * some Electron builds). Treated as too-large rather than internal-error.
 */
const OOM_EXIT_CODES = new Set([5, 133, 134]);

interface Active {
  reqId: number;
  source: ResolvedSource;
  budget: JobImageBudget;
  resolve: (r: ExtractResult) => void;
  controllers: Set<AbortController>;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

export class ExtractWorkerHost {
  private worker: WorkerProcess | undefined;
  private active: Active | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private reqSeq = 0;
  private disposed = false;

  constructor(private readonly opts: ExtractWorkerHostOptions) {}

  /** Extracts one source in the worker; never throws. Sources of one host run one at a time. */
  extract(
    source: ResolvedSource,
    o: { signal: AbortSignal; limits: ExtractLimits; budget: JobImageBudget },
  ): Promise<ExtractResult> {
    const run = this.queue.then(() => this.run(source, o));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Kills the worker (job end). */
  dispose(): void {
    this.disposed = true;
    this.killWorker();
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  private killWorker(): void {
    const w = this.worker;
    this.worker = undefined;
    try {
      w?.kill();
    } catch {
      // already gone
    }
  }

  private ensureWorker(): WorkerProcess {
    if (this.worker) return this.worker;
    const w = this.opts.fork();
    this.worker = w;
    w.onMessage((m) => {
      if (this.worker === w) this.onMessage(w, m);
    });
    w.onExit((code) => {
      if (this.worker !== w) return; // killed on purpose
      this.worker = undefined;
      const a = this.active;
      if (!a) return;
      this.log(`extract-worker: exited with code ${code}`);
      this.finish(a, skip(a.source, OOM_EXIT_CODES.has(code) ? 'too-large' : 'internal-error'));
    });
    return w;
  }

  private run(
    source: ResolvedSource,
    o: { signal: AbortSignal; limits: ExtractLimits; budget: JobImageBudget },
  ): Promise<ExtractResult> {
    if (this.disposed) return Promise.resolve(skip(source, 'internal-error'));
    const reqId = ++this.reqSeq;
    const timeoutMs = timeoutFor(source.format, o.limits);
    return new Promise<ExtractResult>((resolve) => {
      let w: WorkerProcess;
      try {
        w = this.ensureWorker();
      } catch {
        this.log('extract-worker: fork failed');
        resolve(skip(source, 'internal-error'));
        return;
      }
      const timer = setTimeout(
        () => {
          // The worker did not answer after its own timeout: it is stuck in a synchronous parse.
          this.log('extract-worker: killed after timeout');
          this.killWorker();
          const a = this.active;
          if (a?.reqId === reqId) this.finish(a, skip(source, 'timeout', { seconds: Math.round(timeoutMs / 1000) }));
        },
        timeoutMs + (this.opts.killSlackMs ?? 5000),
      );
      const onAbort = (): void => {
        for (const c of active.controllers) c.abort();
        this.worker?.postMessage({ type: 'cancel', reqId });
      };
      const active: Active = {
        reqId,
        source,
        budget: o.budget,
        resolve,
        controllers: new Set(),
        timer,
        cleanup: () => o.signal.removeEventListener('abort', onAbort),
      };
      this.active = active;
      w.postMessage({ type: 'extract', reqId, source, limits: o.limits, budget: o.budget.snapshot() });
      // After the extract message, so a cancel always refers to a request the worker has seen.
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private finish(a: Active, result: ExtractResult): void {
    if (this.active !== a) return;
    this.active = undefined;
    clearTimeout(a.timer);
    a.cleanup();
    for (const c of a.controllers) c.abort();
    a.resolve(result);
  }

  private onMessage(w: WorkerProcess, raw: unknown): void {
    if (!isWorkerMessage(raw)) return;
    const m: WorkerToHost = raw;
    const a = this.active;
    switch (m.type) {
      case 'ready':
        return;
      case 'log':
        this.log(m.msg);
        return;
      case 'result':
        if (!a || a.reqId !== m.reqId) return;
        a.budget.apply(m.budget);
        this.finish(a, m.result);
        return;
      case 'render':
      case 'normalize': {
        if (!a || a.reqId !== m.reqId) return;
        const ac = new AbortController();
        a.controllers.add(ac);
        const done = (): void => {
          a.controllers.delete(ac);
        };
        if (m.type === 'render') {
          this.opts
            .renderPdfPages(m.pdf, m.pages, { targetLongEdgePx: m.targetLongEdgePx, signal: ac.signal })
            .then(
              (result) => w.postMessage({ type: 'render-result', callId: m.callId, result }),
              () => w.postMessage({ type: 'render-result', callId: m.callId, result: { error: 'render failed' } }),
            )
            .finally(done);
        } else {
          this.opts
            .normalizeImage(m.bytes, m.mediaType, { origin: m.origin, signal: ac.signal })
            .then(
              (result) => w.postMessage({ type: 'normalize-result', callId: m.callId, result }),
              () =>
                w.postMessage({ type: 'normalize-result', callId: m.callId, result: { error: 'normalize failed' } }),
            )
            .finally(done);
        }
        return;
      }
    }
  }
}

/** Production fork: an Electron utilityProcess running the bundled worker entry (04 §10.4). */
export function utilityProcessFork(
  utilityProcess: { fork(modulePath: string, args?: string[], options?: Record<string, unknown>): UtilityProcess },
  entry: string,
  env: Record<string, string> = {},
): ForkWorker {
  return () => {
    const child = utilityProcess.fork(entry, [], {
      serviceName: 'ELI5 extract worker',
      execArgv: WORKER_EXEC_ARGV,
      stdio: 'ignore',
      env: { ...process.env, ...env },
    });
    return {
      postMessage: (msg) => child.postMessage(msg),
      onMessage: (cb) => {
        child.on('message', (msg: unknown) => cb(msg));
      },
      onExit: (cb) => {
        child.on('exit', (code: number) => cb(code));
      },
      kill: () => {
        child.kill();
      },
    };
  };
}
