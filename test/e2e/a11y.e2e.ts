import AxeBuilder from '@axe-core/playwright';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  Harness,
  dropFiles,
  generate,
  startDraft,
  jobText,
  openFromLibrary,
  viewerUrl,
  writeScript,
  type Launched,
} from './harness';

/**
 * Accessibility of the app UI (13 §10 "Accessibility", 11 §12): axe-core reports zero serious or
 * critical violations on the Library, input zone, status area, suggestions, the Versions panel and
 * Settings, in light and dark themes. Inside the viewer only the app's own additions are scanned:
 * the selection menu with each popup open and an answer box (the document itself is covered by
 * the golden checks).
 * FakeProvider only; needs a test build (ELI5_TEST_BUILD=1, `npm run test:e2e`).
 */

test.describe.configure({ mode: 'serial' });

const h = new Harness();
// Modal guard per test (13 §8.1); the shared app stays up for the next test.
test.afterEach(() => h.assertNoModals());
test.afterAll(async () => {
  try {
    await h.closeAll();
  } finally {
    await h.cleanup();
  }
});

interface Finding {
  id: string;
  impact: string | null | undefined;
  targets: string[];
  help: string;
}

/** Serious and critical axe findings for the app renderer (or `include` in a page) as it is now. */
async function blocking(win: Page, include: string[] = []): Promise<Finding[]> {
  // Legacy mode runs in the page itself: Electron cannot open the extra page axe uses otherwise.
  let axe = new AxeBuilder({ page: win }).setLegacyMode(true);
  for (const sel of include) axe = axe.include(sel);
  const r = await axe.analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      // The summary names the measured values (a contrast ratio and its colours).
      targets: v.nodes.map((n) => `${n.target.join(' ')}: ${n.failureSummary ?? ''}`),
    }));
}

/**
 * Light and dark tokens follow `prefers-color-scheme` (11 §12). Playwright pins that media feature
 * for pages it drives, so the scan emulates it as well as setting the native theme.
 */
async function setTheme(l: Launched, theme: 'light' | 'dark' | 'system'): Promise<void> {
  await l.app.evaluate(({ nativeTheme }, t) => {
    nativeTheme.themeSource = t;
  }, theme);
  await l.win.emulateMedia({ colorScheme: theme === 'system' ? null : theme });
}

/** `page` and `include`: scan that page (the viewer) instead of the app renderer, limited to `include`. */
async function scanBothThemes(
  l: Launched,
  screen: string,
  target: { page: Page; include: string[] } = { page: l.win, include: [] },
): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(l, theme);
    if (target.page !== l.win) await target.page.emulateMedia({ colorScheme: theme });
    for (const p of [l.win, target.page]) {
      await expect
        .poll(() => p.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
        .toBe(theme === 'dark');
    }
    expect(await blocking(target.page, target.include), `${screen} (${theme})`).toEqual([]);
  }
  await setTheme(l, 'system');
  if (target.page !== l.win) await target.page.emulateMedia({ colorScheme: null });
}

/** The viewer's page (the WebContentsView showing eli5doc://doc/<slug>/). */
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

