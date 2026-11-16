/**
 * Visual regression of the app shell (13 §7.4), in Electron through the e2e harness (FakeProvider,
 * in-memory key store, temp library). Needs an ELI5_TEST_BUILD=1 build (`npm run test:visual`).
 * A seeded library: an open document with an undoable change, a folder, the Archive, the Trash, a
 * pending merge suggestion and a document with a version tree (five versions, one branch). Dates are seeded relative to the run's clock, so the sidebar's
 * compact dates read the same on every run; they are masked anyway. Fixed 1280x800 window at 2x.
 */
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { Harness, dropFiles, openFromLibrary, viewerUrl, type Dirs, type Launched } from '../e2e/harness';
import { expectClip, expectRegion, settle, type Box } from './shots';

test.describe.configure({ mode: 'serial' });

const h = new Harness();
test.afterAll(async () => {
  try {
    await h.closeAll();
  } finally {
    await h.cleanup();
  }
});

const PRIOR = path.resolve('test/e2e/fixtures/prior-version/widget-supply-planning');
/**
 * Written once by this build (FakeProvider, notes.md): Ask, Expand, Undo, Analogy, Go deeper, so
 * the original, an asked version, two branches under it and a newer version on the second. Never
 * regenerate it; the `.frozen` suffixes keep formatters and the library scan away from it.
 */
const TREE = path.resolve('test/e2e/fixtures/version-tree/widget-supply-planning');
const HOUR = 3_600_000;
const DOCS = [
  { slug: 'widget-supply-plan', title: 'Widget supply plan', n: 1, ageH: 3 },
  { slug: 'widget-returns', title: 'Widget returns and refunds', n: 2, ageH: 1 },
  { slug: 'office-plants', title: 'Office plants', n: 3, ageH: 26 },
  { slug: 'stock-levels', title: 'Stock levels', n: 4, ageH: 50 },
  { slug: 'old-forecast', title: 'Old forecast', n: 5, ageH: 80 },
] as const;
const idOf = (n: number) => `00000000-0000-4000-8000-00000000000${String(n)}`;
const UNDO_LABEL = "re-explained 'Pricing'";

/** Five copies of the committed fixture document, one with a prior version, and a suggestion. */
async function seed(dirs: Dirs): Promise<void> {
  const html = await readFile(path.join(PRIOR, 'index.html.frozen'), 'utf8');
  const meta = JSON.parse(await readFile(path.join(PRIOR, 'meta.json.frozen'), 'utf8')) as Record<string, unknown>;
  const now = Date.now();
  for (const d of DOCS) {
    const dir = path.join(dirs.library, d.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), html);
    const at = new Date(now - d.ageH * HOUR).toISOString();
    const m = { ...meta, id: idOf(d.n), topicSlug: d.slug, title: d.title, createdAt: at, updatedAt: at };
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify(m));
    if (d.n === 2) {
      await seedVersionTree(dir, m, now);
    } else if (d.n === 1) {
      // 09 §4.1 legacy: one prior version, paired with the live one, so Undo is available.
      const prev = path.join(dir, '.prev');
      await mkdir(prev, { recursive: true });
      await writeFile(path.join(prev, 'index.html'), html);
      await writeFile(path.join(prev, 'meta.json'), JSON.stringify(m));
      await writeFile(
        path.join(prev, 'state.json'),
        JSON.stringify({ schemaVersion: 1, slot: 'undo', label: UNDO_LABEL, pairedUpdatedAt: at }),
      );
    }
  }
  const ref = (n: number) => {
    const d = DOCS[n - 1]!;
    return { id: idOf(n), slug: d.slug, title: d.title };
  };
  await mkdir(path.join(dirs.library, '.eli5'), { recursive: true });
  await writeFile(
    path.join(dirs.library, '.eli5', 'suggestions.json'),
    JSON.stringify({
      schemaVersion: 1,
      suggestions: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          createdAt: new Date(now - HOUR / 2).toISOString(),
          status: 'pending',
          source: ref(2),
          target: ref(1),
          score: 0.9,
          reason: 'Both cover how widget stock moves through the warehouse',
          scorer: 'lexical+llm',
        },
      ],
      dismissedPairs: [],
    }),
  );
}

