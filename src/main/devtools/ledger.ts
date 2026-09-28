import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Append-only spending ledger for dev real runs (JSON Lines). Every call writes a `reserve` line
 * (worst-case cost) before it is sent and a `charge` line (actual cost) after. On open the file is
 * re-read, so the cap spans every run; a reservation without a charge (a crashed run) counts at its
 * worst case. Writes are synchronous so a reservation is on disk before any money can be spent.
 */

export interface LedgerClock {
  now(): Date;
}

export interface BudgetLedgerOptions {
  path: string;
  capUsd: number;
  clock?: LedgerClock;
  newId?: () => string;
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

  constructor(o: BudgetLedgerOptions) {
    if (!Number.isFinite(o.capUsd) || o.capUsd <= 0) throw new Error('Budget cap must be a positive number of USD');
    this.path = o.path;
    this.capUsd = o.capUsd;
    this.clock = o.clock ?? { now: () => new Date() };
    this.newId = o.newId ?? randomUUID;
    this.load();
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
  }

  private at(): string {
    return this.clock.now().toISOString();
  }

  private append(line: LedgerLine): void {
    mkdirSync(path.dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(line) + '\n', 'utf8');
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
