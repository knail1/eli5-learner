import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { validateDocument } from '../helpers/doc-validity';
import type { FixtureServer } from '../helpers/fixture-server';
import {
  Harness,
  SOURCES,
  TITLE,
  dropFiles,
  fakeCalls,
  writeScript,
  jobText,
  libraryEntries,
  probeDocument,
  type Dirs,
  type Launched,
} from './harness';

/**
 * Input capture end to end (13 §8.1, §8.2 E2, E3; 11 §5.4): clipboard pastes through the real
 * Electron clipboard and Cmd+V, several sources combined into one job, the SPA render fallback,
 * and the input zone's DOM drop handler with in-memory `File` objects. FakeProvider only; needs a
 * test build (ELI5_TEST_BUILD=1, `npm run test:e2e`).
 */

// The fixture server registers its port with net-guard, which would also block Playwright's own
// loopback connection to Electron; the guard stays off in this runner process.
process.env.ELI5_ALLOW_NET = '1';
const { startFixtureServer } = await import('../helpers/fixture-server');

test.describe.configure({ mode: 'serial' });

let server: FixtureServer;
const h = new Harness();
/** One clipboard item, every format as base64 (bookmarks keep their object form). */
type SavedItem = Record<string, { b64: string } | { bookmark: { title: string; url: string } }>;
/** The user's whole clipboard before this file ran; restored after each test (13 §8.1 uses the real one). */
let savedClipboard: SavedItem[] | undefined;

test.beforeAll(async () => {
  server = await startFixtureServer();
  h.fixtureOrigin = server.origin;
});

test.afterAll(async () => {
  await h.cleanup();
  await server?.close();
});

// Put the user's clipboard back, then the modal guard (13 §8.1: no modals in ingest).
test.afterEach(async () => {
  const app = h.running[0];
  if (app && savedClipboard !== undefined) await restoreClipboard(app, savedClipboard);
  await h.closeAll();
});

const tempDirs = (): Promise<Dirs> => h.tempDirs('eli5-e2e-inputs-');

/** Every item and format on the system clipboard (images, files, rich text), not only its text. */
function snapshotClipboard(app: ElectronApplication): Promise<SavedItem[]> {
  return app.evaluate(async ({ clipboard }) => {
    const out: SavedItem[] = [];
    for (const item of await clipboard.read()) {
      const saved: SavedItem = {};
      for (const type of item.types) {
        const v = (await item.getType(type)) as Blob | { title: string; url: string };
        saved[type] =
          v instanceof Blob
            ? { b64: Buffer.from(await v.arrayBuffer()).toString('base64') }
            : { bookmark: { title: v.title, url: v.url } };
      }
      out.push(saved);
    }
    return out;
  });
}

/** Writes a snapshot back in one atomic write; an empty snapshot clears the clipboard. */
async function restoreClipboard(app: ElectronApplication, saved: SavedItem[]): Promise<void> {
  await app
    .evaluate(async ({ clipboard, ClipboardItem }, items) => {
      if (items.length === 0) return clipboard.clear();
      await clipboard.write(
        items.map(
          (item) =>
            new ClipboardItem(
              Object.fromEntries(
                Object.entries(item).map(([type, v]) => [
                  type,
                  'bookmark' in v ? v.bookmark : new Blob([Buffer.from(v.b64, 'base64')], { type }),
                ]),
              ),
            ),
        ),
      );
    }, saved)
    .catch(() => {});
}

async function rememberClipboard(app: ElectronApplication): Promise<void> {
  if (savedClipboard !== undefined) return;
  savedClipboard = await snapshotClipboard(app);
}

/** Puts a PNG on the real clipboard from main (13 §8.1). */
async function clipboardImage(app: ElectronApplication, file: string): Promise<void> {
  await rememberClipboard(app);
  const b64 = (await readFile(file)).toString('base64');
  await app.evaluate(async ({ clipboard, ClipboardItem }, data) => {
    const bytes = Buffer.from(data, 'base64');
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
  }, b64);
}