/**
 * Installs the version-tree fixture as one document. The live meta keeps its `versionId`, so the
 * tree resolves to its current version; the versions' times move to 5h..1h ago so their relative
 * dates read the same on every run (09 §4.1).
 */
async function seedVersionTree(dir: string, base: Record<string, unknown>, now: number): Promise<void> {
  await writeFile(path.join(dir, 'index.html'), await readFile(path.join(TREE, 'index.html.frozen')));
  const meta = JSON.parse(await readFile(path.join(TREE, 'meta.json.frozen'), 'utf8')) as Record<string, unknown>;
  const pick = ['id', 'topicSlug', 'title', 'createdAt', 'updatedAt'] as const;
  await writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({ ...meta, ...Object.fromEntries(pick.map((k) => [k, base[k]])) }),
  );
  const versions = path.join(dir, '.versions');
  await cp(path.join(TREE, 'versions.frozen'), versions, { recursive: true });
  type Node = { id: string; createdAt: string };
  const treeFile = path.join(versions, 'tree.json');
  const tree = JSON.parse(await readFile(treeFile, 'utf8')) as { nodes: Node[] };
  const order = [...tree.nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((n) => n.id);
  const at = (id: string) => new Date(now - (order.length - order.indexOf(id)) * HOUR).toISOString();
  for (const n of tree.nodes) n.createdAt = at(n.id);
  await writeFile(treeFile, JSON.stringify(tree));
  for (const f of await readdir(path.join(versions, 'nodes'))) {
    const file = path.join(versions, 'nodes', f);
    const rec = JSON.parse(await readFile(file, 'utf8')) as { node: Node };
    rec.node.createdAt = at(rec.node.id);
    await writeFile(file, JSON.stringify(rec));
  }
}

const library = (win: Page) => win.getByRole('navigation', { name: 'Library' });
const row = (win: Page, title: string): Locator =>
  library(win).locator('.library-item', { has: win.locator('.item-title', { hasText: title }) });
/** Relative times ("3h", "Updated 3h ago", "Trashed 2m ago"): masked in every shot (13 §7.4). */
const volatile = (win: Page): Locator[] => [
  win.locator('.item-date'),
  win.locator('.doc-title .muted'),
  win.locator('.trash-detail'),
];

/**
 * The box of `outer` from its top edge down to the bottom of the last element matched by `last`
 * (plus `padBottom`), across its full width, in page coordinates (the app window never scrolls).
 * For a column that stretches with the window (the Library nav, the Versions panel) this is the
 * part whose size does not depend on the window's height, so the shot is the same on a 790 px page
 * and on the 677 px page of a hosted CI Mac; where the stretched part ends is asserted as geometry
 * instead (13 §7.4).
 */
async function topClip(outer: Locator, last: Locator, padBottom = 0): Promise<Box> {
  const o = await outer.boundingBox();
  const ends: number[] = [];
  for (const el of await last.all()) {
    const b = await el.boundingBox();
    if (b) ends.push(b.y + b.height);
  }
  if (!o || ends.length === 0) throw new Error('topClip: nothing to measure');
  const x = Math.floor(o.x);
  const y = Math.floor(o.y);
  return { x, y, width: Math.ceil(o.x + o.width) - x, height: Math.ceil(Math.max(...ends) + padBottom) - y };
}

/** Bottom edges of two boxes, `a` and `b`, line up within `tol` px. */
async function expectBottomsAligned(a: Locator, b: Locator, tol: number): Promise<void> {
  const [x, y] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  if (!x || !y) throw new Error('expectBottomsAligned: not visible');
  expect(Math.abs(x.y + x.height - (y.y + y.height))).toBeLessThanOrEqual(tol);
}

