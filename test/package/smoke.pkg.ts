import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { EXE, requirePackage } from './layout';

/**
 * Packaged-app smoke (01 §8.3, 13 §11): launches the real arm64 executable on a fresh profile and
 * drives the app window over CDP. Playwright's `_electron` needs `--inspect`, which the
 * EnableNodeCliInspectArguments fuse turns off (12 §7.8), so the app is spawned directly with
 * `--remote-debugging-port=0`. ELI5_USER_DATA_DIR is ignored when packaged (12 §4.1); Chromium's
 * `--user-data-dir` switch moves userData (and so the library root, 09 §3.1) into a temp dir.
 */

let userData: string;
let proc: ChildProcess | undefined;
let browser: Browser | undefined;
let win: Page;
let stderr = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  if (process.env.ELI5_RUN_PACKAGE_TESTS !== '1') return;
  userData = await realpath(await mkdtemp(path.join(tmpdir(), 'eli5-pkg-')));
  const child = spawn(EXE, [`--user-data-dir=${userData}`, '--remote-debugging-port=0'], {
    env: { ...process.env, TZ: 'UTC' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc = child;
  const ws = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no DevTools endpoint:\n${stderr}`)), 30_000);
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on('exit', (code, signal) => reject(new Error(`app exited (${String(code ?? signal)}):\n${stderr}`)));
  });
  browser = await chromium.connectOverCDP(ws);
  win = await appWindow(browser);
});

test.afterAll(async () => {
  await browser?.close().catch(() => {});
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise((r) => proc?.once('exit', r));
    proc.kill('SIGTERM');
    const t = setTimeout(() => proc?.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(t);
  }
  if (userData) await rm(userData, { recursive: true, force: true });
});

test.beforeEach(requirePackage);

test('the packaged app opens its window on a temp profile', async () => {
  await expect(win).toHaveTitle('ELI5 Learner');
  await expect(win.getByRole('heading', { name: 'Turn anything into an explainer.' })).toBeVisible();
  // Bootstrap ran as a packaged build and logged into the temp profile, not the real one.
  const log = await readFile(path.join(userData, 'logs', 'main.log'), 'utf8');
  expect(log).toContain('"event":"app.start"');
  expect(log).toContain('"status":"packaged"');
});

test('EditionInfo is public and the Library is empty', async () => {
  const info = await win.evaluate(() => window.eli5.edition.info());
  expect(info).toMatchObject({ ok: true, value: { edition: 'public', overlayLoaded: false, uiFeatures: [] } });
  const root = await win.evaluate(() => window.eli5.library.info());
  // Packaged: <userData>/docs (01 §8.4).
  expect(root).toMatchObject({ ok: true, value: { root: path.join(userData, 'docs') } });
  expect(await win.evaluate(() => window.eli5.library.list())).toEqual({ ok: true, value: [] });
  await expect(win.getByText('Your finished documents will appear here')).toBeVisible();
});

test('Settings open', async () => {
  await win.getByRole('button', { name: 'Settings' }).click();
  await expect(win.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(win.getByText('Public edition')).toBeVisible();
  const settings = await win.evaluate(() => window.eli5.settings.get());
  expect(settings).toMatchObject({ ok: true });
});

test('bundled prompts and skills load from resourcesPath', async () => {
  // Bootstrap loads every prompt from resourcePath('prompts') and throws on a missing one
  // (02 §10), before IPC is registered; the skills library is built beside it (02 §11). A working
  // IPC round trip after boot therefore means both loaded from Contents/Resources.
  expect(await win.evaluate(() => window.eli5.jobs.list())).toMatchObject({ ok: true });
  const log = await readFile(path.join(userData, 'logs', 'main.log'), 'utf8');
  for (const bad of ['"level":"error"', 'pipeline.init-failed', 'llm.skills-watch-failed', 'Prompt file']) {
    expect(log, bad).not.toContain(bad);
  }
});

/** The app renderer entry: file:// out/renderer, or a custom app scheme serving it from the asar. */
const APP_PAGE = /^(file:.*\/renderer|[a-z0-9]+:\/\/app)\/index\.html$/;

/** The main window's page; the viewer and pdf-render views are other CDP targets. */
async function appWindow(b: Browser): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    for (const ctx of b.contexts()) {
      const page = ctx.pages().find((p) => APP_PAGE.test(p.url()));
      if (page) return page;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no app window:\n${stderr}`);
}
