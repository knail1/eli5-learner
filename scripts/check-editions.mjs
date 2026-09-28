#!/usr/bin/env node
// check-editions.mjs: edition matrix build cells (spec/tech/13-testing-quality.md §10.1).
//
//   F          ELI5_EDITION=enterprise ELI5_OVERLAY_DIR=test/fixtures/overlay-fake builds, the main
//              bundle contains the fixture overlay (and its FakeProvider), and loadOverlay's
//              enterprise branch is compiled in (`__ELI5_EDITION__` was 'enterprise'). Its runtime
//              behaviour is covered by test/unit/main/editions/load-overlay.enterprise.test.ts.
//   F-missing  An enterprise build whose overlay directory is absent fails with the documented
//              message (01 §6.5): "Enterprise build requires an overlay at <dir>/index.ts (set ELI5_OVERLAY_DIR)".
//   P-stub     The public build (even with ELI5_OVERLAY_DIR set) writes a real main bundle (public
//              stubs present) with no overlay code, no FakeProvider and no enterprise loader branch,
//              and the P-stub unit suite passes (every stub throws its hook id).
//
// Builds go to a temp --outDir, so out/ is never touched. Offline; no keys.
//
// Usage: node scripts/check-editions.mjs [--cell F|F-missing|P-stub]... [--list] [--keep]
// Exit 0 when every selected cell passes, 1 on a failing cell, 2 on bad arguments.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'node_modules', '.bin');
const OVERLAY_DIR = 'test/fixtures/overlay-fake';
const CELLS = ['F', 'F-missing', 'P-stub'];

/** Strings only the fixture overlay puts into a bundle (test/fixtures/overlay-fake). */
const OVERLAY_MARKERS = ['Fixture overlay', 'docs.example.test', 'fixture-gateway-model'];
/** Present only when loadOverlay's enterprise branch survives dead-code elimination (01 §6.5 step 5). */
const ENTERPRISE_LOADER = 'Enterprise build without overlay';
/** Public stubs are registered in every edition, so any real main bundle contains their hook ids. */
const PUBLIC_MARKERS = ['HOOK-LLM-01', 'HOOK-AUTH-01'];

function parseArgs(argv) {
  const opts = { cells: [], list: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.list = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--cell') {
      const c = argv[++i];
      if (!CELLS.includes(c)) throw new Error(`Unknown cell "${c}" (expected ${CELLS.join(', ')})`);
      opts.cells.push(c);
    } else throw new Error(`Unknown argument "${a}"`);
  }
  if (opts.cells.length === 0) opts.cells = [...CELLS];
  return opts;
}

/** Build env: inherited, minus every edition/test switch, plus `extra`. */
function envWith(extra) {
  const env = { ...process.env };
  for (const k of ['ELI5_EDITION', 'ELI5_OVERLAY_DIR', 'ELI5_TEST_BUILD']) delete env[k];
  return { ...env, ...extra };
}

function run(cmd, args, env) {
  const r = spawnSync(join(BIN, cmd), args, { cwd: ROOT, env, encoding: 'utf8', timeout: 600_000 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

function build(outDir, extra) {
  return run(
    'electron-vite',
    ['build', '--config', 'config/electron.vite.config.ts', '--outDir', outDir, '--logLevel', 'warn'],
    envWith(extra),
  );
}

/** Concatenated JS of the main-process bundle. */
function mainBundle(outDir) {
  const dir = join(outDir, 'main');
  if (!existsSync(dir)) return '';
  return readdirSync(dir, { recursive: true })
    .filter((f) => String(f).endsWith('.js'))
    .map((f) => readFileSync(join(dir, String(f)), 'utf8'))
    .join('\n');
}

/** The document builder inlines the doc-runtime, so it must exist before an app build. */
function ensureDocRuntime() {
  if (existsSync(join(ROOT, 'build/doc-runtime/runtime.iife.js'))) return;
  const r = run('vite', ['build', '--config', 'config/vite.doc-runtime.config.ts', '--logLevel', 'warn'], envWith({}));
  if (r.status !== 0) throw new Error(`doc-runtime build failed:\n${r.out}`);
}

const CHECKS = {
  F(tmp) {
    const outDir = join(tmp, 'F');
    const r = build(outDir, { ELI5_EDITION: 'enterprise', ELI5_OVERLAY_DIR: OVERLAY_DIR });
    if (r.status !== 0) return [`enterprise build with the fixture overlay failed:\n${r.out}`];
    const js = mainBundle(outDir);
    return [...OVERLAY_MARKERS, 'FakeProvider', ENTERPRISE_LOADER, ...PUBLIC_MARKERS]
      .filter((m) => !js.includes(m))
      .map((m) => `enterprise main bundle lacks "${m}"`);
  },

  'F-missing'(tmp) {
    const outDir = join(tmp, 'F-missing');
    const dir = join(tmp, 'no-overlay');
    const r = build(outDir, { ELI5_EDITION: 'enterprise', ELI5_OVERLAY_DIR: dir });
    const expected = `Enterprise build requires an overlay at ${dir}/index.ts (set ELI5_OVERLAY_DIR)`;
    const problems = [];
    if (r.status === 0) problems.push('enterprise build without an overlay succeeded');
    if (!r.out.includes(expected)) problems.push(`build output lacks "${expected}":\n${r.out}`);
    if (mainBundle(outDir) !== '') problems.push('a main bundle was written despite the missing overlay');
    return problems;
  },

  'P-stub'(tmp) {
    const outDir = join(tmp, 'P');
    // The overlay dir is ignored unless ELI5_EDITION=enterprise (HOOK-CFG-02).
    const r = build(outDir, { ELI5_OVERLAY_DIR: OVERLAY_DIR });
    if (r.status !== 0) return [`public build failed:\n${r.out}`];
    const js = mainBundle(outDir);
    if (js === '') return [`public build wrote no main bundle under ${join(outDir, 'main')}`];
    const problems = [
      ...PUBLIC_MARKERS.filter((m) => !js.includes(m)).map((m) => `public main bundle lacks "${m}"`),
      ...[...OVERLAY_MARKERS, 'FakeProvider', ENTERPRISE_LOADER]
        .filter((m) => js.includes(m))
        .map((m) => `public main bundle contains "${m}"`),
    ];
    const t = run(
      'vitest',
      ['run', '--config', 'config/vitest.config.ts', '--project', 'unit', 'test/unit/main/editions/p-stub.test.ts'],
      envWith({}),
    );
    if (t.status !== 0) problems.push(`P-stub unit suite failed:\n${t.out}`);
    return problems;
  },
};

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (opts.list) {
    console.log(CELLS.join('\n'));
    return 0;
  }
  ensureDocRuntime();
  const tmp = mkdtempSync(join(tmpdir(), 'eli5-editions-'));
  let failed = 0;
  try {
    for (const cell of opts.cells) {
      const problems = CHECKS[cell](tmp);
      if (problems.length === 0) {
        console.log(`cell ${cell}: pass`);
      } else {
        failed++;
        console.log(`cell ${cell}: FAIL`);
        for (const p of problems) console.log(`  - ${p}`);
      }
    }
  } finally {
    if (opts.keep) console.log(`builds kept in ${tmp}`);
    else rmSync(tmp, { recursive: true, force: true });
  }
  return failed === 0 ? 0 : 1;
}

process.exitCode = main();
