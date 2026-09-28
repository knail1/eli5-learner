import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** scripts/build.sh: one command to build the app at will (unsigned dmg in release/). */
const script = resolve(import.meta.dirname, '../../../scripts/build.sh');

describe('scripts/build.sh', () => {
  it('is executable and valid bash', () => {
    expect(statSync(script).mode & 0o111).not.toBe(0);
    expect(spawnSync('bash', ['-n', script]).status).toBe(0);
  });

  it('documents its options with --help and exits 0', () => {
    const r = spawnSync('bash', [script, '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    for (const flag of ['--check', '--clean', '--open', '--help']) expect(r.stdout).toContain(flag);
    expect(r.stdout).toMatch(/release\//);
  });

  it('rejects an unknown option with exit code 2', () => {
    const r = spawnSync('bash', [script, '--nope'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown option/i);
  });
});
