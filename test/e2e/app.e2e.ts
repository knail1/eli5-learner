import { spawn } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import electronPath from 'electron';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { validateDocument } from '../helpers/doc-validity';
import {
  DEFAULT_SCRIPT,
  Harness,
  TEST_KEY,
  TITLE,
  generate,
  libraryEntries,
  openFromLibrary,
  spyShell,
  viewerUrl,
  writeScript,
  type Dirs,
  type Launched,
} from './harness';

/**
 * App shell end to end (13 §8.2 E10, E12, E15; 11 §3, §4, §5.3, §7; 01 §9): the Tray's last three
 * documents and their clicks, state after relaunch, a second launch focusing the running window,
 * viewer crash recovery, Reveal in Finder, the API key never echoed back, and an action on a
 * document stamped by a prior version. FakeProvider only; needs a test build (ELI5_TEST_BUILD=1).
 */

test.describe.configure({ mode: 'serial' });

const h = new Harness();
test.afterAll(() => h.cleanup());
// PRD: no modals anywhere in the app (13 §8.1 modal guard).
test.afterEach(() => h.closeAll());

interface TrayState {
  labels: string[];
  tooltip: string;
  quit: string;
}

/** Drives the Tray through the test-only `eli5:test:tray-click` channel (13 §8.3). */
function tray(app: ElectronApplication, req: { click?: string } = {}): Promise<TrayState> {
  return app.evaluate(({ ipcMain }, r) => {
    let state: TrayState = { labels: [], tooltip: '', quit: '' };
    ipcMain.emit('eli5:test:tray-click', {}, { ...r, inspect: (s: TrayState) => (state = s) });
    return state;
  }, req);
}

const windowState = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow, app: a }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { count: BrowserWindow.getAllWindows().length, visible: w?.isVisible() ?? false, dock: a.dock?.isVisible() };
  });

const hideWindow = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());

/**
 * Page text of the main window or the viewer, read from main (the viewer is a native layer over the
 * renderer). '' while the page is crashed, gone, or still the page marked by `crashPage`.
 */
const pageText = (app: ElectronApplication, which: 'main' | 'viewer') =>
  app.evaluate(async ({ BrowserWindow }, t) => {
    const w = BrowserWindow.getAllWindows()[0];
    const child = w?.contentView.children[0] as unknown as { webContents?: Electron.WebContents } | undefined;
    const wc = t === 'main' ? w?.webContents : child?.webContents;
    if (!wc || wc.isDestroyed() || wc.isCrashed()) return '';
    const js = '(window.__eli5Stale ? "" : document.body ? document.body.innerText : "")';
    return ((await wc.executeJavaScript(js).catch(() => '')) as string) ?? '';
  }, which);

const viewerText = (app: ElectronApplication) => pageText(app, 'viewer');

/** Marks the current page (so a reload is observable), then crashes its renderer process. */
const crashPage = (app: ElectronApplication, which: 'main' | 'viewer') =>
  app.evaluate(async ({ BrowserWindow }, t) => {
    const w = BrowserWindow.getAllWindows()[0];
    const child = w?.contentView.children[0] as unknown as { webContents?: Electron.WebContents } | undefined;
    const wc = t === 'main' ? w?.webContents : child?.webContents;
    await wc?.executeJavaScript('window.__eli5Stale = true');
    wc?.forcefullyCrashRenderer();
  }, which);

const crashViewer = (app: ElectronApplication) => crashPage(app, 'viewer');

/** A fake script whose successive in-depth drafts carry the given titles (one per job). */
async function titledScript(dirs: Dirs, titles: string[]): Promise<string> {
  const base = JSON.parse(await readFile(DEFAULT_SCRIPT, 'utf8')) as { responses: Record<string, unknown> };
  const indepth = base.responses['in-depth'] as Record<string, unknown>;
  return writeScript(dirs, 'titled', { responses: { 'in-depth': titles.map((title) => ({ ...indepth, title })) } });
}