async function clipboardText(app: ElectronApplication, text: string): Promise<void> {
  await rememberClipboard(app);
  await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
}

/** Cmd+V with focus in the input zone but outside a text field (11 §5.4 step 2). */
async function pasteIntoDropBox(win: Page): Promise<void> {
  const box = win.getByRole('group', { name: /^Sources/ });
  await box.focus();
  await win.keyboard.press('Meta+V');
}

const chips = (win: Page) => win.getByRole('list', { name: 'Added sources' }).getByRole('listitem');

/** Waits for `Done:`, then runs the 13 §7.2 probe on the newest document. */
async function waitDone(l: Launched, dirs: Dirs): Promise<void> {
  await expect(jobText(l.win)).toHaveText(new RegExp(`^Done: ${TITLE}$`), { timeout: 30_000 });
  const slug = (await libraryEntries(l.win))[0]?.topicSlug ?? '';
  await probeDocument(l.app, path.join(dirs.library, slug, 'index.html'));
}

async function startAndFinish(l: Launched, dirs: Dirs): Promise<void> {
  await l.win.getByRole('button', { name: 'Start' }).click();
  await waitDone(l, dirs);
}

/** Types URLs into the URL field and presses Enter: step 1 commits them, then the job starts (11 §5.4). */
async function enterUrlsAndStart(win: Page, urls: string[]): Promise<void> {
  const field = win.getByLabel('URL', { exact: true });
  await field.fill(urls.join(' '));
  await field.press('Enter');
}

test('the clipboard snapshot restores every format, so the suite leaves the clipboard as it was', async () => {
  const dirs = await tempDirs();
  const l = await h.launch(dirs);
  await rememberClipboard(l.app);
  const png = (await readFile(path.join(SOURCES, 'images/diagram.png'))).toString('base64');
  await l.app.evaluate(async ({ clipboard, ClipboardItem }, data) => {
    await clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob(['plain words'], { type: 'text/plain' }),
        'text/html': new Blob(['<b>rich words</b>'], { type: 'text/html' }),
        'image/png': new Blob([Buffer.from(data, 'base64')], { type: 'image/png' }),
      }),
    ]);
  }, png);
  const rich = await snapshotClipboard(l.app);
  await l.app.evaluate(({ clipboard }) => clipboard.writeText('overwritten'));
  await restoreClipboard(l.app, rich);
  const back = await snapshotClipboard(l.app);
  const types = (s: SavedItem[]) => s.flatMap((i) => Object.keys(i)).sort();
  expect(types(back)).toEqual(expect.arrayContaining(['image/png', 'text/html', 'text/plain']));
  expect(types(back)).toEqual(types(rich));
  expect(await l.app.evaluate(({ clipboard }) => clipboard.readText())).toBe('plain words');
});

test('E2: a pasted image and clarifying text reach the model in the in-depth request', async () => {
  const dirs = await tempDirs();
  const l = await h.launch(dirs);
  await clipboardImage(l.app, path.join(SOURCES, 'images/diagram.png'));
  await pasteIntoDropBox(l.win);
  await expect(chips(l.win)).toHaveCount(1);
  await expect(chips(l.win).first()).toContainText(/Pasted image \d{2}:\d{2}/);

  const note = 'Explain how the arrows connect the boxes';
  await l.win.getByLabel('Specifics').fill(note);
  await startAndFinish(l, dirs);

  const indepth = (await fakeCalls(l.app)).filter((c) => c.taskId === 'in-depth');
  expect(indepth).toHaveLength(1);
  expect(indepth[0]?.imageCount).toBe(1);
  expect(indepth[0]?.text).toContain(note);
  const meta = JSON.parse(
    await readFile(path.join(dirs.library, (await libraryEntries(l.win))[0]?.topicSlug ?? '', 'meta.json'), 'utf8'),
  ) as { sourcesUsed?: unknown[]; sourcesSkipped?: unknown[] };
  expect(meta.sourcesUsed).toHaveLength(1);
  expect(meta.sourcesSkipped ?? []).toHaveLength(0);
});

