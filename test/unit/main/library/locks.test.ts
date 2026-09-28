import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AsyncMutex,
  acquireProcessLock,
  defaultProcessProbe,
  releaseProcessLock,
  type ProcessProbe,
} from '../../../../src/main/library';
import { tmpLibrary } from '../../../helpers/tmp-library';

describe('AsyncMutex (09 §8.3)', () => {
  it('runs callers in FIFO order, one at a time, and survives a rejection', async () => {
    const m = new AsyncMutex();
    const log: string[] = [];
    const task = (name: string, ms: number, fail = false) =>
      m.run(async () => {
        log.push(`${name}+`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`${name}-`);
        if (fail) throw new Error(name);
        return name;
      });
    const results = await Promise.allSettled([task('a', 15), task('b', 1, true), task('c', 1)]);
    expect(log).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});

const REC_START = new Date('2026-02-01T00:00:00.000Z');

function probe(over: Partial<ProcessProbe> = {}): ProcessProbe {
  return {
    isAlive: () => true,
    startTime: () => Promise.resolve(REC_START),
    command: () => Promise.resolve(undefined),
    ...over,
  };
}

async function lockWith(record: object | string): Promise<string> {
  const { libraryDir } = await tmpLibrary();
  const file = path.join(libraryDir, '.eli5', 'library.lock');
  await acquireProcessLock({ file, appVersion: 'seed', startedAt: REC_START, pid: 999_999 });
  await writeFile(file, typeof record === 'string' ? record : JSON.stringify(record));
  return file;
}

const other = { pid: 4242, appVersion: '1.0.0', startedAt: REC_START.toISOString() };
const me = { file: '', appVersion: '0.0.0-test', startedAt: new Date('2026-02-02T00:00:00.000Z'), pid: 1 };

describe('process lock (09 §8.4)', () => {
  it('creates the lock when none exists and records pid, appVersion, startedAt', async () => {
    const { libraryDir } = await tmpLibrary();
    const file = path.join(libraryDir, '.eli5', 'library.lock');
    expect(await acquireProcessLock({ ...me, file })).toEqual({ acquired: true });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      pid: 1,
      appVersion: '0.0.0-test',
      startedAt: '2026-02-02T00:00:00.000Z',
    });
  });

  it('is held by a live process whose start time matches (within 2 s)', async () => {
    const file = await lockWith(other);
    const near = new Date(REC_START.getTime() + 1500);
    const r = await acquireProcessLock({ ...me, file, probe: probe({ startTime: () => Promise.resolve(near) }) });
    expect(r).toEqual({ acquired: false, holder: other });
  });

  it('is stale when the PID was reused by a later process', async () => {
    const file = await lockWith(other);
    const later = new Date(REC_START.getTime() + 60_000);
    const r = await acquireProcessLock({ ...me, file, probe: probe({ startTime: () => Promise.resolve(later) }) });
    expect(r).toEqual({ acquired: true });
    expect(JSON.parse(await readFile(file, 'utf8')).pid).toBe(1);
  });

  it('is stale when the PID is dead, is our own, or the file is corrupt', async () => {
    let file = await lockWith(other);
    expect(await acquireProcessLock({ ...me, file, probe: probe({ isAlive: () => false }) })).toEqual({
      acquired: true,
    });
    file = await lockWith({ ...other, pid: 1 });
    expect(await acquireProcessLock({ ...me, file, probe: probe() })).toEqual({ acquired: true });
    file = await lockWith('garbage');
    expect(await acquireProcessLock({ ...me, file, probe: probe() })).toEqual({ acquired: true });
  });

  it('falls back to the executable name when the start time is unreadable', async () => {
    const noStart = { startTime: () => Promise.resolve(undefined) };
    let file = await lockWith(other);
    const same = probe({ ...noStart, command: () => Promise.resolve('/Applications/ELI5 Learner.app/x/ELI5 Learner') });
    expect(await acquireProcessLock({ ...me, file, probe: same, executableName: 'ELI5 Learner' })).toMatchObject({
      acquired: false,
    });
    file = await lockWith(other);
    const diff = probe({ ...noStart, command: () => Promise.resolve('/usr/bin/some-daemon') });
    expect(await acquireProcessLock({ ...me, file, probe: diff, executableName: 'ELI5 Learner' })).toEqual({
      acquired: true,
    });
  });

  it('release removes only our own lock', async () => {
    const file = await lockWith(other);
    await releaseProcessLock(file, 1);
    expect(JSON.parse(await readFile(file, 'utf8')).pid).toBe(4242);
    await releaseProcessLock(file, 4242);
    await expect(readFile(file)).rejects.toThrow();
  });

  it('the default probe sees this process alive with a readable start time', async () => {
    expect(defaultProcessProbe.isAlive(process.pid)).toBe(true);
    const t = await defaultProcessProbe.startTime(process.pid);
    const expected = Date.now() - process.uptime() * 1000;
    if (t) expect(Math.abs(t.getTime() - expected)).toBeLessThan(3000);
    expect(defaultProcessProbe.isAlive(2 ** 22 + 12345)).toBe(false);
  });
});
