import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Shared Playwright `_electron` harness (13 §8.1): per-spec temp userData and library dirs, the
 * FakeProvider env, the library-root assertion, the modal guard and status-line capture. Specs need
 * an ELI5_TEST_BUILD=1 build (`npm run test:e2e`). Not a spec file itself (no `.e2e.ts` suffix).
 */

export const SOURCES = path.resolve('test/fixtures/sources');
export const DEFAULT_SCRIPT = path.resolve('test/fixtures/llm/default.json');
export const TITLE = 'How Example Widgets Inc. Plans Its Widget Supply';
// Assembled at runtime: the repo never holds a secret-shaped literal (13 §3).
export const TEST_KEY = ['sk', 'test', 'e2e'.repeat(8)].join('-');

export interface Dirs {
  root: string;
  userData: string;
  library: string;
}

export interface Launched {
  app: ElectronApplication;
  win: Page;
}

export interface LaunchOptions {
  /** false: no fake LLM and no test key (the no-key paths). */
  fake?: boolean;
  script?: string;
  /** Extra environment for this launch. */
  env?: Record<string, string>;
}

type FakeScript = { responses: Record<string, unknown> } & Record<string, unknown>;

/** Tracks launched apps and temp dirs; call `closeAll` in afterEach and `cleanup` in afterAll. */
export class Harness {
  readonly running: ElectronApplication[] = [];
  private readonly dirs: string[] = [];

  /** ELI5_FIXTURE_ORIGIN for launches, once the spec's fixture server is up (13 §6.4). */
  fixtureOrigin: string | undefined;

  async tempDirs(prefix = 'eli5-e2e-'): Promise<Dirs> {
    // realpath: the app reports resolved paths (macOS tmpdir is a /var -> /private/var symlink).
    const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
    this.dirs.push(root);
    return { root, userData: path.join(root, 'userData'), library: path.join(root, 'docs') };
  }

  async launch(dirs: Dirs, opts: LaunchOptions = {}): Promise<Launched> {
    const fake = opts.fake ?? true;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELI5_USER_DATA_DIR: dirs.userData,
      ELI5_LIBRARY_DIR: dirs.library,
      ELI5_KEYSTORE: 'memory',
      TZ: 'UTC',
      ...(this.fixtureOrigin ? { ELI5_FIXTURE_ORIGIN: this.fixtureOrigin } : {}),
    };
    delete env.ELI5_LLM_FAKE;
    delete env.ELI5_LLM_FAKE_SCRIPT;
    delete env.ELI5_TEST_API_KEY_CLAUDE;
    if (fake) {
      env.ELI5_LLM_FAKE = '1';
      env.ELI5_LLM_FAKE_SCRIPT = opts.script ?? DEFAULT_SCRIPT;
      env.ELI5_TEST_API_KEY_CLAUDE = TEST_KEY;
    }
    Object.assign(env, opts.env);
    const app = await electron.launch({ args: [path.resolve('.')], env });
    this.running.push(app);
    const win = await app.firstWindow();
    // The input zone listens for test drops once it has mounted.
    await expect(win.getByRole('form', { name: 'New explainer' })).toBeVisible();
    const testBuild = await app.evaluate(({ ipcMain }) => ipcMain.listenerCount('eli5:test:tray-click') > 0);
    expect(testBuild, 'needs an ELI5_TEST_BUILD=1 build (npm run test:e2e)').toBe(true);

    // Harness assertion (13 §8.1): the resolved library root is inside this spec's temp dir.
    const info = await win.evaluate(() => window.eli5.library.info());
    expect(info).toMatchObject({ ok: true, value: { root: expect.stringContaining(dirs.root + path.sep) } });