/** The scroller shows all its content: nothing in the shot is clipped by a short window. */
async function expectNoOverflow(scroller: Locator): Promise<void> {
  const { scrollHeight, clientHeight } = await scroller.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(scrollHeight).toBeLessThanOrEqual(clientHeight + 1);
}

async function viewerPage(app: ElectronApplication, slug: string): Promise<Page> {
  const url = `eli5doc://doc/${slug}/index.html`;
  await expect.poll(() => viewerUrl(app)).toBe(url);
  // Main reports the URL before Playwright sees the page; wait for it as the e2e helpers do.
  await expect.poll(() => app.windows().some((p) => p.url().startsWith(url))).toBe(true);
  const page = app.windows().find((p) => p.url().startsWith(url));
  if (!page) throw new Error('viewer page not found');
  await expect(page.locator('html')).toHaveClass(/\bjs\b/);
  return page;
}

async function setTheme(l: Launched, theme: 'light' | 'dark'): Promise<void> {
  await l.app.evaluate(({ nativeTheme }, t) => {
    nativeTheme.themeSource = t;
  }, theme);
  for (const p of l.app.windows()) await p.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await expect
    .poll(() => l.win.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
    .toBe(theme === 'dark');
}

/**
 * The whole window as the user sees it: the app renderer with the document viewer (a separate
 * WebContentsView, which a page screenshot cannot see) painted into its slot. Relative times are
 * covered with a solid block, like Playwright's `mask`.
 */
async function windowImage(l: Launched): Promise<Buffer> {
  const mask = await l.win.addStyleTag({
    content: '.item-date,.doc-title .muted,.trash-detail{background:#ff00ff!important;color:transparent!important}',
  });
  await settle(l.win);
  try {
    const b64 = await l.app.evaluate(async ({ BrowserWindow, nativeImage }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (!w) throw new Error('no window');
      const base = await w.webContents.capturePage();
      const { width: W, height: H } = base.getSize();
      const scale = W / w.getContentBounds().width;
      const bmp = Buffer.from(base.toBitmap());
      for (const child of w.contentView.children) {
        const wc = (child as unknown as { webContents?: Electron.WebContents }).webContents;
        if (!wc || !child.getVisible()) continue;
        const b = child.getBounds();
        const img = await wc.capturePage();
        const s = img.getSize();
        const cb = img.toBitmap();
        const ox = Math.round(b.x * scale);
        const oy = Math.round(b.y * scale);
        const cols = Math.min(s.width, W - ox);
        for (let y = 0; y < s.height && oy + y < H; y++) {
          cb.copy(bmp, ((oy + y) * W + ox) * 4, y * s.width * 4, (y * s.width + cols) * 4);
        }
      }
      return nativeImage.createFromBitmap(bmp, { width: W, height: H, scaleFactor: scale }).toPNG().toString('base64');
    });
    return Buffer.from(b64, 'base64');
  } finally {
    await mask.evaluate((n) => (n as Element).remove());
  }
}

let l: Launched;
let viewer: Page;

test.beforeAll(async () => {
  const dirs = await h.tempDirs('eli5-visual-');
  await seed(dirs);
  // 13 §7.4: 2x pixels on every display, like the browser projects.
  l = await h.launch(dirs, { args: ['--force-device-scale-factor=2'] });
  await l.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w?.setContentSize(1280, 800);
    w?.center();
  });
  await expect.poll(() => l.win.evaluate(() => innerWidth)).toBe(1280);
  // Organize through the app's own IPC, as a user's drag or swipe would.
  await expect.poll(async () => (await l.win.evaluate(() => window.eli5.library.list())).ok).toBe(true);
  await l.win.evaluate(async () => {
    const f = await window.eli5.library.createFolder('Budgets');
    if (!f.ok) throw new Error(f.error.message);
    for (const [slug, to] of [
      ['office-plants', f.value.id],
      ['stock-levels', 'archive'],
      ['old-forecast', 'trash'],
    ] as const) {
      const r = await window.eli5.library.move(slug, to);
      if (!r.ok) throw new Error(r.error.message);
    }
  });
  await expect(library(l.win).locator('.trash-row .count')).toHaveText('1');
  // A new folder starts collapsed and so does the Archive: open both.
  for (const name of [/^Budgets/, /^Archive/]) {
    const toggle = library(l.win).getByRole('button', { name });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
  // The last move's "Moved to Trash · Undo" toast times out (TOAST_MS) before any shot.
  await expect(library(l.win).locator('.toast')).toHaveCount(0, { timeout: 10_000 });
  await openFromLibrary(l.win, 'Widget supply plan');
  viewer = await viewerPage(l.app, 'widget-supply-plan');
  await expect(l.win.locator('.doc-header h1')).toHaveText('Widget supply plan');
  await setTheme(l, 'light');
  await l.win.mouse.move(1, 1);
});

