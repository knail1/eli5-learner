import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkBuildInfo,
  checkBundle,
  checkTrackedPaths,
  loadDenylist,
  parseAllowFile,
  runHygiene,
  scanDenylist,
  scanDenylistPaths,
  scanSecrets,
} from '../../../scripts/check-hygiene';

// Secret-shaped strings are assembled at runtime (13 §3.2) so this file never holds a literal one.
const ALNUM = 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zC';
const cycle = (n: number): string => Array.from({ length: n }, (_, i) => ALNUM[i % ALNUM.length]).join('');
const fakeKey = (): string => 'sk' + '-ant-' + 'api03-' + cycle(40);
const fakeUrlCreds = (): string => 'https' + '://deploy:' + 'hunter2pass' + '@git.example.com/r.git';

const repoRoot = resolve(import.meta.dirname, '../../..');
const temps: string[] = [];

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throwaway git repo with `files` written and staged (tracked = in the index). */
function tempRepo(files: Record<string, string>, untracked: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'eli5-hygiene-'));
  temps.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const write = (rel: string, text: string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  if (Object.keys(files).length > 0) execFileSync('git', ['add', '-f', '--', ...Object.keys(files)], { cwd: dir });
  for (const [rel, text] of Object.entries(untracked)) write(rel, text);
  return dir;
}

const DEFAULT_ALLOW = 'docs/.gitkeep\ndocs/.nojekyll\ndocs/index.html\ndocs/sample/\n';

/** What config/electron.vite.config.ts writes to out/main/build-info.json for a public build. */
const PUBLIC_BUILD_INFO = JSON.stringify({
  edition: 'public',
  overlay: 'src/main/editions/overlay.none.ts',
  foreign: [],
});

describe('parseAllowFile (config/hygiene-allow)', () => {
  it('splits docs paths from secret exceptions and ignores comments and blanks', () => {
    const a = parseAllowFile('# c\n\ndocs/index.html\ndocs/sample/\nsecret test/** url-credentials\n');
    expect(a.paths).toEqual(['docs/index.html', 'docs/sample/']);
    expect(a.secrets).toEqual([{ glob: 'test/**', rule: 'url-credentials' }]);
  });

  it('rejects a malformed secret entry', () => {
    expect(() => parseAllowFile('secret only-a-glob\n')).toThrow(/config\/hygiene-allow line 1/);
    expect(() => parseAllowFile('secret a b c d\n')).toThrow(/config\/hygiene-allow line 1/);
  });

  it('reads an optional masked preview that pins an exception to one value', () => {
    const a = parseAllowFile('secret out/r/*.js generic-high-entropy !0,r#*** # React table\n');
    expect(a.secrets).toEqual([{ glob: 'out/r/*.js', rule: 'generic-high-entropy', preview: '!0,r#***' }]);
  });
});

describe('checkTrackedPaths (13 §11 rule 1, 12 §12 gate 2)', () => {
  const allow = parseAllowFile(DEFAULT_ALLOW).paths;
  const bad = (paths: string[]): string[] => checkTrackedPaths(paths, allow).map((f) => f.path);

  it('passes ordinary sources and the whitelisted Pages files', () => {
    expect(
      bad(['src/main/index.ts', 'docs/index.html', 'docs/.nojekyll', 'docs/sample/index.html', '.env.example']),
    ).toEqual([]);
  });

  it('flags generated docs, the overlay, env files, the private spec and key material', () => {
    const paths = [
      'docs/my-learning/index.html',
      'docs/samplex/index.html',
      'enterprise/index.ts',
      '.env',
      '.env.local',
      'config/.env.production',
      'spec/internal.md',
      'certs/dev.pem',
      'signing.p12',
      'id.key',
      'config.local.json',
      'CLAUDE.local.md',
      '.library/x/index.html',
    ];
    expect(bad(paths)).toEqual(paths);
  });

  it('describes each finding without file contents', () => {
    const [f] = checkTrackedPaths(['enterprise/index.ts'], allow);
    expect(f).toMatchObject({ check: 'tracked-path', path: 'enterprise/index.ts' });
    expect(f?.detail).toMatch(/enterprise/);
  });
});

