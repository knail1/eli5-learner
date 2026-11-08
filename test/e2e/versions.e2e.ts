import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { validateDocument } from '../helpers/doc-validity';
import {
  Harness,
  TITLE,
  generate,
  libraryEntries,
  openFromLibrary,
  probeDocument,
  viewerUrl,
  writeScript,
  type Dirs,
  type Launched,
} from './harness';

/**
 * Ask and the version tree end to end (13 §8.2 E19-E24): an answer box with anchor scroll, a fork
 * from the built-in actions shown in the Versions panel, opening an older version, Forward
 * retracing the last-visited branch, the busy refusal and the runtime refresh of an older
 * document. FakeProvider only; needs a test build (ELI5_TEST_BUILD=1, `npm run test:e2e`).
 */

test.describe.configure({ mode: 'serial' });

const h = new Harness();
test.afterAll(() => h.cleanup());
// Modal guard after every test (13 §8.1), including those sharing one app.
test.afterEach(() => h.assertNoModals());

const LEAD = 'Lead time is six weeks.';
const WATCH = 'If online growth continues, the buffer for that channel will need to grow too.';
const QUESTION = 'Why does the forecast lag behind demand?';
const EXPANDED = 'How the forecast is built, step by step';

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

/** The In depth section whose heading is `heading`, by id. */
const sectionId = (page: Page, heading: string): Promise<string> =>
  page.evaluate(
    (hd) =>
      Array.from(
        document.querySelectorAll<HTMLElement>('.tabpanel[data-tab-key="indepth"] section[data-section-id]'),
      ).find((s) => s.querySelector(':scope > h2')?.textContent === hd)?.id ?? '',
    heading,
  );

/** Selects a passage with a real triple click, then moves focus into the menu's note (Cmd+.). */
async function selectAndFocusMenu(page: Page, id: string, text: string): Promise<void> {
  const target = page.locator(`#${id}`).getByText(text, { exact: true });
  await target.scrollIntoViewIfNeeded();
  await target.click({ clickCount: 3 });
  // The menu lives in a closed shadow root: focus inside it shows as the host being active.
  await expect
    .poll(async () => {
      await page.keyboard.press('Meta+Period');
      return page.evaluate(() => document.activeElement?.hasAttribute('data-eli5-noact') ?? false);
    })
    .toBe(true);
}

/** Note field -> Shift+Tab to the question field (08 §5.4), type, Enter submits Ask. */
async function ask(page: Page, id: string, text: string, question: string): Promise<void> {
  await selectAndFocusMenu(page, id, text);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.type(question);
  await page.keyboard.press('Enter');
}