test('main window: sidebar and document', async () => {
  // The whole-window shot needs the size beforeAll asks for (setContentSize 1280x800 gives a 790 px
  // tall page, as in the baseline). A display whose work area is shorter (the hosted CI Macs give
  // 677 px) clamps the window, which moves every row below the header; the element shots in this
  // file still run there.
  const innerHeight = await l.win.evaluate(() => window.innerHeight);
  test.skip(innerHeight < 790, `display too short for the full-window shot (page is ${String(innerHeight)} px tall)`);
  await expect(l.win.getByRole('region', { name: /Suggestions/ })).toBeVisible();
  expect(await windowImage(l)).toMatchSnapshot('main-window-light.png');
  await setTheme(l, 'dark');
  expect(await windowImage(l)).toMatchSnapshot('main-window-dark.png');
  await setTheme(l, 'light');
});

test('sidebar: folder, Archive expanded, Trash count', async () => {
  const nav = library(l.win);
  await expect(nav.getByRole('button', { name: /^Budgets/ })).toHaveAttribute('aria-expanded', 'true');
  await expect(nav.getByRole('list', { name: 'Archive' }).locator('.item-title')).toHaveText(['Stock levels']);
  const trash = nav.locator('.trash-row');
  await expect(trash).toHaveText('Trash1');
  // The nav stretches with the window (flex: 1), so its height is not pictured. Geometry instead:
  // Trash sits at the nav's bottom at any window height (8 px covers its 4 px margin and rounding),
  // the folder list shows all its rows, and the Archive list ends above Trash.
  await expectBottomsAligned(nav, trash, 8);
  const scroll = nav.locator('.library-scroll');
  await expectNoOverflow(scroll);
  const [archive, trashBox] = await Promise.all([
    nav.getByRole('list', { name: 'Archive' }).boundingBox(),
    trash.boundingBox(),
  ]);
  if (!archive || !trashBox) throw new Error('Archive or Trash not visible');
  expect(archive.y + archive.height).toBeLessThanOrEqual(trashBox.y);
  // Pictured at a fixed height: the header, filter, documents and folders, then the Trash row.
  await expectClip(l.win, 'sidebar-light.png', await topClip(nav, scroll.locator(':scope > *'), 8), {
    mask: volatile(l.win),
  });
  await expect(trash).toHaveScreenshot('sidebar-trash-light.png');
  // Hovered folder: Rename and Delete appear over the count, which otherwise lines up with Archive's.
  // The same rule shows them on :focus-within, which is what is pictured: in Electron a synthetic
  // hover does not survive the screenshot (Chromium re-checks :hover against the window's native
  // cursor after layout), so a hover shot showed the bare count on some runs.
  const head = nav.locator('.folder-head').first();
  await head.getByRole('button', { name: /^Budgets/ }).focus();
  await expect(head.locator('.folder-actions')).toHaveCSS('opacity', '1');
  await expect(head).toHaveScreenshot('sidebar-folder-hover-light.png');
  await l.win.mouse.move(1, 1);
});