describe('scanSecrets (13 §11 rule 2, baseline SecretScanner from 10 §5.4)', () => {
  it('reports masked findings with path, line and rule', () => {
    const key = fakeKey();
    const found = scanSecrets([{ path: 'src/a.ts', text: `ok\nconst k = "${key}";\n` }], []);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ check: 'secret', path: 'src/a.ts', line: 2 });
    expect(found[0]?.detail).toContain('llm-api-key');
    expect(JSON.stringify(found)).not.toContain(key);
  });

  it('honours per-file, per-rule exceptions with globs', () => {
    const files = [
      { path: 'test/unit/a.test.ts', text: fakeUrlCreds() },
      { path: 'src/b.ts', text: fakeUrlCreds() },
      { path: 'test/unit/c.test.ts', text: fakeKey() },
    ];
    const found = scanSecrets(files, [{ glob: 'test/**', rule: 'url-credentials' }]);
    expect(found.map((f) => f.path)).toEqual(['src/b.ts', 'test/unit/c.test.ts']);
  });

  it('with a preview, allows only the finding whose masked value matches', () => {
    const table = 'x={password:!0,range:!0,search:!0,tel:!0,text:!0,time:!0,url:!0,week:!0}';
    const real = 'const c={password:"' + cycle(30) + '"}';
    const files = [
      { path: 'out/renderer/assets/index-abc.js', text: `${table}\n${real}\n` },
      { path: 'out/renderer/assets/other-def.js', text: table },
    ];
    const allow = [{ glob: 'out/renderer/assets/*.js', rule: 'generic-high-entropy', preview: '!0,r****************' }];
    const found = scanSecrets(files, allow);
    expect(found.map((f) => [f.path, f.line])).toEqual([['out/renderer/assets/index-abc.js', 2]]);
  });

  it('matches a single-segment * glob inside one directory only', () => {
    const allow = [{ glob: 'out/renderer/assets/*.js', rule: 'url-credentials' }];
    const found = scanSecrets(
      [
        { path: 'out/renderer/assets/index-abc.js', text: fakeUrlCreds() },
        { path: 'out/renderer/assets/deep/x.js', text: fakeUrlCreds() },
      ],
      allow,
    );
    expect(found.map((f) => f.path)).toEqual(['out/renderer/assets/deep/x.js']);
  });
});

describe('loadDenylist (HOOK-CFG-03)', () => {
  it('returns null when the variable is unset or blank', () => {
    expect(loadDenylist(undefined)).toBeNull();
    expect(loadDenylist('  \n ')).toBeNull();
  });

  it('reads inline newline-separated terms, dropping blanks and comments', () => {
    expect(loadDenylist('Alpha Corp\n\n# note\n  beta-host \n')).toEqual(['alpha corp', 'beta-host']);
  });

  it('reads an @file path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eli5-deny-'));
    temps.push(dir);
    writeFileSync(join(dir, 'terms.txt'), 'gamma\ndelta\n');
    expect(loadDenylist('@' + join(dir, 'terms.txt'))).toEqual(['gamma', 'delta']);
  });

  it('fails loudly when the @file is missing', () => {
    expect(() => loadDenylist('@/nonexistent/eli5/terms.txt')).toThrow(/ELI5_HYGIENE_DENYLIST/);
  });

  it('treats a set variable with no terms as a configuration error, not a pass', () => {
    expect(() => loadDenylist('# only a comment\n\n')).toThrow(/no terms/);
    const dir = mkdtempSync(join(tmpdir(), 'eli5-deny-'));
    temps.push(dir);
    writeFileSync(join(dir, 'empty.txt'), '\n# nothing\n');
    expect(() => loadDenylist('@' + join(dir, 'empty.txt'))).toThrow(/no terms/);
  });
});

describe('scanDenylist (HOOK-CFG-03)', () => {
  it('matches case-insensitively and never prints the term itself', () => {
    const found = scanDenylist(
      [
        { path: 'README.md', text: 'hello\nBuilt at ACME Widgets inc\n' },
        { path: 'src/x.ts', text: 'clean' },
      ],
      ['acme widgets', 'zeta'],
    );
    expect(found).toEqual([{ check: 'denylist', path: 'README.md', line: 2, detail: 'matches deny-list term #1' }]);
    expect(JSON.stringify(found).toLowerCase()).not.toContain('acme');
  });
});

describe('scanDenylistPaths (HOOK-CFG-03 over file names)', () => {
  it('matches terms in paths case-insensitively and never prints the term', () => {
    const found = scanDenylistPaths(
      ['src/a.ts', 'docs/Acme-Widgets/notes.md', 'out/x/acme-widgets.png'],
      ['acme-widgets'],
    );
    expect(found).toEqual([
      { check: 'denylist', path: 'docs/Acme-Widgets/notes.md', detail: 'path matches deny-list term #1' },
      { check: 'denylist', path: 'out/x/acme-widgets.png', detail: 'path matches deny-list term #1' },
    ]);
  });
});

