import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeReport } from './lib/files';

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'eli5-eval-files-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('writeReport (13 §9.6 results files)', () => {
  it('writes <stem>.json, and never overwrites an earlier file of the same stem', async () => {
    const at = new Date('2026-09-28T03:04:05.000Z');
    const a = await writeReport(tmp, '2026-09-28-claude-m', at, 'first\n');
    const b = await writeReport(tmp, '2026-09-28-claude-m', at, 'second\n');
    const c = await writeReport(tmp, '2026-09-28-claude-m', at, 'third\n');
    expect(path.basename(a)).toBe('2026-09-28-claude-m.json');
    expect(path.basename(b)).toBe('2026-09-28-claude-m-030405.json');
    expect(path.basename(c)).toBe('2026-09-28-claude-m-030405-2.json');
    expect([a, b, c].map((f) => readFileSync(f, 'utf8'))).toEqual(['first\n', 'second\n', 'third\n']);
  });
});
