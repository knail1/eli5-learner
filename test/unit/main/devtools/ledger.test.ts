import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BudgetLedger } from '../../../../src/main/devtools';
import { FakeClock } from '../../../helpers/clock';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'eli5-ledger-'));
  file = path.join(dir, 'nested', 'ledger.jsonl');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

let seq = 0;
const ids = (): string => `r${++seq}`;
const clock = new FakeClock('2026-09-01T10:00:00.000Z');
const open = (capUsd: number): BudgetLedger => new BudgetLedger({ path: file, capUsd, clock, newId: ids });
const lines = async (): Promise<Record<string, unknown>[]> =>
  (await readFile(file, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('BudgetLedger', () => {
  it('starts empty when the file does not exist, creating parent directories on first write', async () => {
    const l = open(1);
    expect(l.spentUsd).toBe(0);
    expect(l.remainingUsd).toBe(1);
    const r = l.reserve({ maxCostUsd: 0.2, model: 'claude-opus-5', taskId: 'in-depth' });
    expect(l.reservedUsd).toBeCloseTo(0.2, 12);
    expect(l.remainingUsd).toBeCloseTo(0.8, 12);
    l.settle(r, {
      costUsd: 0.05,
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outcome: 'ok',
    });
    expect(l.reservedUsd).toBe(0);
    expect(l.spentUsd).toBeCloseTo(0.05, 12);
    const rows = await lines();
    expect(rows.map((x) => x.type)).toEqual(['reserve', 'charge']);
    expect(rows[0]).toMatchObject({ v: 1, id: r.id, at: '2026-09-01T10:00:00.000Z', maxCostUsd: 0.2 });
    expect(rows[1]).toMatchObject({ v: 1, id: r.id, costUsd: 0.05, outcome: 'ok', model: 'claude-opus-5' });
  });

  it('is append-only and re-read on construction, so the cap spans runs', async () => {
    const a = open(1);
    a.settle(a.reserve({ maxCostUsd: 0.5, model: 'm', taskId: 'eli5' }), {
      costUsd: 0.3,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outcome: 'ok',
    });
    const b = open(1);
    expect(b.spentUsd).toBeCloseTo(0.3, 12);
    b.settle(b.reserve({ maxCostUsd: 0.1, model: 'm', taskId: 'eli5' }), {
      costUsd: 0.1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outcome: 'ok',
    });
    expect(open(1).spentUsd).toBeCloseTo(0.4, 12);
    expect((await lines()).length).toBe(4);
  });

  it('counts a reservation with no charge (a crashed run) at its worst-case cost', async () => {
    open(1).reserve({ maxCostUsd: 0.25, model: 'm', taskId: 'in-depth' });
    const next = open(1);
    expect(next.spentUsd).toBeCloseTo(0.25, 12);
    expect(next.remainingUsd).toBeCloseTo(0.75, 12);
  });

  it('refuses a reservation that exceeds the remaining budget and writes nothing', async () => {
    const l = open(0.1);
    expect(() => l.reserve({ maxCostUsd: 0.11, model: 'm', taskId: 'eli5' })).toThrow(/budget/);
    expect(l.reservedUsd).toBe(0);
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  it('refuses to open a ledger with a malformed line (it could hide spend)', async () => {
    open(1).reserve({ maxCostUsd: 0.1, model: 'm', taskId: 'eli5' });
    await writeFile(file, (await readFile(file, 'utf8')) + '{"v":1,"type":"cha\n');
    expect(() => open(1)).toThrow(/ledger/i);
  });

  it('rejects a non-positive or non-finite cap', () => {
    expect(() => open(0)).toThrow();
    expect(() => open(Number.NaN)).toThrow();
    expect(() => open(-1)).toThrow();
  });

  it('settling the same reservation twice is an error', () => {
    const l = open(1);
    const r = l.reserve({ maxCostUsd: 0.1, model: 'm', taskId: 'eli5' });
    const c = {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outcome: 'ok' as const,
    };
    l.settle(r, c);
    expect(() => l.settle(r, c)).toThrow();
  });
});

describe('BudgetLedger session lock', () => {
  const locked = (isAlive: (pid: number) => boolean = () => true): BudgetLedger =>
    new BudgetLedger({ path: file, capUsd: 1, clock, newId: ids, lock: true, isAlive });

  it('holds <ledger>.lock with the PID so a second locked ledger on the same file is refused', async () => {
    const a = locked();
    expect((await readFile(`${file}.lock`, 'utf8')).trim()).toBe(String(process.pid));
    expect(() => locked()).toThrow(/in use/);
    a.release();
    await expect(readFile(`${file}.lock`, 'utf8')).rejects.toThrow();
    locked().release();
  });

  it('takes over a lock left by a process that is no longer running', async () => {
    const a = locked();
    void a; // simulates a crashed run: never released
    await writeFile(`${file}.lock`, '999999\n');
    const b = locked((pid) => pid !== 999999);
    expect((await readFile(`${file}.lock`, 'utf8')).trim()).toBe(String(process.pid));
    b.release();
  });

  it('release is idempotent and an unlocked ledger never touches the lock file', async () => {
    const a = locked();
    a.release();
    a.release();
    open(1).release();
    await expect(readFile(`${file}.lock`, 'utf8')).rejects.toThrow();
  });
});
