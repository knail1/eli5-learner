import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

test('an unsigned arm64 dmg and app are in release/', () => {
  const dmgs = readdirSync(RELEASE).filter((f) => f.endsWith('.dmg'));
  expect(dmgs.some((f) => f.startsWith(PRODUCT) && f.includes('arm64'))).toBe(true);
  expect(existsSync(EXE)).toBe(true);
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
  // Dev dependencies stay out of the app.
  for (const dev of ['electron', 'vitest', '@playwright', 'electron-builder', 'typescript', 'exceljs']) {
    expect(
      files.some((f) => f.startsWith(`node_modules/${dev}/`)),
      dev,
    ).toBe(false);
  }
  // The FakeProvider exists only in test builds (13 §5).
  expect(readAsarText(ASAR, 'out/main/index.js')).not.toContain('FakeProvider');
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
  expect(keyring.some((f) => f.path.includes('darwin-arm64'))).toBe(true);
});
