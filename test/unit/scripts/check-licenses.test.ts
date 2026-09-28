import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const script = join(repoRoot, 'scripts/check-licenses.mjs');
const temps: string[] = [];

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface LockEntry {
  version?: string;
  license?: string;
  dev?: boolean;
  optional?: boolean;
  link?: boolean;
}

function tempProject(packages: Record<string, LockEntry>, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'eli5-licenses-'));
  temps.push(dir);
  const lock = { name: 'demo', lockfileVersion: 3, packages: { '': { name: 'demo', license: 'MIT' }, ...packages } };
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

function run(args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('check-licenses.mjs: runtime licenses (13 §13)', () => {
  it('passes permissive runtime licenses and ignores dev-only packages', () => {
    const dir = tempProject({
      'node_modules/a': { version: '1.0.0', license: 'MIT' },
      'node_modules/b': { version: '1.0.0', license: 'Apache-2.0' },
      'node_modules/a/node_modules/c': { version: '2.0.0', license: '(MIT OR GPL-3.0-or-later)' },
      'node_modules/d': { version: '1.0.0', license: '(MIT AND Zlib)' },
      'node_modules/e': { version: '1.0.0', license: 'BSD-3-Clause', optional: true },
      'node_modules/dev-tool': { version: '1.0.0', license: 'GPL-3.0-only', dev: true },
    });
    const r = run(['--root', dir]);
    expect(r.out).toContain('licenses: ok (5 runtime packages)');
    expect(r.code).toBe(0);
  });

  it('fails a copyleft runtime dependency and an AND with a disallowed term', () => {
    const dir = tempProject({
      'node_modules/gpl-lib': { version: '3.1.0', license: 'GPL-3.0-only' },
      'node_modules/mixed': { version: '1.0.0', license: 'MIT AND AGPL-3.0-only' },
      'node_modules/ok': { version: '1.0.0', license: 'ISC' },
    });
    const r = run(['--root', dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('gpl-lib@3.1.0: GPL-3.0-only');
    expect(r.out).toContain('mixed@1.0.0: MIT AND AGPL-3.0-only');
    expect(r.out).not.toContain('ok@1.0.0');
  });

  it('falls back to the installed package.json when the lockfile has no license', () => {
    const dir = tempProject(
      { 'node_modules/legacy': { version: '0.1.0' }, 'node_modules/unknown': { version: '0.2.0' } },
      {
        'node_modules/legacy/package.json': JSON.stringify({ name: 'legacy', licenses: [{ type: 'MIT' }] }),
        'node_modules/unknown/package.json': JSON.stringify({ name: 'unknown' }),
      },
    );
    const r = run(['--root', dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('unknown@0.2.0: UNKNOWN');
    expect(r.out).not.toContain('legacy@');
  });

  it('accepts a reviewed package exception only for its exact license string', () => {
    const ok = run(['--root', tempProject({ 'node_modules/duck': { version: '0.1.12', license: 'BSD' } })]);
    expect(ok.code).toBe(0);
    const changed = run(['--root', tempProject({ 'node_modules/duck': { version: '0.2.0', license: 'GPL-2.0' } })]);
    expect(changed.code).toBe(1);
  });

  it('passes on this repository', () => {
    const r = run(['--root', repoRoot]);
    expect(r.out).toMatch(/licenses: ok \(\d+ runtime packages\)/);
    expect(r.code).toBe(0);
  });
});

describe('check-licenses.mjs --audit (13 §13 dependency audit, audit-allow.json)', () => {
  const report = (vulns: Record<string, { severity: string; via: unknown[] }>): string =>
    JSON.stringify({ auditReportVersion: 2, vulnerabilities: vulns });

  const advisory = (id: string, severity: string): { url: string; severity: string; title: string } => ({
    url: `https://github.com/advisories/${id}`,
    severity,
    title: 'demo',
  });

  function auditRun(
    vulns: Record<string, { severity: string; via: unknown[] }>,
    allow: unknown,
  ): ReturnType<typeof run> {
    const dir = tempProject({}, { 'audit.json': report(vulns), 'audit-allow.json': JSON.stringify(allow) });
    return run(['--root', dir, '--audit', join(dir, 'audit.json'), '--today', '2026-09-28']);
  }

  it('passes when only low or moderate advisories exist', () => {
    const r = auditRun(
      { a: { severity: 'moderate', via: [advisory('GHSA-aaaa-bbbb-cccc', 'moderate')] } },
      { allow: [] },
    );
    expect(r.out).toContain('audit: ok');
    expect(r.code).toBe(0);
  });

  it('fails a high advisory that is not allowed', () => {
    const r = auditRun({ a: { severity: 'high', via: [advisory('GHSA-aaaa-bbbb-cccc', 'high')] } }, { allow: [] });
    expect(r.code).toBe(1);
    expect(r.out).toContain('a: high GHSA-aaaa-bbbb-cccc');
  });

  it('passes an allowed advisory until its expiry date', () => {
    const vulns = { a: { severity: 'critical', via: [advisory('GHSA-aaaa-bbbb-cccc', 'critical')] } };
    const entry = { package: 'a', advisory: 'GHSA-aaaa-bbbb-cccc', reason: 'not reachable', expires: '2026-09-28' };
    expect(auditRun(vulns, { allow: [entry] }).code).toBe(0);
    const expired = auditRun(vulns, { allow: [{ ...entry, expires: '2026-09-27' }] });
    expect(expired.code).toBe(1);
    expect(expired.out).toContain('expired');
  });

  it('treats a transitive-only entry by its own advisories', () => {
    // `b` is high only because it depends on `a`; allowing a's advisory covers both.
    const vulns = {
      a: { severity: 'high', via: [advisory('GHSA-aaaa-bbbb-cccc', 'high')] },
      b: { severity: 'high', via: ['a'] },
    };
    const entry = { package: 'a', advisory: 'GHSA-aaaa-bbbb-cccc', reason: 'dev path', expires: '2027-01-01' };
    expect(auditRun(vulns, { allow: [entry] }).code).toBe(0);
  });

  it('rejects an allow entry without a valid expiry', () => {
    const r = auditRun({}, { allow: [{ package: 'a', advisory: 'GHSA-x', reason: 'r' }] });
    expect(r.code).toBe(2);
    expect(r.out).toContain('expires');
  });

  it('ships an audit-allow.json with a valid shape', () => {
    const allow = JSON.parse(readFileSync(join(repoRoot, 'audit-allow.json'), 'utf8')) as { allow: unknown[] };
    expect(Array.isArray(allow.allow)).toBe(true);
  });
});
