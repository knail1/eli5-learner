import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

  /** Modal-guard calls recorded in one app's main process (13 §8.1); [] once it has exited. */
  private modalCalls(app: ElectronApplication): Promise<string[]> {
    return app
      .evaluate(() => (globalThis as { __modalCalls?: string[] }).__modalCalls ?? [])
      .catch(() => [] as string[]);
  }

  /** afterEach for specs that share one app across tests: zero modal calls so far, app kept running. */
  async assertNoModals(): Promise<void> {
    for (const a of this.running) expect(await this.modalCalls(a)).toEqual([]);
  }

  /** Stops one app that the spec has finished with (e.g. before a relaunch), after the modal check. */
  async close(app: ElectronApplication): Promise<void> {
    const i = this.running.indexOf(app);
    if (i >= 0) this.running.splice(i, 1);
    const modals = await this.modalCalls(app);
    await app.close().catch(() => {});
    expect(modals).toEqual([]);
  }

  /** afterEach: every still-running app recorded zero modal calls (13 §8.1), then closes. */
  async closeAll(): Promise<void> {
    const modals = await Promise.all(this.running.map((a) => this.modalCalls(a)));
    for (const a of this.running.splice(0)) await a.close().catch(() => {});
    expect(modals.flat()).toEqual([]);
  }

  async cleanup(): Promise<void> {
    for (const a of this.running.splice(0)) await a.close().catch(() => {});
    for (const d of this.dirs.splice(0)) await rm(d, { recursive: true, force: true });
  }
}