test('document header: Undo enabled with its tooltip, Redo disabled', async () => {
  const undo = l.win.getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toBeEnabled();
  // Native tooltips are drawn by macOS outside the page, so the text is asserted, not pictured.
  await expect(undo).toHaveAttribute('title', `Undo: ${UNDO_LABEL} (⌘Z)`);
  await expect(l.win.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  await expect(l.win.locator('.doc-header')).toHaveScreenshot('doc-header-undo-light.png', {
    mask: volatile(l.win),
  });
});

test('merge suggestion card: the title link flows inline, the period stays attached', async () => {
  const card = l.win.locator('.suggestion-card').first();
  await expect(card).toContainText('This looks related to Widget supply plan. Merge it in or keep it separate?');
  // The "." right after the link sits on the link's last line (a block-level link pushed it down).
  const sameLine = await card
    .locator('p')
    .first()
    .evaluate((p) => {
      const a = p.querySelector('a.title-link');
      const dot = a?.nextSibling;
      if (!a || !dot || !dot.textContent?.startsWith('.')) return false;
      const r = document.createRange();
      r.setStart(dot, 0);
      r.setEnd(dot, 1);
      const rects = a.getClientRects();
      const last = rects[rects.length - 1];
      const d = r.getBoundingClientRect();
      return !!last && Math.abs(d.top - last.top) < 4 && d.left >= last.right - 1;
    });
  expect(sameLine).toBe(true);
  await expect(l.win.locator('section.suggestions')).toHaveScreenshot('suggestion-card-light.png');
});

test('find bar open with a match count', async () => {
  await l.win.keyboard.press('Meta+F');
  const bar = l.win.getByRole('search', { name: 'Find in document' });
  await expect(bar.getByRole('textbox')).toBeFocused();
  await l.win.keyboard.type('widget');
  await expect(bar.getByRole('status')).toHaveText(/^1 of \d+$/);
  await expect(bar).toHaveScreenshot('find-bar-light.png');
  await bar.getByRole('button', { name: 'Done' }).click();
  await expect(bar).toHaveCount(0);
});

test('a section being updated in the viewer shows "Updating…"', async () => {
  const second = viewer.locator('#tab-indepth > section').nth(1);
  const sectionId = await second.getAttribute('id');
  await l.app.evaluate(({ BrowserWindow }, id) => {
    const child = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as unknown as {
      webContents: Electron.WebContents;
    };
    child.webContents.send('eli5:doc:section-busy', { busy: [{ sectionId: id, action: 'expand' }] });
  }, sectionId);
  await expect(second.locator('.eli5-busy-label')).toHaveText('Updating…');
  // Clear of the sticky tab bar, which would otherwise cover the heading in the shot.
  await second.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 160));
  await settle(viewer);
  await expectRegion(viewer, 'viewer-section-updating-light.png', [
    second.locator(':scope > h2'),
    second.locator('.eli5-busy-label'),
    second.locator(':scope > p').first(),
  ]);
  await l.app.evaluate(({ BrowserWindow }) => {
    const child = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as unknown as {
      webContents: Electron.WebContents;
    };
    child.webContents.send('eli5:doc:section-busy', { busy: [] });
  });
  await expect(second.locator('.eli5-busy-label')).toHaveCount(0);
});

