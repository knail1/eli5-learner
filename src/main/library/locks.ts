/**
 * In-process locks and the cross-process library lock (09 §8.3, §8.4).
 * Lock order: doc locks (ascending slug) -> catalog -> suggestions.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { writeJsonAtomic, isErrno } from './fs-atomic';
import { LibraryError, type ProcessProbe } from './types';

/** FIFO promise-chain mutex. Not reentrant (09 §8.3). */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Keyed exclusive locks with reentry detection. Held keys are tracked per async context, so
 * re-acquiring a key the current call chain already holds throws LOCK_REENTRY instead of
 * deadlocking, and `holds()` lets writers assert the caller took the lock (LOCK_NOT_HELD).
 */
export class LockSet {
  private readonly mutexes = new Map<string, { m: AsyncMutex; users: number }>();
  private readonly held = new AsyncLocalStorage<ReadonlySet<string>>();

  holds(key: string): boolean {
    return this.held.getStore()?.has(key) ?? false;
  }

  async with<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.holds(key)) throw new LibraryError('LOCK_REENTRY', { key });
    let slot = this.mutexes.get(key);
    if (!slot) {
      slot = { m: new AsyncMutex(), users: 0 };
      this.mutexes.set(key, slot);
    }
    slot.users++;
    const outer = this.held.getStore() ?? new Set<string>();
    try {
      return await slot.m.run(() => this.held.run(new Set([...outer, key]), fn));
    } finally {
      if (--slot.users === 0) this.mutexes.delete(key);
    }
  }

  /** Several keys, taken in ascending order to avoid deadlock (09 §8.3 `withDocLocks`). */
  withAll<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(keys)].sort();
    const step = (i: number): Promise<T> => {
      const k = sorted[i];
      return k === undefined ? fn() : this.with(k, () => step(i + 1));
    };
    return step(0);
  }
}

// ---- process lock (09 §8.4) ----

export interface ProcessLockRecord {
  pid: number;
  appVersion: string;
  startedAt: string;
}

/** Recorded vs actual start times must agree within this window (09 §8.4 rule 2). */
export const START_TIME_TOLERANCE_MS = 2000;

export type ProcessLockResult = { acquired: true } | { acquired: false; holder: ProcessLockRecord };

export interface ProcessLockOptions {
  file: string;
  appVersion: string;
  /** This process's start time. */
  startedAt: Date;
  pid?: number;
  probe?: ProcessProbe;
  /** Executable name compared by the fallback check (e.g. path.basename(process.execPath)). */
  executableName?: string;
}

/**
 * `open(lock,'wx')`; if it exists, the lock is held only when its PID is another live process whose
 * start time matches the record (or, when unreadable, whose executable name matches). Otherwise it
 * is stale and overwritten.
 */
export async function acquireProcessLock(opts: ProcessLockOptions): Promise<ProcessLockResult> {
  const pid = opts.pid ?? process.pid;
  const record: ProcessLockRecord = { pid, appVersion: opts.appVersion, startedAt: opts.startedAt.toISOString() };
  const body = JSON.stringify(record, null, 2) + '\n';
  await fsp.mkdir(path.dirname(opts.file), { recursive: true });
  try {
    const fh = await fsp.open(opts.file, 'wx', 0o600);
    try {
      await fh.writeFile(body);
      await fh.sync();
    } finally {
      await fh.close();
    }
    return { acquired: true };
  } catch (err) {
    if (!isErrno(err, 'EEXIST')) throw err;
  }
  const existing = await readLockRecord(opts.file);
  if (existing && (await isHeld(existing, pid, opts))) return { acquired: false, holder: existing };
  await writeJsonAtomic(opts.file, record);
  return { acquired: true };
}

/** Removes the lock on quit, only when it is ours. */
export async function releaseProcessLock(file: string, pid: number = process.pid): Promise<void> {
  const rec = await readLockRecord(file);
  if (rec?.pid === pid) await fsp.unlink(file).catch(() => {});
}

async function readLockRecord(file: string): Promise<ProcessLockRecord | undefined> {
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<ProcessLockRecord>;
    if (typeof raw.pid === 'number' && Number.isInteger(raw.pid) && typeof raw.startedAt === 'string') {
      return { pid: raw.pid, appVersion: String(raw.appVersion ?? ''), startedAt: raw.startedAt };
    }
  } catch {
    // unreadable or corrupt: stale
  }
  return undefined;
}

async function isHeld(rec: ProcessLockRecord, selfPid: number, opts: ProcessLockOptions): Promise<boolean> {
  if (rec.pid === selfPid || rec.pid <= 0) return false;
  const probe = opts.probe ?? defaultProcessProbe;
  if (!probe.isAlive(rec.pid)) return false;
  const recorded = Date.parse(rec.startedAt);
  const actual = await probe.startTime(rec.pid);
  if (actual && !Number.isNaN(recorded)) {
    return Math.abs(actual.getTime() - recorded) <= START_TIME_TOLERANCE_MS;
  }
  const comm = await probe.command(rec.pid);
  if (comm === undefined || opts.executableName === undefined) return false;
  return path.basename(comm) === opts.executableName;
}

const execFileP = promisify(execFile);

async function ps(field: 'lstart=' | 'comm=', pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP('ps', ['-o', field, '-p', String(pid)], { timeout: 2000 });
    const out = stdout.trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

/** macOS probe: `process.kill(pid, 0)` and `ps` (09 §8.4). */
export const defaultProcessProbe: ProcessProbe = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return isErrno(err, 'EPERM');
    }
  },
  async startTime(pid) {
    const s = await ps('lstart=', pid);
    if (s === undefined) return undefined;
    const t = Date.parse(s);
    return Number.isNaN(t) ? undefined : new Date(t);
  },
  command(pid) {
    return ps('comm=', pid);
  },
};