/** A copy of the default fake script with overrides (latency, extra or replaced responses, injected errors). */
export async function writeScript(
  dirs: Dirs,
  name: string,
  patch: { latencyMs?: number; responses?: Record<string, unknown>; errors?: Record<string, string | string[]> },
): Promise<string> {
  const script = JSON.parse(await readFile(DEFAULT_SCRIPT, 'utf8')) as FakeScript;
  const file = path.join(dirs.root, `${name}.json`);
  await writeFile(
    file,
    JSON.stringify({
      ...script,
      ...(patch.latencyMs !== undefined ? { latencyMs: patch.latencyMs } : {}),
      ...(patch.errors ? { errors: patch.errors } : {}),
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

/**
 * Clicks Start until the draft clears. Start is debounced 400 ms against a double Enter (11 §5.4),
 * so a click right after the previous start is ignored by design.
 */
export async function startDraft(win: Page): Promise<void> {
  await expect(async () => {
    await win.getByRole('button', { name: 'Start' }).click();
    await expect(win.getByRole('list', { name: 'Added sources' })).toHaveCount(0, { timeout: 500 });
  }).toPass();
}

/** The saved `index.html` of a Library document, under the resolved library root (09 §3). */
export async function docPath(win: Page, slug: string): Promise<string> {
  const info = await win.evaluate(() => window.eli5.library.info());
  if (!info.ok) throw new Error('library info unavailable');
  return path.join(info.value.root, slug, 'index.html');
}

/** Drop one text source, Start, and wait for its `Done:` line; returns the new Library entry. */
export async function generate(
  l: Launched,
  rel = 'text/notes.md',
): Promise<{ id: string; topicSlug: string; title: string }> {
  const before = new Set((await libraryEntries(l.win)).map((e) => e.id));
  await dropFiles(l.win, [rel]);
  await startDraft(l.win);
  await expect
    .poll(async () => (await libraryEntries(l.win)).filter((e) => !before.has(e.id)).length, { timeout: 30_000 })
    .toBe(1);
  const entry = (await libraryEntries(l.win)).find((e) => !before.has(e.id));
  if (!entry) throw new Error('no new Library entry');
  await expect(jobText(l.win)).toHaveText(new RegExp(`^Done: `));
  // 13 §7.2: every e2e-generated document passes the runtime probe.
  await probeDocument(l.app, await docPath(l.win, entry.topicSlug));
  return entry;
}

/** One request the FakeProvider received (13 §6.1 step 4), flattened for assertions. */
export interface RecordedCall {
  taskId: string;
  imageCount: number;
  /** All message text of the request, joined. */
  text: string;
}

/** Every request the test build's FakeProvider(s) recorded, in order (13 §8.2 E2). */
export async function fakeCalls(app: ElectronApplication): Promise<RecordedCall[]> {
  return app.evaluate(() => {
    type Call = { taskId: string; imageCount: number; messages: { text: string }[] };
    const providers = (globalThis as { __eli5FakeProviders?: { calls: Call[] }[] }).__eli5FakeProviders ?? [];
    return providers.flatMap((p) =>
      p.calls.map((c) => ({
        taskId: c.taskId,
        imageCount: c.imageCount,
        text: c.messages.map((m) => m.text).join('\n'),
      })),
    );
  });
}

/** Records shell.openPath / openExternal / showItemInFolder instead of reaching Finder or a browser. */
export async function spyShell(app: ElectronApplication): Promise<() => Promise<[string, string][]>> {
  await app.evaluate(({ shell }) => {
    const calls: [string, string][] = [];
    (globalThis as { __shellCalls?: unknown }).__shellCalls = calls;
    const s = shell as unknown as Record<string, unknown>;
    s.openPath = (p: string) => (calls.push(['openPath', p]), Promise.resolve(''));
    s.openExternal = (u: string) => (calls.push(['openExternal', u]), Promise.resolve());
    s.showItemInFolder = (p: string) => void calls.push(['showItemInFolder', p]);
  });
  return () => app.evaluate(() => (globalThis as { __shellCalls?: [string, string][] }).__shellCalls ?? []);
}

/** What the runtime probe saw (13 §7.2). `wide` is the glossary layout before and after the resize. */
export interface ProbeReport {
  requests: string[];
  consoleErrors: string[];
  tabs: string[];
  notes: number;
  wide: boolean[];
}

let probeSeq = 0;

/**
 * 13 §7.2 runtime rule: opens `file` in a hidden BrowserWindow on its own partition, whose
 * webRequest records and cancels every non-`file:`/`data:` request, then switches every tab,
 * toggles every glossary note, resizes below the 1100 px glossary breakpoint and does it again.
 */
export async function runProbe(app: ElectronApplication, file: string): Promise<ProbeReport> {
  const partition = `eli5-probe-${String(process.pid)}-${String(++probeSeq)}`;
  return app.evaluate(
    async ({ BrowserWindow, session }, { url, partition }) => {
      const requests: string[] = [];
      const consoleErrors: string[] = [];
      const ses = session.fromPartition(partition);
      ses.webRequest.onBeforeRequest((d, cb) => {
        if (/^(file|data):/i.test(d.url)) return cb({});
        requests.push(d.url);
        cb({ cancel: true });
      });
      const w = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        useContentSize: true,
        webPreferences: { partition, sandbox: true, contextIsolation: true, backgroundThrottling: false },
      });
      const wc = w.webContents;
      wc.on('console-message', (e: unknown, lvl?: unknown, msg?: unknown) => {
        // Electron 44 passes one details object; older builds passed (event, level, message).
        const ev = e as { level?: unknown; message?: unknown };
        const level = ev.level ?? lvl;
        if (level === 'error' || level === 3) consoleErrors.push(String(ev.message ?? msg));
      });
      wc.on('render-process-gone', (_e, d) => consoleErrors.push(`renderer gone: ${d.reason}`));
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // Every tab in turn; in each, every glossary note's summary twice (open/close, then back).
      const walk = `(async () => {
        const tick = () => new Promise((r) => setTimeout(r, 30));
        const keys = [];
        for (const b of document.querySelectorAll('nav.tabbar [role="tab"]')) {
          b.click(); await tick();
          keys.push((b.getAttribute('aria-controls') || '').replace(/^tab-/, ''));
          for (const s of document.querySelectorAll('.tabpanel:not([hidden]) details.gl-note > summary')) {
            s.click(); await tick(); s.click(); await tick();
          }
        }
        return { keys, notes: document.querySelectorAll('details.gl-note').length,
          wide: document.documentElement.classList.contains('gl-wide') };
      })()`;
      try {
        await w.loadURL(url);
        const first = (await wc.executeJavaScript(walk)) as { keys: string[]; notes: number; wide: boolean };
        w.setContentSize(800, 900);
        for (let i = 0; i < 40 && (await wc.executeJavaScript('innerWidth')) !== 800; i++) await pause(50);
        await pause(150);
        const second = (await wc.executeJavaScript(walk)) as { wide: boolean };
        await pause(150);
        return { requests, consoleErrors, tabs: first.keys, notes: first.notes, wide: [first.wide, second.wide] };
      } finally {
        ses.webRequest.onBeforeRequest(null);
        w.destroy();
      }
    },
    { url: pathToFileURL(file).href, partition },
  );
}

/**
 * The pass condition of 13 §7.2 for a generated document: zero requests, zero console errors, both
 * built-in tabs walked, and the glossary switched from margin notes to inline below the breakpoint.
 */
export async function probeDocument(app: ElectronApplication, file: string): Promise<ProbeReport> {
  const r = await runProbe(app, file);
  expect(r.requests, `network requests from ${file}`).toEqual([]);
  expect(r.consoleErrors, `console errors from ${file}`).toEqual([]);
  expect(r.tabs.slice(0, 2)).toEqual(['indepth', 'eli5']);
  expect(r.wide).toEqual([true, false]);
  return r;
}

/** Opens a Library entry by title from the sidebar. */
export async function openFromLibrary(win: Page, title: string): Promise<void> {
  await win
    .getByRole('navigation', { name: 'Library' })
    .getByRole('button', { name: new RegExp(title) })
    .first()
    .click();
}