test('E12/E15: the Tray lists the last 3 documents, opens one into a hidden window, and survives a relaunch', async () => {
  const dirs = await h.tempDirs('eli5-e2e-app-tray-');
  const titles = ['Widget Plan One', 'Widget Plan Two', 'Widget Plan Three', 'Widget Plan Four'];
  const script = await titledScript(dirs, titles);
  const l = await h.launch(dirs, { script });
  const made: { title: string; topicSlug: string }[] = [];
  for (let i = 0; i < titles.length; i++) made.push(await generate(l, i % 2 ? 'text/plain.txt' : 'text/notes.md'));
  expect(made.map((m) => m.title)).toEqual(titles);

  const newestThree = ['Widget Plan Four', 'Widget Plan Three', 'Widget Plan Two'];
  await expect
    .poll(async () => (await tray(l.app)).labels)
    .toEqual([...newestThree, 'Open ELI5 Learner', 'Settings…', 'Quit']);

  // Closed window: the app keeps running; a Tray entry reopens it on that document (11 §4.1).
  await hideWindow(l.app);
  await expect.poll(() => windowState(l.app)).toMatchObject({ count: 1, visible: false });
  await tray(l.app, { click: 'Widget Plan Two' });
  await expect.poll(() => windowState(l.app)).toMatchObject({ count: 1, visible: true, dock: true });
  const two = made.find((m) => m.title === 'Widget Plan Two')?.topicSlug ?? '';
  await expect.poll(() => viewerUrl(l.app)).toBe(`eli5doc://doc/${two}/index.html`);
  await expect(l.win.locator('.doc-header h1')).toHaveText('Widget Plan Two');
  await h.close(l.app);

  // E15: the same userData and Library dirs bring back the Library and the Tray.
  const again = await h.launch(dirs, { script });
  expect((await libraryEntries(again.win)).map((e) => e.title)).toEqual([...titles].reverse());
  await expect.poll(async () => (await tray(again.app)).labels.slice(0, 3)).toEqual(newestThree);
  // Quit from the Tray exits the app (11 §3.2 step 3).
  const closed = again.app.waitForEvent('close');
  await tray(again.app, { click: 'Quit' });
  await closed;
  h.running.splice(h.running.indexOf(again.app), 1);
});

test('a second launch exits at once and shows the running window (single instance, 11 §3.2)', async () => {
  const dirs = await h.tempDirs('eli5-e2e-app-single-');
  const l = await h.launch(dirs);
  await hideWindow(l.app);
  await expect.poll(() => windowState(l.app)).toMatchObject({ visible: false });

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ELI5_USER_DATA_DIR: dirs.userData,
    ELI5_LIBRARY_DIR: dirs.library,
    ELI5_KEYSTORE: 'memory',
  };
  const second = spawn(electronPath as unknown as string, [path.resolve('.')], { env, stdio: 'ignore' });
  const code = await new Promise<number | null>((resolve, reject) => {
    const t = setTimeout(() => {
      second.kill('SIGKILL');
      reject(new Error('second instance did not exit'));
    }, 20_000);
    second.on('exit', (c) => {
      clearTimeout(t);
      resolve(c);
    });
  });
  expect(code).toBe(0);
  await expect.poll(() => windowState(l.app)).toMatchObject({ count: 1, visible: true, dock: true });
});

test('a crashed viewer reloads its document once; a second crash shows "Could not display" (01 §9)', async () => {
  const dirs = await h.tempDirs('eli5-e2e-app-crash-');
  const l = await h.launch(dirs);
  const doc = await generate(l);
  await openFromLibrary(l.win, doc.title);
  const url = `eli5doc://doc/${doc.topicSlug}/index.html`;
  await expect.poll(() => viewerUrl(l.app)).toBe(url);
  await expect.poll(() => viewerText(l.app)).toContain('Why the plan matters');

  await crashViewer(l.app);
  // Reloaded in place: the same document renders again; the app renderer is untouched.
  await expect.poll(() => viewerText(l.app), { timeout: 15_000 }).toContain('Why the plan matters');
  expect(await viewerUrl(l.app)).toBe(url);
  await expect(l.win.locator('.doc-header h1')).toHaveText(TITLE);

  await crashViewer(l.app);
  await expect.poll(() => viewerText(l.app), { timeout: 15_000 }).toContain('Could not display this document.');
  // Retry (11 §8) loads the document again. Playwright keeps the crashed target's page closed, so
  // a real click is sent from main as native input at the link's position.
  await l.app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const child = w?.contentView.children[0] as unknown as { webContents?: Electron.WebContents } | undefined;
    const wc = child?.webContents;
    if (!wc) return;
    const r = (await wc.executeJavaScript(
      '(() => { const b = document.querySelector("a[role=button]").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()',
    )) as { x: number; y: number };
    const at = { x: Math.round(r.x), y: Math.round(r.y), button: 'left' as const, clickCount: 1 };
    wc.sendInputEvent({ type: 'mouseDown', ...at });
    wc.sendInputEvent({ type: 'mouseUp', ...at });
  });
  await expect.poll(() => viewerText(l.app), { timeout: 15_000 }).toContain('Why the plan matters');
  expect(await viewerUrl(l.app)).toBe(url);
});

