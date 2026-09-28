import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { Harness, viewerUrl, type Dirs, type Launched } from './harness';

/**
 * Find in document (11 §5.3 find bar, §9): Cmd+F opens the find bar over the open document, typing
 * searches it, Cmd+G / Shift+Cmd+G step through matches, Escape closes the bar and returns focus to
 * the viewer; the Edit > Find menu items work while the viewer has focus; Option+Cmd+F (and Cmd+F
 * with no document open) focuses the Library filter. Requires a test build (`npm run test:e2e`).
 */

test.describe.configure({ mode: 'serial' });

const h = new Harness();
test.afterAll(() => h.cleanup());
test.afterEach(() => h.assertNoModals());

/** Committed by an earlier build (see app.e2e.ts E10); reused as seed documents. */
const PRIOR = path.resolve('test/e2e/fixtures/prior-version/widget-supply-planning');
const DOCS = [
  { slug: 'widget-supply-plan', title: 'Widget supply plan', n: 1 },
  { slug: 'office-plants', title: 'Office plants', n: 2 },
];

async function seed(dirs: Dirs): Promise<void> {
  const html = await readFile(path.join(PRIOR, 'index.html.frozen'), 'utf8');
  const meta = JSON.parse(await readFile(path.join(PRIOR, 'meta.json.frozen'), 'utf8')) as Record<string, unknown>;
  for (const d of DOCS) {
    const dir = path.join(dirs.library, d.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), html);
    const at = `2026-09-0${String(d.n)}T10:00:00.000Z`;
    await writeFile(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        ...meta,
        id: `00000000-0000-4000-8000-00000000000${String(d.n)}`,
        topicSlug: d.slug,
        title: d.title,
        createdAt: at,
        updatedAt: at,
      }),
    );
  }
}

const findBar = (win: Page) => win.getByRole('search', { name: 'Find in document' });
const findField = (win: Page) => findBar(win).getByRole('textbox', { name: 'Find in document' });
const findCount = (win: Page) => findBar(win).getByRole('status');
const filter = (win: Page) => win.getByRole('navigation', { name: 'Library' }).locator('input.filter');

/** "3 of 12" as numbers, or null. */
async function count(win: Page): Promise<{ at: number; of: number } | null> {
  const m = /^(\d+) of (\d+)$/.exec((await findCount(win).textContent()) ?? '');
  return m ? { at: Number(m[1]), of: Number(m[2]) } : null;
}

const viewerFocused = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const child = w?.contentView.children[0] as unknown as { webContents?: Electron.WebContents } | undefined;
    return child?.webContents?.isFocused() ?? false;
  });

// webContents focus is only reported while the test window is the active macOS window. When another
// app is in front (for example a copy of ELI5 Learner the developer is using), macOS does not let the
// test app take focus, so focus checks are skipped and noted instead of failing.
const windowFrontmost = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFocused() ?? false);

const clickMenu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, menuId) => {
    Menu.getApplicationMenu()?.getMenuItemById(menuId)?.click();
  }, id);

async function openDoc(l: Launched, title: string, slug: string): Promise<void> {
  await l.win
    .getByRole('navigation', { name: 'Library' })
    .getByRole('button', { name: new RegExp(title) })
    .click();
  await expect.poll(() => viewerUrl(l.app)).toBe(`eli5doc://doc/${slug}/index.html`);
  await expect(l.win.locator('.doc-header h1')).toHaveText(title);
}

