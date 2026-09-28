import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { Harness, libraryEntries, type Dirs } from './harness';

/**
 * Library folders, Archive and Trash (09 §4.2, 11 §5.2): a flat library opens with every document
 * unfiled; create a folder, drag a document into it, swipe one to the Archive (it leaves the Tray
 * recents), move one to the Trash with Cmd+Backspace, undo with Cmd+Z, swipe it to the Trash
 * again, put it back from the Trash view, then empty the Trash. No modal anywhere.
 */

test.describe.configure({ mode: 'serial' });

const h = new Harness();
test.afterAll(() => h.cleanup());
test.afterEach(() => h.closeAll());

/** Committed as is by an earlier build (see app.e2e.ts E10); reused here as seed documents. */
const PRIOR = path.resolve('test/e2e/fixtures/prior-version/widget-supply-planning');

const DOCS = [
  { slug: 'widget-supply-plan', title: 'Widget supply plan', n: 1 },
  { slug: 'office-plants', title: 'Office plants', n: 2 },
  { slug: 'stock-levels', title: 'Stock levels', n: 3 },
];

/** Copies the fixture document in three times with distinct ids, slugs, titles and dates. */
async function seed(dirs: Dirs): Promise<void> {
  const html = await readFile(path.join(PRIOR, 'index.html.frozen'), 'utf8');
  const meta = JSON.parse(await readFile(path.join(PRIOR, 'meta.json.frozen'), 'utf8')) as Record<string, unknown>;
  for (const d of DOCS) {
    const dir = path.join(dirs.library, d.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), html);
    const at = `2026-09-0${d.n}T10:00:00.000Z`;
    await writeFile(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        ...meta,
        id: `00000000-0000-4000-8000-00000000000${d.n}`,
        topicSlug: d.slug,
        title: d.title,
        createdAt: at,
        updatedAt: at,
      }),
    );
  }
}

type TrayState = { labels: string[]; tooltip: string; quit: string };
const trayLabels = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(({ ipcMain }) => {
    let state: TrayState = { labels: [], tooltip: '', quit: '' };
    ipcMain.emit('eli5:test:tray-click', {}, { inspect: (s: TrayState) => (state = s) });
    return state.labels;
  });

const library = (win: Page) => win.getByRole('navigation', { name: 'Library' });
const row = (win: Page, title: string): Locator =>
  library(win).locator('.library-item', { has: win.locator('.item-title', { hasText: title }) });
const toast = (win: Page) => library(win).locator('.toast');

