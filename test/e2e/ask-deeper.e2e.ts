import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { validateDocument } from '../helpers/doc-validity';
import {
  Harness,
  TITLE,
  fakeCalls,
  generate,
  openFromLibrary,
  probeDocument,
  viewerUrl,
  type Launched,
} from './harness';

/**
 * Ask deeper end to end (08 §6.10): select a passage, Cmd+Shift+Enter in the question field sends
 * Ask deeper; the fake provider (the default script reports one web page) answers with that page and
 * one it never reported; the box carries the web badge and lists only the reported page, as plain
 * text; the Versions panel shows "Asked (deeper)". FakeProvider only; needs a test build
 * (ELI5_TEST_BUILD=1, `npm run test:e2e`).
 */

test.describe.configure({ mode: 'serial' });

const h = new Harness();
test.afterAll(() => h.cleanup());
test.afterEach(() => h.assertNoModals());

const LEAD = 'Lead time is six weeks.';
const QUESTION = 'How long does a moving average take to catch up?';

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

const sectionId = (page: Page, heading: string): Promise<string> =>
  page.evaluate(
    (hd) =>
      Array.from(
        document.querySelectorAll<HTMLElement>('.tabpanel[data-tab-key="indepth"] section[data-section-id]'),
      ).find((s) => s.querySelector(':scope > h2')?.textContent === hd)?.id ?? '',
    heading,
  );

test.describe('Ask deeper on a new document', () => {
  let l: Launched;
  let slug: string;
  let viewer: Page;
  let forecast: string;
  let docFile: string;

  test.beforeAll(async () => {
    const dirs = await h.tempDirs('eli5-e2e-ask-deeper-');
    l = await h.launch(dirs);
    slug = (await generate(l)).topicSlug;
    await openFromLibrary(l.win, TITLE);
    viewer = await viewerPage(l.app, slug);
    forecast = await sectionId(viewer, 'How the forecast is built');
    expect(forecast).not.toBe('');
    docFile = path.join(dirs.library, slug, 'index.html');
  });

  test.afterAll(() => h.closeAll());

  test('Cmd+Shift+Enter sends Ask deeper; the box lists only reported pages; Versions shows "Asked (deeper)"', async () => {
    const target = viewer.locator(`#${forecast}`).getByText(LEAD, { exact: true });
    await target.scrollIntoViewIfNeeded();
    await target.click({ clickCount: 3 });
    await expect
      .poll(async () => {
        await viewer.keyboard.press('Meta+Period');
        return viewer.evaluate(() => document.activeElement?.hasAttribute('data-eli5-noact') ?? false);
      })
      .toBe(true);
    await viewer.keyboard.press('Shift+Tab');
    await viewer.keyboard.type(QUESTION);
    await viewer.keyboard.press('Meta+Shift+Enter');

    const box = viewer.locator(`#${forecast} aside.qa.qa-deeper`);
    await expect(box).toHaveCount(1, { timeout: 30_000 });
    await expect(box).toHaveAttribute('aria-label', 'Deeper answer to a reader question');
    await expect(box).not.toHaveClass(/qa-deep(\s|$)/);
    await expect(box.locator('.qa-q-text')).toHaveText(QUESTION);
    await expect(box.locator('.qa-badge')).toHaveText(
      'Deeper answer · includes information from the web (pages listed below)',
    );
    await expect(box.locator('.qa-a strong')).toHaveText('Partly');
    // Only the page the provider reported, without its fragment; the invented one is dropped.
    await expect(box.locator('ul.qa-web > li')).toHaveText([
      'Moving averages explained — example.org/forecasting/moving-averages',
    ]);
    await expect(box.locator('a')).toHaveCount(0);

    const calls = await fakeCalls(l.app);
    const deeper = calls.filter((c) => c.taskId === 'section-ask-deeper');
    expect(deeper).toHaveLength(1);
    expect(deeper[0]?.webSearch).toEqual({ maxUses: 3 });
    expect(calls.some((c) => c.taskId === 'section-ask' || c.taskId === 'section-ask-deep')).toBe(false);

    const html = await readFile(docFile, 'utf8');
    expect(html).not.toContain('example.com/not-reported');
    expect(validateDocument(html).errors).toEqual([]);
    await probeDocument(l.app, docFile);
    const meta = JSON.parse(await readFile(path.join(path.dirname(docFile), 'meta.json'), 'utf8')) as {
      asks?: { depth?: string }[];
    };
    expect(meta.asks?.at(-1)?.depth).toBe('deeper');

    // 11 §5.7: the Versions panel names the change "Asked (deeper)" and shows the question.
    const toggle = l.win.locator('.doc-header').getByRole('button', { name: /^Versions/ });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    const panel = l.win.getByRole('complementary', { name: 'Versions' });
    await expect(panel.getByRole('tree', { name: 'Document versions' })).toBeVisible();
    const tree = await l.win.evaluate((s) => window.eli5.doc.versions(s), slug);
    if (!tree.ok) throw new Error(tree.error.message);
    const currentId = (tree.value as { currentId: string }).currentId;
    const row = panel.locator(`[role=treeitem][data-id="${currentId}"]`);
    await expect(row.locator('.version-meta')).toContainText('Asked (deeper)');
    await expect(row.locator('.version-question')).toHaveText(`“${QUESTION}”`);
  });
});