test('Reveal in Finder: the document header reveals the document, Settings > Library the root', async () => {
  const dirs = await h.tempDirs('eli5-e2e-app-reveal-');
  const l = await h.launch(dirs);
  const doc = await generate(l);
  const calls = await spyShell(l.app);
  await openFromLibrary(l.win, doc.title);
  await l.win.locator('.doc-header').getByRole('button', { name: 'Reveal in Finder' }).click();
  await expect.poll(calls).toHaveLength(1);
  const [kind, target] = (await calls())[0] ?? [];
  expect(kind).toBe('showItemInFolder');
  expect(target?.startsWith(path.join(dirs.library, doc.topicSlug))).toBe(true);

  await l.win.getByRole('button', { name: 'Settings' }).click();
  const library = l.win.getByRole('region', { name: 'Library' });
  await expect(library.getByText(dirs.library)).toBeVisible();
  await library.getByRole('button', { name: 'Reveal in Finder' }).click();
  await expect.poll(calls).toHaveLength(2);
  expect((await calls())[1]).toEqual(['showItemInFolder', dirs.library]);
  await expect(l.win.locator('.inline-error')).toHaveCount(0);
});

test('the API key is saved and removed without ever being echoed to the renderer, disk or log', async () => {
  const dirs = await h.tempDirs('eli5-e2e-app-key-');
  const l = await h.launch(dirs, { fake: false });
  const w: Page = l.win;
  await w.getByRole('button', { name: 'Settings' }).click();
  await expect(w.getByTestId('key-state')).toHaveText('No key');
  const key = TEST_KEY.replace('sk-test', 'sk-ant-test');

  const field = w.getByLabel('API key', { exact: true });
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill(key);
  await w.getByRole('button', { name: 'Save key' }).click();
  await expect(w.getByTestId('key-state')).toHaveText('Key saved in Keychain');
  // Cleared after save; never shown again (11 §7).
  await expect(field).toHaveValue('');
  expect(await w.evaluate(() => window.eli5.settings.hasApiKey('claude'))).toEqual({ ok: true, value: true });
  const html = await w.content();
  expect(html).not.toContain(key);
  const settings = await w.evaluate(() => window.eli5.settings.get());
  expect(JSON.stringify(settings)).not.toContain(key);

  // Remove clears the stored key; the start is then blocked inline (11 §5.4 step 3).
  await w.getByRole('button', { name: 'Remove' }).click();
  await expect(w.getByTestId('key-state')).toHaveText('No key');
  expect(await w.evaluate(() => window.eli5.settings.hasApiKey('claude'))).toEqual({ ok: true, value: false });
  await w.evaluate((p) => window.__eli5Test?.dropPaths(p), [path.resolve('test/fixtures/sources/text/notes.md')]);
  await w.getByRole('button', { name: 'Start' }).click();
  await expect(w.getByText('Add an API key in Settings to start')).toBeVisible();
  await h.close(l.app);

  for (const f of await readdir(dirs.userData, { recursive: true })) {
    const full = path.join(dirs.userData, f);
    if (!(await stat(full)).isFile()) continue;
    expect((await readFile(full)).includes(key), f).toBe(false);
  }
});

/** Selects a passage with a real triple click, then opens the inline menu with Cmd+. (08 §5.2). */
async function selectAndFocusMenu(page: Page, sectionId: string, text: string): Promise<void> {
  const target = page.locator(`#${sectionId}`).getByText(text, { exact: true });
  await target.scrollIntoViewIfNeeded();
  await target.click({ clickCount: 3 });
  await expect
    .poll(async () => {
      await page.keyboard.press('Meta+Period');
      return page.evaluate(() => document.activeElement?.hasAttribute('data-eli5-noact') ?? false);
    })
    .toBe(true);
}