async function center(l: Locator): Promise<{ x: number; y: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error('not visible');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** A two-finger trackpad swipe over a row: wheel events with deltaX (positive = fingers move left). */
async function swipe(win: Page, l: Locator, deltaX: number): Promise<void> {
  const c = await center(l);
  await win.mouse.move(c.x, c.y);
  for (let i = 0; i < 4; i++) await win.mouse.wheel(deltaX / 4, 0);
}

const trashNames = async (dirs: Dirs) =>
  (await readdir(path.join(dirs.library, '.trash')).catch(() => [] as string[])).filter((n) => !n.endsWith('premerge'));

test('folders, drag to move, swipe to Archive and Trash, Undo, Put Back and Empty Trash', async () => {
  const dirs = await h.tempDirs('eli5-e2e-organize-');
  await seed(dirs);
  const { app, win } = await h.launch(dirs);

  // Migration: the flat library lists every document unfiled; nothing is written yet.
  await expect.poll(async () => (await libraryEntries(win)).length).toBe(3);
  await expect(library(win).locator('.library-list.unfiled .item-title')).toHaveText([
    'Stock levels',
    'Office plants',
    'Widget supply plan',
  ]);
  await expect(stat(path.join(dirs.library, '.eli5', 'organization.json'))).rejects.toThrow();
  expect(await trayLabels(app)).toEqual(
    expect.arrayContaining(['Stock levels', 'Office plants', 'Widget supply plan']),
  );

  // Create a folder.
  await library(win).getByRole('button', { name: 'New folder' }).click();
  const name = library(win).getByRole('textbox', { name: 'New folder name' });
  await name.fill('Budgets');
  await name.press('Enter');
  const folder = library(win).getByRole('button', { name: /^Budgets/ });
  await expect(folder).toBeVisible();
  await expect(folder).toHaveAttribute('aria-expanded', 'true');

  // Drag "Office plants" onto the folder.
  const from = await center(row(win, 'Office plants'));
  const to = await center(library(win).locator('.folder-head').first());
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  for (let i = 1; i <= 8; i++) await win.mouse.move(from.x, from.y + ((to.y - from.y) * i) / 8);
  await win.mouse.up();
  await expect(toast(win)).toContainText('Moved to “Budgets”');
  await expect(library(win).locator('.in-folder .item-title')).toHaveText(['Office plants']);
  const org = JSON.parse(await readFile(path.join(dirs.library, '.eli5', 'organization.json'), 'utf8')) as {
    folders: { id: string; name: string }[];
    placement: Record<string, string>;
  };
  expect(org.folders.map((f) => f.name)).toEqual(['Budgets']);
  expect(org.placement['00000000-0000-4000-8000-000000000002']).toBe(org.folders[0]?.id);

  // Swipe "Stock levels" left: Archive. It leaves the Tray recents but stays in the Library.
  await swipe(win, row(win, 'Stock levels'), 240);
  await expect(toast(win)).toContainText('Moved to Archive');
  await expect(library(win).locator('.library-list.unfiled .item-title')).toHaveText(['Widget supply plan']);
  await expect.poll(() => trayLabels(app)).not.toContain('Stock levels');
  expect(await trayLabels(app)).toContain('Widget supply plan');
  await library(win)
    .getByRole('button', { name: /^Archive/ })
    .click();
  await expect(library(win).getByRole('list', { name: 'Archive' }).locator('.item-title')).toHaveText(['Stock levels']);

  // Cmd+Backspace on a focused row: Trash. The files stay intact in .trash/.
  await row(win, 'Widget supply plan').focus();
  await win.keyboard.press('Meta+Backspace');
  await expect(toast(win)).toContainText('Moved to Trash');
  await expect(row(win, 'Widget supply plan')).toHaveCount(0);
  await expect(library(win).locator('.trash-row')).toHaveText('Trash1');
  const [trashed] = await trashNames(dirs);
  expect(trashed).toMatch(/^widget-supply-plan--\d{8}T\d{6}$/);
  expect(await readFile(path.join(dirs.library, '.trash', trashed!, 'index.html'), 'utf8')).toContain('<html');

  // Cmd+Z with the Undo toast showing: the Library move is undone, not a document change.
  await win.keyboard.press('Meta+z');
  await expect(row(win, 'Widget supply plan')).toHaveCount(1);
  await expect(library(win).locator('.trash-row')).toHaveText('Trash0');

  // Swipe right: Trash again.
  await swipe(win, row(win, 'Widget supply plan'), -240);
  await expect(toast(win)).toContainText('Moved to Trash');
  await expect(row(win, 'Widget supply plan')).toHaveCount(0);

  // The Trash view: Put Back.
  await library(win).locator('.trash-row').click();
  const view = win.getByRole('region', { name: 'Trash' });
  await expect(view.getByRole('heading', { name: 'Trash' })).toBeVisible();
  await expect(view.locator('.trash-item .item-title')).toHaveText(['Widget supply plan']);
  await view.getByRole('button', { name: 'Put Back' }).click();
  await expect(view.getByText('The Trash is empty')).toBeVisible();
  await expect(row(win, 'Widget supply plan')).toHaveCount(1);
  expect((await libraryEntries(win)).map((e) => e.topicSlug).sort()).toEqual(DOCS.map((d) => d.slug).sort());

  // Trash two documents, then Empty Trash: one inline confirmation, then the files are gone.
  await row(win, 'Widget supply plan').focus();
  await win.keyboard.press('Meta+Backspace');
  await expect(row(win, 'Widget supply plan')).toHaveCount(0);
  await row(win, 'Office plants').focus();
  await win.keyboard.press('Meta+Backspace');
  await expect(view.locator('.trash-item')).toHaveCount(2);
  await view.getByRole('button', { name: 'Empty Trash' }).click();
  await expect(view.getByText('Permanently delete 2 documents in the Trash?')).toBeVisible();
  await view.getByRole('group', { name: 'Confirm' }).getByRole('button', { name: 'Empty Trash' }).click();
  await expect(view.getByText('The Trash is empty')).toBeVisible();
  expect(await trashNames(dirs)).toEqual([]);
  expect((await libraryEntries(win)).map((e) => e.topicSlug)).toEqual(['stock-levels']);
  await expect(library(win).locator('.trash-row')).toHaveText('Trash0');
});
