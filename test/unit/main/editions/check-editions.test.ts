/**
 * Edition matrix build cells (13 §10.1) via scripts/check-editions.mjs. The build cells take a
 * minute or more, so they run only with ELI5_RUN_EDITION_BUILDS=1 (CI job `edition-fixture`, 13 §12).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const SCRIPT = path.join(ROOT, 'scripts/check-editions.mjs');

function run(args: string[], timeout: number) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', timeout });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('scripts/check-editions.mjs', () => {
  it('lists the cells it checks', () => {
    const r = run(['--list'], 30_000);
    expect(r.status).toBe(0);
    expect(r.out.trim().split('\n')).toEqual(['F', 'F-missing', 'P-stub']);
  });

  it('rejects an unknown cell', () => {
    const r = run(['--cell', 'E'], 30_000);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/Unknown cell "E"/);
  });

  it.skipIf(process.env.ELI5_RUN_EDITION_BUILDS !== '1')(
    'cells F, F-missing and P-stub pass',
    () => {
      const r = run([], 900_000);
      expect(r.out).toMatch(/^cell F: pass$/m);
      expect(r.out).toMatch(/^cell F-missing: pass$/m);
      expect(r.out).toMatch(/^cell P-stub: pass$/m);
      expect(r.status, r.out).toBe(0);
    },
    900_000,
  );
});