describe('checkBuildInfo (13 §11 rule 4, 12 §12 gate 3: resolved @eli5/overlay id)', () => {
  const at = 'out/main/build-info.json';

  it('passes a public build whose overlay resolved to overlay.none', () => {
    expect(checkBuildInfo(JSON.parse(PUBLIC_BUILD_INFO), at)).toEqual([]);
  });

  it('fails a cell F build (fixture overlay resolved and inlined)', () => {
    // Frozen from `ELI5_EDITION=enterprise ELI5_OVERLAY_DIR=test/fixtures/overlay-fake electron-vite build`:
    // the bundle text carries no overlay path, only this record does.
    const info = {
      edition: 'enterprise',
      overlay: 'test/fixtures/overlay-fake/index.ts',
      foreign: ['test/fixtures/overlay-fake/index.ts', 'test/fixtures/overlay-fake/provider.ts'],
    };
    const details = checkBuildInfo(info, at).map((f) => f.detail);
    expect(details).toHaveLength(3);
    expect(details.join('\n')).toMatch(/edition/);
    expect(details.join('\n')).toMatch(/@eli5\/overlay resolved/);
    expect(details.join('\n')).toMatch(/2 bundled module\(s\) from outside src\//);
  });

  it('fails a missing or malformed record', () => {
    expect(checkBuildInfo(undefined, at)[0]?.detail).toMatch(/missing/);
    expect(checkBuildInfo({ edition: 'public' }, at)[0]?.detail).toMatch(/malformed/);
  });
});

describe('checkBundle (13 §11 rule 4, 12 §12 gate 3)', () => {
  it('passes a clean public bundle', () => {
    expect(
      checkBundle([{ path: 'out/main/index.js', text: 'class LocalPublisher {}' }], { packageMode: true }),
    ).toEqual([]);
  });

  it('flags an unresolved or non-public overlay reference', () => {
    const found = checkBundle(
      [
        { path: 'out/main/index.js', text: 'import("@eli5/overlay")' },
        { path: 'out/main/chunk.js', text: '// test/fixtures/overlay-fake/index.ts' },
        { path: 'out/main/other.js', text: 'require("../enterprise/index.ts")' },
      ],
      { packageMode: false },
    );
    expect(found.map((f) => f.path)).toEqual(['out/main/index.js', 'out/main/chunk.js', 'out/main/other.js']);
  });

  it('allows overlay.none but flags FakeProvider only in package mode', () => {
    const files = [{ path: 'out/main/index.js', text: '// src/main/editions/overlay.none.ts\nclass FakeProvider {}' }];
    expect(checkBundle(files, { packageMode: false })).toEqual([]);
    expect(checkBundle(files, { packageMode: true })).toEqual([
      { check: 'bundle', path: 'out/main/index.js', line: 2, detail: 'FakeProvider present in a package build' },
    ]);
  });
});

describe('runHygiene over temp git repos', () => {
  const quiet = (): { lines: string[]; log: (s: string) => void } => {
    const lines: string[] = [];
    return { lines, log: (s) => lines.push(s) };
  };

  it('fails a set deny-list variable that yields no terms (exit 2 path)', async () => {
    const dir = tempRepo({ 'src/a.ts': 'ok' });
    await expect(runHygiene({ root: dir, env: { ELI5_HYGIENE_DENYLIST: '# none\n' }, log: () => {} })).rejects.toThrow(
      /no terms/,
    );
  });

  it('matches the deny-list against tracked and out/** paths, binaries included', async () => {
    const dir = tempRepo(
      { 'assets/omicron-logo.png': '\u0000PNG' },
      { 'out/main/build-info.json': PUBLIC_BUILD_INFO, 'out/renderer/omicron.png': '\u0000PNG' },
    );
    const r = await runHygiene({ root: dir, env: { ELI5_HYGIENE_DENYLIST: 'omicron' }, outDir: 'out', log: () => {} });
    expect(r.findings.map((f) => [f.check, f.path])).toEqual([
      ['denylist', 'assets/omicron-logo.png'],
      ['denylist', 'out/renderer/omicron.png'],
    ]);
  });

  it('fails an out/ without the build-info record, and one built with a non-public overlay', async () => {
    const missing = tempRepo({ 'src/a.ts': 'ok' }, { 'out/main/index.js': 'x' });
    const r1 = await runHygiene({ root: missing, env: {}, outDir: 'out', log: () => {} });
    expect(r1.findings.map((f) => [f.check, f.path])).toEqual([['bundle', 'out/main/build-info.json']]);

    const cellF = tempRepo(
      { 'src/a.ts': 'ok' },
      {
        'out/main/index.js': 'const e = new Error("fixture overlay provider has no scripted responses");\n',
        'out/main/build-info.json': JSON.stringify({
          edition: 'enterprise',
          overlay: 'test/fixtures/overlay-fake/index.ts',
          foreign: ['test/fixtures/overlay-fake/index.ts'],
        }),
      },
    );
    const r2 = await runHygiene({ root: cellF, env: {}, outDir: 'out', packageMode: true, log: () => {} });
    expect(r2.ok).toBe(false);
    expect(new Set(r2.findings.map((f) => f.check))).toEqual(new Set(['bundle']));
  });

  it('passes a clean repo and notes the skipped deny-list scan', async () => {
    const dir = tempRepo({
      'src/a.ts': 'export const a = 1;\n',
      'config/hygiene-allow': DEFAULT_ALLOW,
      'docs/index.html': 'x',
    });
    const out = quiet();
    const r = await runHygiene({ root: dir, env: {}, log: out.log });
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(out.lines.join('\n')).toContain('deny-list scan skipped');
  });

  it('ignores untracked and gitignored files', async () => {
    const dir = tempRepo({ 'src/a.ts': 'ok', '.gitignore': '.env\n' }, { '.env': `KEY=${fakeKey()}\n` });
    const r = await runHygiene({ root: dir, env: {}, log: () => {} });
    expect(r.ok).toBe(true);
  });

  it('fails on a tracked overlay file and a committed secret', async () => {
    const dir = tempRepo({ 'enterprise/index.ts': 'export {}', 'src/k.ts': `const k = '${fakeKey()}';` });
    const out = quiet();
    const r = await runHygiene({ root: dir, env: {}, log: out.log });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => [f.check, f.path])).toEqual([
      ['tracked-path', 'enterprise/index.ts'],
      ['secret', 'src/k.ts'],
    ]);
    expect(out.lines.join('\n')).not.toContain(fakeKey());
  });

  it('runs the deny-list over tracked files and out/** when the variable is set', async () => {
    const dir = tempRepo(
      { 'README.md': 'Made by Omicron Labs\n' },
      {
        'out/main/index.js': 'const org = "OMICRON LABS";\n',
        'out/main/build-info.json': PUBLIC_BUILD_INFO,
        'notes.txt': 'omicron labs (untracked)',
      },
    );
    const out = quiet();
    const r = await runHygiene({
      root: dir,
      env: { ELI5_HYGIENE_DENYLIST: 'omicron labs' },
      outDir: 'out',
      log: out.log,
    });
    expect(r.findings.map((f) => [f.check, f.path])).toEqual([
      ['denylist', 'README.md'],
      ['denylist', 'out/main/index.js'],
    ]);
    expect(out.lines.join('\n').toLowerCase()).not.toContain('omicron');
  });

  it('scans out/** for secrets and bundle rules, skipping binaries', async () => {
    const dir = tempRepo(
      { 'src/a.ts': 'ok' },
      {
        'out/main/index.js': 'class FakeProvider {}\n',
        'out/main/build-info.json': PUBLIC_BUILD_INFO,
        'out/renderer/app.js': fakeUrlCreds(),
        'out/renderer/logo.png': `\u0000PNG${fakeKey()}`,
      },
    );
    const r = await runHygiene({ root: dir, env: {}, outDir: 'out', packageMode: true, log: () => {} });
    expect(r.findings.map((f) => [f.check, f.path])).toEqual([
      ['secret', 'out/renderer/app.js'],
      ['bundle', 'out/main/index.js'],
    ]);
  });

  it('fails when --out is given but the directory is missing', async () => {
    const dir = tempRepo({ 'src/a.ts': 'ok' });
    await expect(runHygiene({ root: dir, env: {}, outDir: 'out', log: () => {} })).rejects.toThrow(/out/);
  });
});

describe('this repository', () => {
  it('has no tracked-path or tracked-file secret findings under config/hygiene-allow', async () => {
    const r = await runHygiene({ root: repoRoot, env: {}, log: () => {} });
    expect(r.findings).toEqual([]);
  });

  it('whitelists exactly the public Pages paths from .gitignore', () => {
    const allow = parseAllowFile(readFileSync(join(repoRoot, 'config', 'hygiene-allow'), 'utf8'));
    expect(allow.paths).toEqual(['docs/.gitkeep', 'docs/.nojekyll', 'docs/index.html', 'docs/sample/']);
  });

  it('keeps secret exceptions narrow: no directory-wide test/** and no unpinned bundle-chunk globs', () => {
    const allow = parseAllowFile(readFileSync(join(repoRoot, 'config', 'hygiene-allow'), 'utf8'));
    for (const a of allow.secrets) {
      expect(a.glob, a.glob).not.toMatch(/\*\*/);
      if (a.glob.includes('*')) expect(a.preview, a.glob).toBeDefined();
    }
  });
});