test('a row mid-swipe rests with its Archive action showing', async () => {
  const r = row(l.win, 'Widget returns and refunds');
  const b = await r.boundingBox();
  if (!b) throw new Error('row not visible');
  await l.win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  // Past the reveal distance, short of the commit distance (swipe.ts): the row rests open.
  for (let i = 0; i < 3; i++) await l.win.mouse.wheel(20, 0);
  const item = library(l.win).locator('li.doc-row[data-slug="widget-returns"]');
  await expect(l.win.locator('.swipe-action.swipe-archive')).toBeVisible();
  await l.win.waitForTimeout(600); // settle (140 ms) and the resting transition
  await expect(item).toHaveScreenshot('sidebar-row-swipe-archive-light.png', { mask: volatile(l.win) });
  await l.win.keyboard.press('Escape');
  await expect(l.win.locator('.swipe-action.swipe-archive')).toBeHidden();
});

test('Trash view', async () => {
  await library(l.win).locator('.trash-row').click();
  const view = l.win.getByRole('region', { name: 'Trash' });
  await expect(view.locator('.trash-item .item-title')).toHaveText(['Old forecast']);
  await l.win.mouse.move(1, 1);
  await expect(view).toHaveScreenshot('trash-view-light.png', { mask: volatile(l.win) });
});

test('new-draft input zone with sources', async () => {
  await dropFiles(l.win, ['text/notes.md', 'docx/policy-memo.docx']);
  const form = l.win.getByRole('form', { name: 'New explainer' });
  await l.win.mouse.move(1, 1);
  await expect(form).toHaveScreenshot('input-zone-chips-light.png');
  await l.win.getByRole('button', { name: 'Remove notes.md' }).click();
  await l.win.getByRole('button', { name: 'Remove policy-memo.docx' }).click();
  await expect(l.win.getByRole('list', { name: 'Added sources' })).toHaveCount(0);
});

test('Settings: AI provider and Documents (stock photos)', async () => {
  await l.win
    .getByRole('button', { name: /^⚙?\s*Settings$/ })
    .first()
    .click();
  await expect(l.win.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  const docs = l.win.locator('#settings-documents');
  await expect(docs).toContainText('stock photos');
  await l.win.mouse.move(1, 1);
  await expect(l.win.locator('#settings-ai')).toHaveScreenshot('settings-ai-light.png');
  await docs.scrollIntoViewIfNeeded();
  await expect(docs).toHaveScreenshot('settings-documents-light.png');
});

test('Versions panel: a branch, an asked version and the current one', async () => {
  await openFromLibrary(l.win, 'Widget returns and refunds');
  await viewerPage(l.app, 'widget-returns');
  await expect(l.win.locator('.doc-header h1')).toHaveText('Widget returns and refunds');
  const toggle = l.win.locator('.doc-header').getByRole('button', { name: /^Versions/ });
  await expect(toggle.locator('.count-badge')).toHaveText('5');
  await toggle.click();
  const panel = l.win.getByRole('complementary', { name: 'Versions' });
  const items = panel.getByRole('treeitem');
  await expect(items).toHaveCount(5);
  await expect(panel.locator('[role=treeitem][aria-current=true] > .version-row .version-topic')).toHaveText(
    'What to watch next',
  );
  await expect(panel.locator('.version-question')).toHaveText('“Why does the forecast lag behind demand?”');
  await expect(panel.locator('.version-meta').first()).toHaveText('Original · 5h ago');
  await l.win.mouse.move(1, 1);
  // The panel stretches to the viewer's height, so its height is not pictured. Geometry instead:
  // the footer sits at the panel's bottom and the tree shows every version without scrolling.
  const tree = panel.getByRole('tree', { name: 'Document versions' });
  const footer = panel.locator('.version-footer');
  await expectBottomsAligned(panel, footer, 1);
  await expectNoOverflow(tree);
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(l, theme);
    await settle(l.win);
    // Pictured at a fixed height: the header and the tree down to its last row, then the footer.
    await expectClip(l.win, `version-panel-${theme}.png`, await topClip(panel, items, 8));
    await expect(footer).toHaveScreenshot(`version-panel-footer-${theme}.png`);
  }
  await setTheme(l, 'light');
});