/** Selects a passage with a real triple click, then moves focus into the menu's note (Cmd+.). */
async function focusMenu(page: Page, sectionId: string, text: string): Promise<void> {
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

let l: Launched;
let docSlug = '';

test.beforeAll(async () => {
  const dirs = await h.tempDirs('eli5-e2e-a11y-');
  // The first document leads a later one to a merge suggestion (09 §10.2); the first in-depth call
  // of the second launch fails, so a failed line with its Settings link is on screen too.
  const first = await h.launch(dirs);
  const a = await generate(first);
  await h.close(first.app); // asserts the first launch recorded no modal either
  const script = await writeScript(dirs, 'a11y', {
    responses: { 'merge-match': { matches: [{ catalogId: a.id, score: 0.9, reason: 'Same widget supply plan' }] } },
    errors: { 'in-depth': ['auth'] },
  });
  l = await h.launch(dirs, { script });
});

test('welcome, empty input zone and Library render without serious or critical violations', async () => {
  await expect(l.win.getByRole('navigation', { name: 'Library' })).toBeVisible();
  await expect(l.win.getByRole('form', { name: 'New explainer' })).toBeVisible();
  await scanBothThemes(l, 'welcome');
});

test('input zone with chips, an inline hint and a URL error', async () => {
  await dropFiles(l.win, ['text/notes.md', 'docx/policy-memo.docx']);
  const url = l.win.getByLabel('URL', { exact: true });
  await url.fill('not a url');
  await url.press('Enter');
  await expect(l.win.getByText('Enter a web address that starts with http:// or https://')).toBeVisible();
  await scanBothThemes(l, 'input zone');
  await url.fill('');
  await l.win.getByRole('button', { name: 'Remove notes.md' }).click();
  await l.win.getByRole('button', { name: 'Remove policy-memo.docx' }).click();
  await expect(l.win.getByRole('list', { name: 'Added sources' })).toHaveCount(0);
});

test('Library, a document header, status lines and a pending suggestion', async () => {
  // A failed line (the scripted auth error), then a done line.
  await dropFiles(l.win, ['text/plain.txt']);
  await startDraft(l.win);
  await expect(jobText(l.win)).toHaveText(/^Failed: API key rejected/, { timeout: 30_000 });
  const b = await generate(l);
  const panel = l.win.getByRole('region', { name: /Suggestions/ });
  await expect(panel.getByRole('heading')).toHaveText('Suggestions (1)', { timeout: 30_000 });
  docSlug = b.topicSlug;
  await openFromLibrary(l.win, b.title);
  await expect(l.win.locator('.doc-header h1')).toBeVisible();
  // The first launch's done line is still listed (06 §6: done lines stay 10 minutes).
  await expect(l.win.locator('.job-line[data-status="failed"]')).toHaveCount(1);
  await expect(l.win.locator('.job-line[data-status="done"]')).toHaveCount(2);
  await scanBothThemes(l, 'document view');
});

test('Versions panel, the selection menu with each popup open, and an answer box', async () => {
  const viewer = await viewerPage(l.app, docSlug);
  // The menu lives in a closed shadow root, which axe cannot enter: open it for the scan. The
  // init script applies from the next load, which the Ask below triggers.
  await viewer.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      return attach.call(this, { ...init, mode: 'open' });
    };
  });
  const id = await viewer.evaluate(
    () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('.tabpanel[data-tab-key="indepth"] section[data-section-id]'),
      ).find((s) => s.querySelector(':scope > h2')?.textContent === 'How the forecast is built')?.id ?? '',
  );
  expect(id).not.toBe('');
  const lead = 'Lead time is six weeks.';
  await focusMenu(viewer, id, lead);
  await viewer.keyboard.press('Shift+Tab'); // the question field
  await viewer.keyboard.type('Why does the forecast lag behind demand?');
  await viewer.keyboard.press('Enter');
  await expect(viewer.locator(`#${id} aside.qa`)).toHaveCount(1, { timeout: 30_000 });
  await expect(viewer.locator(`#${id} aside.qa details.qa-q`)).toHaveAttribute('open', '');

  // Two versions: the panel shows a tree with a current row.
  await l.win
    .locator('.doc-header')
    .getByRole('button', { name: /^Versions/ })
    .click();
  const panel = l.win.getByRole('complementary', { name: 'Versions' });
  await expect(panel.getByRole('treeitem')).toHaveCount(2);
  await scanBothThemes(l, 'versions panel');

  const scope = { page: viewer, include: ['body > div[data-eli5-noact]:not(.viz-tip)', 'aside.qa'] };
  await focusMenu(viewer, id, lead);
  await viewer.keyboard.press('Enter'); // the note's Enter opens Explain
  await expect(viewer.getByRole('menu', { name: 'Explain' })).toBeVisible();
  await scanBothThemes(l, 'selection menu, Explain open', scope);
  await viewer.keyboard.press('ArrowRight'); // onto the ELI5 trigger, Explain closed
  await viewer.keyboard.press('ArrowDown'); // opens ELI5
  await expect(viewer.getByRole('menu', { name: 'ELI5' })).toBeVisible();
  await expect(viewer.getByRole('menu', { name: 'Explain' })).toBeHidden();
  await scanBothThemes(l, 'selection menu, ELI5 open', scope);
  await viewer.keyboard.press('Escape');
  await viewer.keyboard.press('Escape');
  await panel.getByRole('button', { name: 'Close' }).click();
});

test('Settings, every section', async () => {
  // The sidebar gear (the failed job line also has a "Settings" link).
  await l.win
    .getByRole('button', { name: /^⚙?\s*Settings$/ })
    .first()
    .click();
  await expect(l.win.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await scanBothThemes(l, 'settings');
});