test('an empty clipboard shows "Nothing to paste" inline, then clears', async () => {
  const dirs = await tempDirs();
  const l = await h.launch(dirs);
  await rememberClipboard(l.app);
  await l.app.evaluate(({ clipboard }) => clipboard.clear());
  await pasteIntoDropBox(l.win);
  await expect(l.win.getByText(/^Nothing to paste/)).toBeVisible();
  await expect(l.win.getByRole('list', { name: 'Added sources' })).toHaveCount(0);
  // Transient: the hint goes away on its own after 3 s (11 §5.4 step 2).
  await expect(l.win.getByText(/^Nothing to paste/)).toHaveCount(0, { timeout: 10_000 });
});

test('a dropped file, pasted text and a URL become one job that uses all three sources', async () => {
  const dirs = await tempDirs();
  const l = await h.launch(dirs);
  await dropFiles(l.win, ['docx/policy-memo.docx']);
  const pasted = 'Pasted planning note: the pilot budget is forty units.';
  await clipboardText(l.app, pasted);
  await pasteIntoDropBox(l.win);
  await expect(chips(l.win).nth(1)).toContainText('Pasted text: ');
  await expect(chips(l.win)).toHaveCount(2);
  await enterUrlsAndStart(l.win, [server.url('/article/')]);
  await waitDone(l, dirs);
  // The draft stays, ready to edit and run again (11 §5.4 step 5); focus stays in the URL field.
  await expect(chips(l.win)).toHaveCount(3);
  await expect(l.win.getByLabel('URL', { exact: true })).toBeFocused();

  const jobs = await l.win.evaluate(() => window.eli5.jobs.list());
  expect(jobs.ok && jobs.value).toHaveLength(1);
  const indepth = (await fakeCalls(l.app)).filter((c) => c.taskId === 'in-depth');
  expect(indepth).toHaveLength(1);
  const text = indepth[0]?.text ?? '';
  expect(text).toContain('Remote Work Policy');
  expect(text).toContain('the pilot budget is forty units');
  expect(text).toContain('Solar-Powered Widget Plant');

  const slug = (await libraryEntries(l.win))[0]?.topicSlug ?? '';
  const meta = JSON.parse(await readFile(path.join(dirs.library, slug, 'meta.json'), 'utf8')) as {
    sourcesUsed?: unknown[];
  };
  expect(meta.sourcesUsed).toHaveLength(3);
  expect(validateDocument(await readFile(path.join(dirs.library, slug, 'index.html'), 'utf8')).errors).toEqual([]);
});