test.describe('find in document', () => {
  let l: Launched;

  test.beforeAll(async () => {
    const dirs = await h.tempDirs('eli5-e2e-find-');
    await seed(dirs);
    l = await h.launch(dirs);
    await openDoc(l, 'Widget supply plan', 'widget-supply-plan');
  });

  test.afterAll(() => h.closeAll());

  test('Cmd+F, type, Cmd+G / Shift+Cmd+G step through matches, Escape closes and focuses the viewer', async () => {
    const { win, app } = l;
    const slotBefore = await win.getByTestId('viewer-slot').boundingBox();
    await win.keyboard.press('Meta+F');
    await expect(findField(win)).toBeFocused();
    await expect(filter(win)).not.toBeFocused();
    // The bar takes layout space: the viewer slot below it moves down and shrinks.
    await expect
      .poll(async () => (await win.getByTestId('viewer-slot').boundingBox())?.y)
      .toBeGreaterThan(slotBefore?.y ?? 0);

    await win.keyboard.type('widget');
    await expect(findCount(win)).toHaveText(/^1 of \d+$/);
    const first = await count(win);
    expect(first?.of).toBeGreaterThan(1);

    await win.keyboard.press('Meta+G');
    await expect(findCount(win)).toHaveText(`2 of ${String(first?.of)}`);
    await win.keyboard.press('Enter');
    await expect(findCount(win)).toHaveText(`3 of ${String(first?.of)}`);
    await win.keyboard.press('Shift+Meta+G');
    await expect(findCount(win)).toHaveText(`2 of ${String(first?.of)}`);
    await win.keyboard.press('Shift+Enter');
    await expect(findCount(win)).toHaveText(`1 of ${String(first?.of)}`);

    await win.keyboard.press('Escape');
    await expect(findBar(win)).toHaveCount(0);
    if (await windowFrontmost(app)) {
      await expect.poll(() => viewerFocused(app)).toBe(true);
    } else {
      test.info().annotations.push({ type: 'note', description: 'window not frontmost: viewer focus not checked' });
    }
  });

  test('a word that is not in the document shows "No matches"', async () => {
    const { win } = l;
    await win.keyboard.press('Meta+F');
    await expect(findField(win)).toHaveValue('widget');
    await win.keyboard.type('zzqxv-not-there');
    await expect(findCount(win)).toHaveText('No matches');
    await findBar(win).getByRole('button', { name: 'Done' }).click();
    await expect(findBar(win)).toHaveCount(0);
  });

  test('Edit > Find menu items work while the viewer has focus', async () => {
    const { win, app } = l;
    await app.evaluate(({ BrowserWindow }) => {
      const child = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as unknown as {
        webContents: Electron.WebContents;
      };
      child.webContents.focus();
    });
    if (await windowFrontmost(app)) await expect.poll(() => viewerFocused(app)).toBe(true);
    await clickMenu(app, 'find-in-document');
    await expect(findField(win)).toBeFocused();
    await win.keyboard.type('widget');
    await expect(findCount(win)).toHaveText(/^1 of \d+$/);
    await clickMenu(app, 'find-next');
    await expect(findCount(win)).toHaveText(/^2 of \d+$/);
    await clickMenu(app, 'find-previous');
    await expect(findCount(win)).toHaveText(/^1 of \d+$/);
  });

  test('switching the document tab re-runs the search in the tab now shown', async () => {
    const { win, app } = l;
    const url = 'eli5doc://doc/widget-supply-plan/index.html';
    const viewer = app.windows().find((p) => p.url().startsWith(url));
    if (!viewer) throw new Error('viewer page not found');
    await findField(win).fill('online');
    await expect(findCount(win)).toHaveText(/^1 of \d+$/);
    const inDepth = (await count(win))?.of;
    await viewer.getByRole('tab', { name: 'ELI5' }).click();
    // Only a fresh search counts the ELI5 tab's matches; a new search starts from the clicked tab,
    // so the active match need not be the first.
    await expect.poll(async () => (await count(win))?.of).not.toBe(inDepth);
    await expect(findCount(win)).toHaveText(/^\d+ of \d+$/);
    await viewer.getByRole('tab', { name: 'In depth' }).click();
    await expect.poll(async () => (await count(win))?.of).toBe(inDepth);
  });

  test('switching to another document closes the bar', async () => {
    const { win } = l;
    await expect(findBar(win)).toBeVisible();
    await openDoc(l, 'Office plants', 'office-plants');
    await expect(findBar(win)).toHaveCount(0);
  });

  test('Option+Cmd+F focuses the Library filter; Cmd+F does too when no document is open', async () => {
    const { win } = l;
    await win.keyboard.press('Alt+Meta+KeyF');
    await expect(filter(win)).toBeFocused();
    await expect(findBar(win)).toHaveCount(0);

    await win.getByRole('button', { name: 'Settings' }).click();
    await expect(win.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await win.getByRole('heading', { name: 'Settings', exact: true }).click();
    await win.keyboard.press('Meta+F');
    await expect(filter(win)).toBeFocused();
    await expect(findBar(win)).toHaveCount(0);
  });
});
