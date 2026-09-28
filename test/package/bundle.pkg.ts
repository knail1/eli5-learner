import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import fuses from '@electron/fuses';
import { expect, test } from '@playwright/test';
import {
  APP,
  ASAR,
  EXE,
  PRODUCT,
  RELEASE,
  RESOURCES,
  UNPACKED,
  listAsar,
  readAsarText,
  requirePackage,
} from './layout';

/** Static checks of the packaged arm64 app (01 §8.3, 12 §7.8). */

// CommonJS package: its enums are not visible as ESM named exports.
const { FuseV1Options, getCurrentFuseWire } = fuses;
/** FuseState is not exported from the package root: fuse wire bytes are ASCII '0' and '1'. */
const DISABLE = 0x30;
const ENABLE = 0x31;
/** Files under a folder, recursively; electron-builder skips dotfiles such as placeholder keeps. */
const listed = (dir: string): string[] =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => !f.split('/').some((p) => p.startsWith('.')))
    .sort();

test.beforeEach(requirePackage);

/** Packed out/main JavaScript: the entry, the extract worker and every dynamic-import chunk. */
const packedMainJs = (): string[] =>
  listAsar(ASAR)
    .map((f) => f.path)
    .filter((f) => f.startsWith('out/main/') && f.endsWith('.js'));

/** codesign writes its report to stderr. */
const codesign = (...args: string[]) => spawnSync('codesign', args, { encoding: 'utf8' });

/** The 12 §7.8 entitlement rule: allow-jit only. */
function expectOnlyAllowJit(plist: string): void {
  expect(plist).toContain('<key>com.apple.security.cs.allow-jit</key>');
  expect(plist).not.toContain('com.apple.security.cs.allow-unsigned-executable-memory');
  expect(plist).not.toContain('com.apple.security.cs.disable-library-validation');
  expect([...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])).toEqual(['com.apple.security.cs.allow-jit']);
}

test('an unsigned arm64 dmg and app are in release/', () => {
  const dmgs = readdirSync(RELEASE).filter((f) => f.startsWith(PRODUCT) && f.endsWith('-arm64.dmg'));
  expect(dmgs.length).toBeGreaterThan(0);
  expect(existsSync(EXE)).toBe(true);
  // Apple silicon only (01 §8.3).
  expect(execFileSync('lipo', ['-archs', EXE], { encoding: 'utf8' }).trim().split(/\s+/)).toEqual(['arm64']);
  // Public build without credentials: ad-hoc signed, no team identity, and a valid seal so it launches.
  const info = codesign('-dv', APP);
  expect(info.status, info.stderr).toBe(0);
  expect(info.stderr).toContain('Signature=adhoc');
  expect(info.stderr).toContain('TeamIdentifier=not set');
  const verify = codesign('--verify', '--deep', '--strict', APP);
  expect(verify.status, verify.stderr).toBe(0);
});

test('entitlements grant allow-jit only (12 §7.8)', () => {
  expectOnlyAllowJit(readFileSync('config/packaging/entitlements.mac.plist', 'utf8'));
  // A signed build embeds them; the ad-hoc public build may carry none, which grants nothing.
  const embedded = codesign('-d', '--entitlements', '-', '--xml', EXE);
  expect(embedded.status, embedded.stderr).toBe(0);
  if (embedded.stdout.includes('<plist')) expectOnlyAllowJit(embedded.stdout);
});

test('release/ was built from the current out/ (no stale artifact)', () => {
  const packed = packedMainJs();
  expect(packed).toContain('out/main/index.js');
  for (const f of packed)
    expect(readAsarText(ASAR, f) === readFileSync(f, 'utf8'), `${f} differs from out/`).toBe(true);
  expect(readAsarText(ASAR, 'out/renderer/index.html')).toBe(readFileSync('out/renderer/index.html', 'utf8'));
  // Content, not mtime, ties the app to out/ (a rebuild of identical sources stays valid); the dmg
  // must then be packed from this app, not left over from an earlier run.
  const packedAt = statSync(ASAR).mtimeMs;
  const dmgs = readdirSync(RELEASE).filter((f) => f.startsWith(PRODUCT) && f.endsWith('-arm64.dmg'));
  expect(dmgs.some((f) => statSync(path.join(RELEASE, f)).mtimeMs >= packedAt)).toBe(true);
});

test('the Electron fuses in 12 §7.8 are set', async () => {
  const wire = await getCurrentFuseWire(EXE);
  const expected: [fuses.FuseV1Options, number][] = [
    [FuseV1Options.RunAsNode, DISABLE],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, DISABLE],
    [FuseV1Options.EnableNodeCliInspectArguments, DISABLE],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, ENABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, ENABLE],
    [FuseV1Options.EnableCookieEncryption, ENABLE],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, DISABLE],
  ];
  for (const [fuse, state] of expected) expect(wire[fuse], FuseV1Options[fuse]).toBe(state);
});

test('Info.plist carries the ASAR integrity hash and no LSUIElement (01 §8.3)', () => {
  const plist = readFileSync(path.join(APP, 'Contents', 'Info.plist'), 'utf8');
  expect(plist).toContain('<key>ElectronAsarIntegrity</key>');
  expect(plist).toContain('<string>io.github.eli5-learner</string>');
  expect(plist).not.toContain('<key>LSUIElement</key>');
});