async function viewerPage(app: ElectronApplication, slug: string): Promise<Page> {
  const url = `eli5doc://doc/${slug}/index.html`;
  await expect.poll(() => viewerUrl(app)).toBe(url);
  await expect.poll(() => app.windows().some((p) => p.url() === url)).toBe(true);
  const page = app.windows().find((p) => p.url() === url);
  if (!page) throw new Error('viewer page not found');
  await page.waitForLoadState('domcontentloaded');
  await expect.poll(() => page.evaluate(() => typeof (window as { eli5Doc?: unknown }).eli5Doc)).toBe('object');
  return page;
}

test('E10: a document stamped by a prior app version still takes a section action (never frozen)', async () => {
  const dirs = await h.tempDirs('eli5-e2e-app-old-');
  const first: Launched = await h.launch(dirs);
  const doc = await generate(first);
  await h.close(first.app);

  // Rewrite the version stamps as an older release would have left them (07 §3 generator).
  const docFile = path.join(dirs.library, doc.topicSlug, 'index.html');
  const metaFile = path.join(dirs.library, doc.topicSlug, 'meta.json');
  const stamp = (s: string) =>
    s
      .replace(/("version"\s*:\s*)"[^"]*"/g, '$1"0.0.1"')
      .replace(/("runtimeVersion"\s*:\s*)"[^"]*"/g, '$1"0.0.1"')
      .replace(/("appVersion"\s*:\s*)"[^"]*"/g, '$1"0.0.1"');
  const oldHtml = stamp(await readFile(docFile, 'utf8'));
  expect(oldHtml).toContain('"runtimeVersion":"0.0.1"');
  await writeFile(docFile, oldHtml);
  await writeFile(metaFile, stamp(await readFile(metaFile, 'utf8')));

  const l = await h.launch(dirs);
  await openFromLibrary(l.win, doc.title);
  const viewer = await viewerPage(l.app, doc.topicSlug);
  const id = await viewer.evaluate(
    () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('.tabpanel[data-tab-key="indepth"] section[data-section-id]'),
      ).find((s) => s.querySelector(':scope > h2')?.textContent === 'How the forecast is built')?.id ?? '',
  );
  expect(id).not.toBe('');
  await selectAndFocusMenu(viewer, id, 'Lead time is six weeks.');
  await viewer.keyboard.press('Enter'); // note field -> first action
  await viewer.keyboard.press('Enter'); // "Expand this"
  await expect(viewer.locator(`#${id} > h2`)).toHaveText('How the forecast is built, step by step', {
    timeout: 30_000,
  });
  const after = await readFile(docFile, 'utf8');
  expect(after).not.toBe(oldHtml);
  expect(validateDocument(after).errors).toEqual([]);
});

/** A real left click on the page's `a[role=button]`, sent from main as native input. */
async function clickLinkButton(wc: 'main' | 'viewer', app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, which) => {
    const w = BrowserWindow.getAllWindows()[0];
    const child = w?.contentView.children[0] as unknown as { webContents?: Electron.WebContents } | undefined;
    const target = which === 'main' ? w?.webContents : child?.webContents;
    if (!target) return;
    const r = (await target.executeJavaScript(
      '(() => { const b = document.querySelector("a[role=button]").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()',
    )) as { x: number; y: number };
    const at = { x: Math.round(r.x), y: Math.round(r.y), button: 'left' as const, clickCount: 1 };
    target.sendInputEvent({ type: 'mouseDown', ...at });
    target.sendInputEvent({ type: 'mouseUp', ...at });
  }, wc);
}

test('a crashed app renderer reloads once; a second crash shows the Reload page, which recovers (11 §3.2)', async () => {
  const dirs = await h.tempDirs('eli5-e2e-app-rcrash-');
  const l = await h.launch(dirs);
  const mainText = () => pageText(l.app, 'main');
  const crash = () => crashPage(l.app, 'main');

  await crash();
  await expect.poll(mainText, { timeout: 15_000 }).toContain('Turn anything into an explainer.');
  await crash();
  await expect.poll(mainText, { timeout: 15_000 }).toContain('Something went wrong.');
  // Playwright keeps a crashed target's page closed, so the click is native input from main.
  await clickLinkButton('main', l.app);
  await expect.poll(mainText, { timeout: 15_000 }).toContain('Turn anything into an explainer.');
  await h.close(l.app);
});