    // Modal guard (13 §8.1): record any dialog instead of showing it.
    await app.evaluate(({ dialog }) => {
      const calls: string[] = [];
      (globalThis as { __modalCalls?: string[] }).__modalCalls = calls;
      const d = dialog as unknown as Record<string, unknown>;
      for (const name of ['showMessageBox', 'showMessageBoxSync', 'showErrorBox']) {
        d[name] = () => {
          calls.push(name);
          return name === 'showMessageBox' ? Promise.resolve({ response: 0, checkboxChecked: false }) : 0;
        };
      }
    });
    await win.evaluate(() => {
      const w = window as unknown as { __statusLines: string[] };
      w.__statusLines = [];
      window.eli5.jobs.onChanged((s) => w.__statusLines.push(s.statusLine));
    });
    return { app, win };
  }

  /** Stops one app that the spec has finished with (e.g. before a relaunch on the same dirs). */
  async close(app: ElectronApplication): Promise<void> {
    const i = this.running.indexOf(app);
    if (i >= 0) this.running.splice(i, 1);
    await app.close().catch(() => {});
  }

  /** afterEach: every still-running app recorded zero modal calls (13 §8.1), then closes. */
  async closeAll(): Promise<void> {
    for (const a of this.running) {
      const modals = await a
        .evaluate(() => (globalThis as { __modalCalls?: string[] }).__modalCalls ?? [])
        .catch(() => [] as string[]);
      expect(modals).toEqual([]);
    }
    for (const a of this.running.splice(0)) await a.close().catch(() => {});
  }

  async cleanup(): Promise<void> {
    for (const a of this.running.splice(0)) await a.close().catch(() => {});
    for (const d of this.dirs.splice(0)) await rm(d, { recursive: true, force: true });
  }
}

/** A copy of the default fake script with overrides (latency, extra or replaced responses). */
export async function writeScript(
  dirs: Dirs,
  name: string,
  patch: { latencyMs?: number; responses?: Record<string, unknown> },
): Promise<string> {
  const script = JSON.parse(await readFile(DEFAULT_SCRIPT, 'utf8')) as FakeScript;
  const file = path.join(dirs.root, `${name}.json`);
  await writeFile(
    file,
    JSON.stringify({
      ...script,
      ...(patch.latencyMs !== undefined ? { latencyMs: patch.latencyMs } : {}),
      responses: { ...script.responses, ...patch.responses },
    }),
  );
  return file;
}

export async function dropFiles(win: Page, rel: string[]): Promise<void> {
  const paths = rel.map((r) => path.join(SOURCES, r));
  const chips = win.getByRole('list', { name: 'Added sources' });
  await win.evaluate((p) => window.__eli5Test?.dropPaths(p), paths);
  for (const p of paths) await expect(chips.getByText(path.basename(p))).toBeVisible();
}

export async function addUrl(win: Page, url: string): Promise<void> {
  const field = win.getByLabel('URL', { exact: true });
  await field.fill(url);
  await field.press('Enter');
}

export const statusLines = (win: Page): Promise<string[]> =>
  win.evaluate(() => (window as unknown as { __statusLines: string[] }).__statusLines);

export const jobLine = (win: Page) => win.locator('.job-line').last();
/** The pipeline-supplied status text of the newest job line (06 §6), without glyph or buttons. */
export const jobText = (win: Page) => jobLine(win).locator('.job-text');

export async function libraryEntries(win: Page): Promise<{ id: string; topicSlug: string; title: string }[]> {
  const r = await win.evaluate(() => window.eli5.library.list());
  return r.ok ? r.value : [];
}

/** The URL loaded in the viewer WebContentsView, or '' when none is attached. */
export async function viewerUrl(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const child = w?.contentView.children[0] as unknown as { webContents?: Electron.WebContents } | undefined;
    return child?.webContents?.getURL() ?? '';
  });
}

/** Drop one text source, Start, and wait for its `Done:` line; returns the new Library entry. */
export async function generate(
  l: Launched,
  rel = 'text/notes.md',
): Promise<{ id: string; topicSlug: string; title: string }> {
  const before = new Set((await libraryEntries(l.win)).map((e) => e.id));
  await dropFiles(l.win, [rel]);
  await l.win.getByRole('button', { name: 'Start' }).click();
  await expect
    .poll(async () => (await libraryEntries(l.win)).filter((e) => !before.has(e.id)).length, { timeout: 30_000 })
    .toBe(1);
  const entry = (await libraryEntries(l.win)).find((e) => !before.has(e.id));
  if (!entry) throw new Error('no new Library entry');
  await expect(jobText(l.win)).toHaveText(new RegExp(`^Done: `));
  return entry;
}