test('the draft stays after Start: Restart reruns it with edits, Start then makes another document, Clear empties it', async () => {
  const dirs = await tempDirs();
  const l = await h.launch(dirs, { script: await writeScript(dirs, 'restart', { latencyMs: 1_500 }) });
  const list = async () => {
    const r = await l.win.evaluate(() => window.eli5.jobs.list());
    return r.ok ? [...r.value].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [];
  };
  const field = l.win.getByLabel('URL', { exact: true });
  const specifics = l.win.getByLabel('Specifics');
  const startButton = l.win.getByRole('button', { name: 'Start', exact: true });
  const restartButton = l.win.getByRole('button', { name: 'Restart', exact: true });
  await field.fill(server.url('/article/'));
  await specifics.fill('Focus on the output figures');
  await startButton.click();

  // Everything is still there, and while the run goes the button restarts it (11 §5.4).
  await expect(restartButton).toBeVisible();
  await expect(restartButton).toHaveAttribute('title', 'Cancel the current run and start again with these inputs');
  await expect(chips(l.win)).toHaveCount(1);
  await expect(chips(l.win).first()).toContainText('127.0.0.1');
  await expect(specifics).toHaveValue('Focus on the output figures');
  await expect(l.win.getByText(/^Started\. Edit and Restart/)).toBeVisible();
  await expect.poll(async () => (await list()).length).toBe(1);

  // Restart with edited specifics: the first run is cancelled, a second starts with the edit.
  await specifics.fill('Focus on the labor costs');
  await expect(async () => {
    if ((await list()).length < 2) await restartButton.click();
    await expect.poll(async () => (await list()).length, { timeout: 1_000 }).toBe(2);
  }).toPass();
  await expect.poll(async () => (await list()).map((j) => j.status), { timeout: 30_000 }).toEqual(['failed', 'done']);
  const [first] = await list();
  expect(first?.statusLine).toMatch(/^Cancelled/);
  const indepth = (await fakeCalls(l.app)).filter((c) => c.taskId === 'in-depth');
  expect(indepth.some((c) => c.text.includes('Focus on the labor costs'))).toBe(true);
  expect(await libraryEntries(l.win)).toHaveLength(1);

  // The run is over: Start makes another document from the same draft.
  await expect(startButton).toBeVisible();
  await expect(chips(l.win)).toHaveCount(1);
  await expect(specifics).toHaveValue('Focus on the labor costs');
  await expect(async () => {
    if ((await list()).length < 3) await startButton.click();
    await expect.poll(async () => (await list()).length, { timeout: 1_000 }).toBe(3);
  }).toPass();
  await expect.poll(async () => (await libraryEntries(l.win)).length, { timeout: 30_000 }).toBe(2);

  // Clear empties the zone.
  await l.win.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(l.win.getByRole('list', { name: 'Added sources' })).toHaveCount(0);
  await expect(field).toHaveValue('');
  await expect(specifics).toHaveValue('');
  await expect(l.win.getByRole('button', { name: 'Clear', exact: true })).toBeDisabled();
});

test('E3: /article/ and the client-rendered /spa/ are both used; the SPA needed the render fallback', async () => {
  const dirs = await tempDirs();
  const l = await h.launch(dirs);
  const before = server.hits.filter((x) => x.path === '/spa/').length;
  await enterUrlsAndStart(l.win, [server.url('/article/'), server.url('/spa/')]);
  await waitDone(l, dirs);
  const jobs = await l.win.evaluate(() => window.eli5.jobs.list());
  expect(jobs.ok && jobs.value).toHaveLength(1);

  // Plain HTTP saw an empty shell, so the hidden window loaded the page a second time (05 §5 step 9).
  expect(server.hits.filter((x) => x.path === '/spa/').length - before).toBeGreaterThanOrEqual(2);
  const text = (await fakeCalls(l.app)).find((c) => c.taskId === 'in-depth')?.text ?? '';
  // The page's script composes this sentence at run time: the model saw the rendered DOM.
  expect(text).toContain('Section 14 covers one family of widgets.');
  expect(text).toContain('Solar-Powered Widget Plant');
});

test('the DOM drop handler: in-memory files without a path are refused inline; dropped links become chips', async () => {
  const dirs = await tempDirs();
  const l = await h.launch(dirs);
  // 13 §8.1: one spec dispatches a synthetic drop with in-memory File objects (no path on disk).
  await l.win.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['synthetic'], 'memo.txt', { type: 'text/plain' }));
    const zone = document.querySelector('form[aria-label="New explainer"]');
    zone?.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(l.win.getByText('Could not add memo.txt')).toBeVisible();
  await expect(l.win.getByRole('list', { name: 'Added sources' })).toHaveCount(0);

  const link = server.url('/article/');
  await l.win.evaluate((u) => {
    const dt = new DataTransfer();
    dt.setData('text/uri-list', u);
    const zone = document.querySelector('form[aria-label="New explainer"]');
    zone?.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, link);
  await expect(chips(l.win)).toHaveCount(1);
  await expect(chips(l.win).first()).toContainText('127.0.0.1');
});
