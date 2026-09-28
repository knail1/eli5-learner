import { LIMITS } from './constants';
import { abortError } from './errors';
import type { ReadabilityJob, ReadabilityResult } from './readability-core';

/**
 * Readability worker pool (05 §5.2): READABILITY_WORKERS threads, started lazily, terminated after
 * 60 s idle; a job that exceeds READABILITY_TIMEOUT_MS terminates and replaces its worker.
 * The thread factory is injected: production passes electron-vite's `?nodeWorker` constructor
 * (readability-thread.ts); tests pass fakes or use `inProcessReadability`.
 */

export type { ReadabilityJob, ReadabilityResult } from './readability-core';
export type ReadabilityRunner = (job: ReadabilityJob, signal?: AbortSignal) => Promise<ReadabilityResult>;

export class ReadabilityTimeout extends Error {
  constructor() {
    super('readability timed out');
    this.name = 'ReadabilityTimeout';
  }
}

export class ReadabilityFailed extends Error {
  constructor(kind: string) {
    super(`readability failed: ${kind}`);
    this.name = 'ReadabilityFailed';
  }
}

/** The subset of node:worker_threads Worker the pool uses. */
export interface WorkerLike {
  postMessage(value: unknown): void;
  on(event: 'message', fn: (value: unknown) => void): unknown;
  on(event: 'error', fn: (err: unknown) => void): unknown;
  on(event: 'exit', fn: (code: number) => void): unknown;
  terminate(): unknown;
  unref?(): void;
}
export type WorkerFactory = () => WorkerLike;

interface Task {
  id: number;
  job: ReadabilityJob;
  signal: AbortSignal | undefined;
  resolve: (r: ReadabilityResult) => void;
  reject: (e: unknown) => void;
}

interface Slot {
  worker: WorkerLike;
  task: Task | null;
  timer: ReturnType<typeof setTimeout> | null;
  idle: ReturnType<typeof setTimeout> | null;
  dead: boolean;
}

type Reply = { id: number; ok: true; result: ReadabilityResult } | { id: number; ok: false; error: string };

export interface PoolOptions {
  createWorker: WorkerFactory;
  size?: number;
  timeoutMs?: number;
  idleMs?: number;
}

export class ReadabilityPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Task[] = [];
  private nextId = 1;
  private readonly size: number;
  private readonly timeoutMs: number;
  private readonly idleMs: number;

  constructor(private readonly opts: PoolOptions) {
    this.size = opts.size ?? LIMITS.READABILITY_WORKERS;
    this.timeoutMs = opts.timeoutMs ?? LIMITS.READABILITY_TIMEOUT_MS;
    this.idleMs = opts.idleMs ?? LIMITS.READABILITY_IDLE_MS;
  }

  /** Number of live worker threads (for tests and diagnostics). */
  get workerCount(): number {
    return this.slots.length;
  }

  readonly run: ReadabilityRunner = (job, signal) =>
    new Promise<ReadabilityResult>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const task: Task = { id: this.nextId++, job, signal, resolve, reject };
      signal?.addEventListener('abort', () => this.cancel(task), { once: true });
      this.queue.push(task);
      this.pump();
    });

  async close(): Promise<void> {
    for (const t of this.queue.splice(0)) t.reject(abortError());
    for (const s of [...this.slots]) this.kill(s, abortError());
  }

  private pump(): void {
    while (this.queue.length > 0) {
      let slot = this.slots.find((s) => !s.task && !s.dead);
      if (!slot && this.slots.length < this.size) slot = this.spawn();
      if (!slot) return;
      const task = this.queue.shift()!;
      this.assign(slot, task);
    }
  }

  private spawn(): Slot {
    const worker = this.opts.createWorker();
    worker.unref?.();
    const slot: Slot = { worker, task: null, timer: null, idle: null, dead: false };
    worker.on('message', (m) => this.onReply(slot, m as Reply));
    worker.on('error', () => this.kill(slot, new ReadabilityFailed('worker-error')));
    worker.on('exit', () => this.kill(slot, new ReadabilityFailed('worker-exit')));
    this.slots.push(slot);
    return slot;
  }

  private assign(slot: Slot, task: Task): void {
    if (slot.idle) clearTimeout(slot.idle);
    slot.idle = null;
    slot.task = task;
    slot.timer = setTimeout(() => this.kill(slot, new ReadabilityTimeout()), this.timeoutMs);
    slot.worker.postMessage({ id: task.id, job: task.job });
  }

  private onReply(slot: Slot, m: Reply): void {
    const task = slot.task;
    if (!task || m.id !== task.id) return;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.task = null;
    if (m.ok) task.resolve(m.result);
    else task.reject(new ReadabilityFailed(m.error));
    if (this.queue.length > 0) this.pump();
    else {
      slot.idle = setTimeout(() => this.kill(slot, null), this.idleMs);
      slot.idle.unref?.();
    }
  }

  private cancel(task: Task): void {
    const q = this.queue.indexOf(task);
    if (q >= 0) {
      this.queue.splice(q, 1);
      task.reject(abortError());
      return;
    }
    const slot = this.slots.find((s) => s.task === task);
    if (slot) this.kill(slot, abortError()); // a running parse cannot be interrupted; replace the thread
  }

  /** Terminates a worker; rejects its task with `err` (null = idle shutdown). */
  private kill(slot: Slot, err: unknown): void {
    if (slot.dead) return;
    slot.dead = true;
    if (slot.timer) clearTimeout(slot.timer);
    if (slot.idle) clearTimeout(slot.idle);
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots.splice(i, 1);
    const task = slot.task;
    slot.task = null;
    try {
      void slot.worker.terminate();
    } catch {
      /* already gone */
    }
    if (task) task.reject(err ?? new ReadabilityFailed('terminated'));
    this.pump();
  }
}

/** In-process path for unit tests (05 §5.2 "unit tested under Vitest with plain Node"). */
export const inProcessReadability: ReadabilityRunner = async (job, signal) => {
  if (signal?.aborted) throw abortError();
  const { runReadability } = await import('./readability-core');
  return runReadability(job);
};