test("the app icon is the project's own, not Electron's default", () => {
  const plist = readFileSync(path.join(APP, 'Contents', 'Info.plist'), 'utf8');
  const iconFile = /<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  expect(iconFile).toBe('icon.icns');
  const packed = readFileSync(path.join(RESOURCES, 'icon.icns'));
  expect(packed.equals(readFileSync('config/packaging/icon.icns'))).toBe(true);
});

test('the asar holds out/**, package.json and production dependencies only', () => {
  const files = listAsar(ASAR).map((f) => f.path);
  expect(files).toContain('package.json');
  expect(files).toContain('out/main/index.js');
  expect(files).toContain('out/main/extract-worker.js');
  expect(files).toContain('out/preload/app.cjs');
  expect(files).toContain('out/renderer/index.html');
  const top = new Set(files.map((f) => f.split('/')[0] ?? f));
  expect([...top].filter((t) => !['out', 'package.json', 'node_modules'].includes(t))).toEqual([]);
  // Never shipped (01 §8.3): tests, spec, enterprise overlay, docs, the doc-runtime pre-step, maps.
  const forbidden = /(^|\/)(test|spec|enterprise|docs|src)\/|^build\/|\.map$|\.test\.[cm]?[jt]sx?$/;
  expect(files.filter((f) => !f.startsWith('node_modules/') && forbidden.test(f))).toEqual([]);
  // Dev dependencies stay out of the app (01 §7), unless one is also a runtime dependency.
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const devOnly = Object.keys(pkg.devDependencies ?? {}).filter((d) => !(d in (pkg.dependencies ?? {})));
  expect(devOnly).toContain('electron');
  const shipped = files.filter((f) => devOnly.some((d) => f.startsWith(`node_modules/${d}/`)));
  expect(shipped).toEqual([]);
});

test('no test-only code ships in any out/main chunk (13 §5)', () => {
  const packed = packedMainJs();
  expect(packed).toContain('out/main/extract-worker.js');
  expect(packed.some((f) => f.startsWith('out/main/chunks/'))).toBe(true);
  for (const f of packed) {
    const js = readAsarText(ASAR, f);
    // The ELI5_LLM_FAKE check itself survives in dead code; the fake module never does.
    for (const needle of ['FakeProvider', 'loadFakeScript']) expect(js.includes(needle), `${f}: ${needle}`).toBe(false);
  }
});

test('extraResources ship prompts, skills, help, pdf-render, pdfjs and tray icons', () => {
  const want = [
    'prompts/in-depth.md',
    'prompts/eli5.md',
    'prompts/summary.md',
    'skills/THIRD_PARTY.md',
    'skills/eli5/SKILL.md',
    'skills/beautiful-doc/SKILL.md',
    'skills/beautiful-doc/theme.css',
    'help/publish-github-pages.html',
    'pdf-render/render.html',
    'pdf-render/preload.cjs',
    'pdfjs/pdf.mjs',
    'pdfjs/pdf.worker.mjs',
    'tray/trayTemplate.png',
    'tray/trayTemplate@2x.png',
    'tray/trayBusyTemplate.png',
    'tray/trayBusyTemplate@2x.png',
  ];
  for (const rel of want) expect(existsSync(path.join(RESOURCES, rel)), rel).toBe(true);
  // Every prompt file in the repo ships.
  expect(listed(path.join(RESOURCES, 'prompts'))).toEqual(listed('resources/prompts'));
  // The vendored upstream folders ship whole (02 §11).
  for (const dir of ['skills/eli5/upstream', 'skills/beautiful-doc/html-effectiveness']) {
    const shipped = listed(path.join(RESOURCES, dir));
    expect(shipped.length, dir).toBeGreaterThan(0);
    expect(shipped, dir).toEqual(listed(path.join('resources', dir)));
  }
  // pdf.js ships the two files only.
  expect(readdirSync(path.join(RESOURCES, 'pdfjs')).sort()).toEqual(['pdf.mjs', 'pdf.worker.mjs']);
});

test('the @napi-rs/keyring native module is unpacked from the asar', () => {
  const natives = listAsar(ASAR).filter((f) => f.path.endsWith('.node'));
  const keyring = natives.filter((f) => f.path.startsWith('node_modules/@napi-rs/keyring'));
  expect(keyring.length).toBeGreaterThan(0);
  for (const f of natives) {
    expect(f.unpacked, f.path).toBe(true);
    expect(existsSync(path.join(UNPACKED, f.path)), f.path).toBe(true);
  }
  // The keyring binary matches the executable's architecture (01 §8.3: per-arch dmgs), so an x64
  // build pointed at by ELI5_PACKAGED_APP is checked the same way.
  const archs = execFileSync('lipo', ['-archs', EXE], { encoding: 'utf8' }).trim().split(/\s+/);
  for (const arch of archs)
    expect(
      keyring.some((f) => f.path.includes(`keyring-darwin-${arch}/`)),
      arch,
    ).toBe(true);
  for (const f of keyring) {
    const m = /keyring-darwin-([a-z0-9]+)\//.exec(f.path);
    if (m) expect(archs, f.path).toContain(m[1]);
    expect(
      execFileSync('lipo', ['-archs', path.join(UNPACKED, f.path)], { encoding: 'utf8' })
        .trim()
        .split(/\s+/),
    ).toEqual(archs);
  }
});
