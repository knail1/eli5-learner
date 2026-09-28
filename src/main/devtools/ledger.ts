import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';

/**
 * Append-only spending ledger for dev real runs (JSON Lines). Every call writes a `reserve` line
 * (worst-case cost) before it is sent and a `charge` line (actual cost) after. On open the file is
 * re-read, so the cap spans every run; a reservation without a charge (a crashed run) counts at its
 * worst case. Writes are synchronous so a reservation is on disk before any money can be spent.
 * With `lock`, the ledger holds `<path>.lock` (O_EXCL, containing the PID) for the whole session, so
 * two runs cannot each spend the same remaining budget from one snapshot.
 */

export interface LedgerClock {
  now(): Date;
}

export interface BudgetLedgerOptions {
  path: string;
  capUsd: number;
  clock?: LedgerClock;
  newId?: () => string;
  /** Hold `<path>.lock` until release(); a real run sets this. */
  lock?: boolean;
  /** Whether a PID found in a lock file is still running (injected in tests). */
  isAlive?: (pid: number) => boolean;
}

export interface Reservation {
  readonly id: string;
  readonly maxCostUsd: number;
  readonly model: string;
  readonly taskId: string;
}

export interface Charge {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outcome: 'ok' | 'error';
}

interface ReserveLine {
  v: 1;
  type: 'reserve';
  id: string;
  at: string;
  model: string;
  taskId: string;
  maxCostUsd: number;
}

interface ChargeLine extends Charge {
  v: 1;
  type: 'charge';
  id: string;
  at: string;
  model: string;
  taskId: string;
}

type LedgerLine = ReserveLine | ChargeLine;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;

function parseLine(raw: string, n: number, file: string): LedgerLine {
  let x: unknown;
  try {
    x = JSON.parse(raw);
  } catch {
    throw new Error(`Budget ledger ${file} line ${n} is not valid JSON; fix or move the ledger before spending`);
  }
  const o = x as Record<string, unknown> | null;
  const ok =
    o !== null &&
    typeof o === 'object' &&
    typeof o.id === 'string' &&
    ((o.type === 'reserve' && isNum(o.maxCostUsd)) || (o.type === 'charge' && isNum(o.costUsd)));
  if (!ok) throw new Error(`Budget ledger ${file} line ${n} is not a ledger entry`);
  return o as unknown as LedgerLine;
}

export class BudgetLedger {
  readonly path: string;
  readonly capUsd: number;
  private readonly clock: LedgerClock;
  private readonly newId: () => string;
  private spent = 0;
  private readonly open = new Map<string, Reservation>();
  private settleWaiters: (() => void)[] = [];
  private lockPath: string | undefined;
  private readonly onExit = (): void => this.release();

  constructor(o: BudgetLedgerOptions) {
    if (!Number.isFinite(o.capUsd) || o.capUsd <= 0) throw new Error('Budget cap must be a positive number of USD');
    this.path = o.path;
    this.capUsd = o.capUsd;
    this.clock = o.clock ?? { now: () => new Date() };
    this.newId = o.newId ?? randomUUID;
    if (o.lock) this.acquire(o.isAlive ?? pidAlive);
    try {
      this.load();
    } catch (err) {
      this.release();
      throw err;
    }
  }

  /** Drops the session lock (if held). Idempotent. */
  release(): void {
    if (this.lockPath === undefined) return;
    rmSync(this.lockPath, { force: true });
    this.lockPath = undefined;
    process.removeListener('exit', this.onExit);
  }

  /** Charged cost plus the worst case of reservations from earlier runs that never settled. */
  get spentUsd(): number {
    return this.spent;
  }

  /** Worst-case cost of calls in flight in this process. */
  get reservedUsd(): number {
    let n = 0;
    for (const r of this.open.values()) n += r.maxCostUsd;
    return n;
  }

  /** Reservations in flight in this process. */
  get openCount(): number {
    return this.open.size;
  }

  /** Resolves at the next settle, so a call can wait for in-flight worst cases to shrink. */
  whenSettled(): Promise<void> {
    return new Promise((resolve) => this.settleWaiters.push(resolve));
  }

  get remainingUsd(): number {
    return Math.max(0, this.capUsd - this.spent - this.reservedUsd);
  }

  /** Synchronous, so concurrent callers are serialized: no two reservations can share budget. */
  reserve(r: { maxCostUsd: number; model: string; taskId: string }): Reservation {
    if (!isNum(r.maxCostUsd)) throw new Error('Reservation cost must be a non-negative number');
    if (r.maxCostUsd > this.remainingUsd + 1e-12) throw new Error('Reservation exceeds the remaining budget');
    const res: Reservation = { id: this.newId(), maxCostUsd: r.maxCostUsd, model: r.model, taskId: r.taskId };
    this.append({ v: 1, type: 'reserve', at: this.at(), ...res });
    this.open.set(res.id, res);
    return res;
  }

  settle(res: Reservation, c: Charge): void {
    if (!this.open.has(res.id)) throw new Error('Reservation is not open');
    this.append({ v: 1, type: 'charge', id: res.id, at: this.at(), model: res.model, taskId: res.taskId, ...c });
    this.open.delete(res.id);
    this.spent += c.costUsd;
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const w of waiters) w();
  }

  private at(): string {
    return this.clock.now().toISOString();
  }

  private append(line: LedgerLine): void {
    mkdirSync(path.dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(line) + '\n', 'utf8');
  }

  private acquire(isAlive: (pid: number) => boolean): void {
    const lock = `${this.path}.lock`;
    mkdirSync(path.dirname(lock), { recursive: true });
    for (let tries = 0; tries < 2; tries++) {
      let fd: number;
      try {
        fd = openSync(lock, 'wx');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        let pid = Number.NaN;
        try {
          pid = Number.parseInt(readFileSync(lock, 'utf8').trim(), 10);
        } catch {
          // Removed between open and read: retry.
        }
        if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
          throw new Error(`Budget ledger ${this.path} is in use by process ${pid}; wait for that run to finish`);
        }
        rmSync(lock, { force: true }); // stale: its run is gone
        continue;
      }
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      this.lockPath = lock;
      process.once('exit', this.onExit);
      return;
    }
    throw new Error(`Budget ledger ${this.path} lock could not be taken`);
  }

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const reserved = new Map<string, number>();
    let charged = 0;
    text.split('\n').forEach((raw, i) => {
      if (raw.trim() === '') return;
      const line = parseLine(raw, i + 1, this.path);
      if (line.type === 'reserve') reserved.set(line.id, line.maxCostUsd);
      else {
        reserved.delete(line.id);
        charged += line.costUsd;
      }
    });
    let orphaned = 0;
    for (const v of reserved.values()) orphaned += v;
    this.spent = charged + orphaned;
  }
}