/** Note field -> Enter opens Explain on its first item; `down` more steps, then Enter. */
async function explain(page: Page, id: string, text: string, down: number): Promise<void> {
  await selectAndFocusMenu(page, id, text);
  await page.keyboard.press('Enter');
  for (let i = 0; i < down; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
}

/** Removes the target `<section>` and the embedded model: what must be byte-identical (08 acceptance). */
function outside(html: string, id: string): string {
  const start = html.indexOf(`<section id="${id}"`);
  expect(start, `section ${id} in file`).toBeGreaterThanOrEqual(0);
  const end = html.indexOf('</section>', start) + '</section>'.length;
  const rest = html.slice(0, start) + html.slice(end);
  return rest.replace(/<script type="application\/json" id="eli5-model">[\s\S]*?<\/script>/, '');
}

/** The section's offset under the sticky tab bar and the page's scroll (the E8 check). */
const underTabBar = (page: Page, id: string) =>
  page.evaluate((sid) => {
    const bar = document.querySelector('nav.tabbar')?.getBoundingClientRect().bottom ?? 0;
    const top = document.getElementById(sid)?.getBoundingClientRect().top ?? -1;
    return { scrollY: window.scrollY, offset: Math.abs(top - bar) };
  }, id);

interface WireNode {
  id: string;
  parentId: string | null;
  kind: string;
  label: string;
  topic: string;
}
interface WireTree {
  nodes: WireNode[];
  currentId: string;
  redoId?: string;
  busy: boolean;
}

async function versions(l: Launched, slug: string): Promise<WireTree> {
  const r = await l.win.evaluate((s) => window.eli5.doc.versions(s), slug);
  if (!r.ok) throw new Error(r.error.message);
  return r.value as WireTree;
}

const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;

const panel = (win: Page) => win.getByRole('complementary', { name: 'Versions' });
const treeItem = (win: Page, id: string) => panel(win).locator(`[role=treeitem][data-id="${id}"]`);

/** Opens the Versions panel from the document header (11 §5.3) unless it is already open. */
async function openPanel(win: Page): Promise<void> {
  const toggle = win.locator('.doc-header').getByRole('button', { name: /^Versions/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(panel(win).getByRole('tree', { name: 'Document versions' })).toBeVisible();
}

test.describe('Ask and the version tree on one document', () => {
  let dirs: Dirs;
  let l: Launched;
  let slug: string;
  let viewer: Page;
  /** "How the forecast is built": asked about, then forked. */
  let forecast: string;
  let askedId: string;
  let expandId: string;
  let analogyId: string;
  let afterExpand: string;
  const docFile = () => path.join(dirs.library, slug, 'index.html');
  const metaFile = () => path.join(dirs.library, slug, 'meta.json');

  test.beforeAll(async () => {
    dirs = await h.tempDirs('eli5-e2e-versions-');
    l = await h.launch(dirs);
    slug = (await generate(l)).topicSlug;
    await openFromLibrary(l.win, TITLE);
    viewer = await viewerPage(l.app, slug);
    forecast = await sectionId(viewer, 'How the forecast is built');
    expect(forecast).not.toBe('');
  });

  test.afterAll(() => h.closeAll());

  test('E19: Ask adds an answer box, scrolls to it with the question open, and touches nothing else', async () => {
    const before = await readFile(docFile(), 'utf8');
    await viewer.evaluate(() => window.scrollTo(0, 0));
    await ask(viewer, forecast, LEAD, QUESTION);

    const box = viewer.locator(`#${forecast} aside.qa`);
    await expect(box).toHaveCount(1, { timeout: 30_000 });
    await expect(box.locator('.qa-q-text')).toHaveText(QUESTION);
    await expect(box.locator('.qa-a strong')).toHaveText('backwards');
    // 07 §6.5: the box goes right after the block the selection was in (and that block's glossary
    // notes, which render straight after it).
    const afterBlock = await viewer.evaluate(
      ([sid, lead]) => {
        const block = Array.from(document.querySelectorAll(`#${sid} > *`)).find(
          (el) => el.textContent?.includes(lead ?? '') && !el.matches('aside.qa'),
        );
        let next = block?.nextElementSibling;
        while (next?.matches('details.gl-note')) next = next.nextElementSibling;
        return next?.matches('aside.qa') ?? false;
      },
      [forecast, LEAD],
    );
    expect(afterBlock).toBe(true);
    // 08 §7.4: the viewer lands on the box (centred, focused) with its question revealed.
    await expect(box.locator('details.qa-q')).toHaveAttribute('open', '');
    await expect(box).toBeFocused();
    const pos = await box.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, vh: innerHeight, scrollY };
    });
    expect(pos.scrollY).toBeGreaterThan(0);
    expect(pos.top).toBeGreaterThanOrEqual(0);
    expect(pos.bottom).toBeLessThanOrEqual(pos.vh);

    const after = await readFile(docFile(), 'utf8');
    const qaId = (await box.getAttribute('id')) ?? '';
    expect(after).toContain(`<aside class="qa" id="${qaId}"`);
    expect(after).toContain(QUESTION);
    // The document was written by this build, so no runtime upgrade rides along.
    expect(outside(after, forecast)).toBe(outside(before, forecast));
    expect(validateDocument(after).errors).toEqual([]);
    await probeDocument(l.app, docFile());
    const meta = await readJson<{ asks?: { sectionId: string; tabKey: string; question: string; qaId: string }[] }>(
      metaFile(),
    );
    expect(meta.asks).toEqual([
      expect.objectContaining({ sectionId: forecast, tabKey: 'indepth', question: QUESTION, qaId }),
    ]);
    const tree = await versions(l, slug);
    const current = tree.nodes.find((n) => n.id === tree.currentId);
    expect(current).toMatchObject({ kind: 'ask', topic: 'why the forecast lags' });
    askedId = tree.currentId;
  });

  test('E20: Expand, Undo, Analogy make two branches under one version; the panel shows both', async () => {
    const undo = l.win.getByRole('button', { name: 'Undo', exact: true });
    const heading = viewer.locator(`#${forecast} > h2`);
    await explain(viewer, forecast, LEAD, 0); // "Expand this"
    await expect(heading).toHaveText(EXPANDED, { timeout: 30_000 });
    // 08 §6.6: answer boxes ride along a rewrite, at the end of the section.
    await expect(viewer.locator(`#${forecast} > aside.qa:last-child`)).toHaveCount(1);
    afterExpand = await readFile(docFile(), 'utf8');
    expandId = (await versions(l, slug)).currentId;

    await undo.click();
    await expect(heading).toHaveText('How the forecast is built', { timeout: 30_000 });
    expect((await versions(l, slug)).currentId).toBe(askedId);

    await explain(viewer, forecast, LEAD, 2); // "Give me an analogy"
    await expect(viewer.locator(`#${forecast} .analogy`)).toHaveCount(1, { timeout: 30_000 });
    const tree = await versions(l, slug);
    analogyId = tree.currentId;
    const children = tree.nodes.filter((n) => n.parentId === askedId);
    expect(children.map((n) => [n.id, n.kind])).toEqual([
      [expandId, 'expand'],
      [analogyId, 'analogy'],
    ]);

    // Cmd+Y is a native menu accelerator: drive its View > Show Versions item (11 §9).
    await l.app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('shortcut-toggle-versions')?.click();
    });
    await expect(l.win.locator('.doc-header').getByRole('button', { name: /^Versions/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await openPanel(l.win);
    // The asked version is the branch point: it owns a group holding the newer branch.
    const branchPoint = treeItem(l.win, askedId);
    await expect(branchPoint).toHaveAttribute('aria-expanded', 'true');
    await expect(branchPoint.locator(':scope > .version-row .version-topic')).toHaveText('why the forecast lags');
    await expect(branchPoint.locator(':scope > .version-row .version-question')).toHaveText(`“${QUESTION}”`);
    await expect(treeItem(l.win, expandId).locator(':scope > .version-row .version-meta')).toContainText('Expanded');
    await expect(treeItem(l.win, analogyId).locator(':scope > .version-row .version-meta')).toContainText(
      'Analogy added',
    );
    await expect(panel(l.win).locator('[role=treeitem][aria-current=true]')).toHaveAttribute('data-id', analogyId);
    await expect(panel(l.win).locator('[role=treeitem]')).toHaveCount(4); // original, asked, both branches
  });

  test('E21: opening an older version restores it and lands on the section it changed', async () => {
    await viewer.evaluate(() => window.scrollTo(0, 0));
    await treeItem(l.win, expandId).locator(':scope > .version-row').click();
    await expect(viewer.locator(`#${forecast} > h2`)).toHaveText(EXPANDED, { timeout: 30_000 });
    expect(await readFile(docFile(), 'utf8')).toBe(afterExpand);
    await expect(panel(l.win).locator('[role=treeitem][aria-current=true]')).toHaveAttribute('data-id', expandId);
    // The same landing as E8: the fork's section sits right under the tab bar.
    await expect.poll(async () => (await underTabBar(viewer, forecast)).offset).toBeLessThan(40);
    expect((await underTabBar(viewer, forecast)).scrollY).toBeGreaterThan(0);
    await expect(viewer.locator(`#${forecast} > h2`)).toBeFocused();
    const meta = await readJson<{ versionId?: string; asks?: unknown[] }>(metaFile());
    expect(meta.versionId).toBe(expandId);
    expect(meta.asks).toHaveLength(1);
  });

  test('E22: Back, then Forward retraces the last-visited branch, not the newest', async () => {
    const back = panel(l.win).getByRole('button', { name: 'Back to previous version' });
    const forward = panel(l.win).getByRole('button', { name: 'Forward to next version' });
    await back.click();
    await expect(viewer.locator(`#${forecast} > h2`)).toHaveText('How the forecast is built', { timeout: 30_000 });
    await expect.poll(async () => (await versions(l, slug)).currentId).toBe(askedId);
    expect((await versions(l, slug)).redoId).toBe(expandId);
    await expect(forward).toHaveAttribute('title', `Forward: expanded 'How the forecast is built'`);

    await forward.click();
    await expect(viewer.locator(`#${forecast} > h2`)).toHaveText(EXPANDED, { timeout: 30_000 });
    await expect.poll(async () => (await versions(l, slug)).currentId).toBe(expandId);
    expect(await readFile(docFile(), 'utf8')).toBe(afterExpand);

    // Going back to the analogy branch makes it the one Forward retraces.
    await treeItem(l.win, analogyId).locator(':scope > .version-row').click();
    await expect(viewer.locator(`#${forecast} .analogy`)).toHaveCount(1, { timeout: 30_000 });
    await back.click();
    await expect.poll(async () => (await versions(l, slug)).currentId).toBe(askedId);
    expect((await versions(l, slug)).redoId).toBe(analogyId);
    await forward.click();
    await expect.poll(async () => (await versions(l, slug)).currentId).toBe(analogyId);
  });

  test('E23: opening a version is refused while a section is being updated, inline and without a dialog', async () => {
    // Relaunch on the same library with a slow model, so the section stays busy for a while.
    await h.close(l.app);
    const script = await writeScript(dirs, 'slow', { latencyMs: 4_000 });
    l = await h.launch(dirs, { script });
    await openFromLibrary(l.win, TITLE);
    viewer = await viewerPage(l.app, slug);
    await openPanel(l.win);
    const watch = await sectionId(viewer, 'What to watch next');
    const beforeBusy = await readFile(docFile(), 'utf8');
    const metaBeforeBusy = await readFile(metaFile(), 'utf8');
    await explain(viewer, watch, WATCH, 0); // "Expand this", answered after 4 s

    await expect(viewer.locator(`#${watch} .eli5-busy-label`)).toHaveText('Updating…');
    await expect(panel(l.win).getByText('Wait for the update to finish')).toBeVisible();
    const older = treeItem(l.win, askedId);
    await expect(older).toHaveAttribute('aria-disabled', 'true');
    await older.locator(':scope > .version-row').click();
    // The service refuses as well, for any caller (08 §6.7).
    const r = await l.win.evaluate(([s, id]) => window.eli5.doc.checkout(s!, id!), [slug, askedId]);
    expect(r).toMatchObject({ ok: false, error: { message: 'Wait for the section update to finish' } });
    expect((await versions(l, slug)).currentId).toBe(analogyId);
    // Nothing was written by the refused checkout (the update itself has not landed yet).
    expect(await readFile(docFile(), 'utf8')).toBe(beforeBusy);
    expect(await readFile(metaFile(), 'utf8')).toBe(metaBeforeBusy);
    await expect(viewer.locator(`#${watch} .eli5-busy-label`)).toHaveText('Updating…');

    // Once the update lands, the new version hangs off the analogy branch and rows enable again.
    await expect(viewer.locator(`#${watch} > h2`)).toHaveText(EXPANDED, { timeout: 30_000 });
    await expect(panel(l.win).getByText('Wait for the update to finish')).toHaveCount(0);
    await expect(older).not.toHaveAttribute('aria-disabled', 'true');
    const tree = await versions(l, slug);
    expect(tree.nodes.find((n) => n.id === tree.currentId)).toMatchObject({ parentId: analogyId, kind: 'expand' });
  });
});

/**
 * E10's "prior version" document: written once by the 0.1.0 build (runtime 1.0.0, the flat menu
 * without Ask) and committed as is. Never regenerate it.
 */
const PRIOR = path.resolve('test/e2e/fixtures/prior-version/widget-supply-planning');

/** The embedded model (`#eli5-model`), parsed. */
function modelOf(html: string): unknown {
  const m = /<script type="application\/json" id="eli5-model">([\s\S]*?)<\/script>/.exec(html);
  expect(m, 'embedded model').not.toBeNull();
  return JSON.parse(m![1]!) as unknown;
}

test('E24: a document from an older runtime gets the new menu once opened (runtime refresh)', async () => {
  const dirs = await h.tempDirs('eli5-e2e-versions-old-');
  const slug = 'widget-supply-planning';
  const dir = path.join(dirs.library, slug);
  const docFile = path.join(dir, 'index.html');
  await mkdir(dir, { recursive: true });
  const oldHtml = await readFile(path.join(PRIOR, 'index.html.frozen'), 'utf8');
  expect(oldHtml).toContain('; runtime 1.0.0"');
  expect(oldHtml).not.toContain('Ask a question about this');
  await writeFile(docFile, oldHtml);
  await copyFile(path.join(PRIOR, 'meta.json.frozen'), path.join(dir, 'meta.json'));

  const l = await h.launch(dirs);
  await expect.poll(async () => (await libraryEntries(l.win)).map((e) => e.topicSlug)).toEqual([slug]);
  await openFromLibrary(l.win, TITLE);
  // 07 §5.5: the open re-renders the same model with the bundled runtime, once, in place.
  await expect.poll(() => readFile(docFile, 'utf8')).not.toContain('; runtime 1.0.0"');
  const refreshed = await readFile(docFile, 'utf8');
  expect(refreshed).toContain('Ask a question about this');
  expect(validateDocument(refreshed).errors).toEqual([]);
  await probeDocument(l.app, docFile);
  // Same model, same version: the refresh is no change of its own.
  const tree = await versions(l, slug);
  expect(tree.nodes).toHaveLength(1);
  expect(tree.currentId).toBe(tree.nodes[0]?.id);
  // Only the stamped runtime version moves, plus parse's palette remap of diagrams stored by a
  // runtime older than the colour-blind-safe palette (07 §7.3, PALETTE_RUNTIME_VERSION).
  type Stamped = { generator: Record<string, unknown> };
  const oldModel = modelOf(oldHtml) as Stamped;
  const refreshedModel = modelOf(refreshed) as Stamped;
  expect(JSON.stringify(refreshedModel)).toContain(' viz-pal-2');
  const newModel = JSON.parse(JSON.stringify(refreshedModel).split(' viz-pal-2').join('')) as Stamped;
  expect(newModel.generator.runtimeVersion).not.toBe('1.0.0');
  expect(newModel).toEqual({
    ...oldModel,
    generator: { ...oldModel.generator, runtimeVersion: newModel.generator.runtimeVersion },
  });

  // The viewer shows the refreshed file, whose menu has the Ask field.
  const viewer = await viewerPage(l.app, slug);
  const id = await sectionId(viewer, 'How the forecast is built');
  expect(id).not.toBe('');
  await ask(viewer, id, LEAD, QUESTION);
  await expect(viewer.locator(`#${id} aside.qa .qa-q-text`)).toHaveText(QUESTION, { timeout: 30_000 });
  const after = await versions(l, slug);
  expect(after.nodes.map((n) => n.kind)).toEqual([tree.nodes[0]?.kind, 'ask']);
  await h.closeAll();
});
