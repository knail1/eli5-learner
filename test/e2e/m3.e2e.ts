import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { validateDocument } from '../helpers/doc-validity';
import {
  Harness,
  TEST_KEY,
  TITLE,
  generate,
  libraryEntries,
  probeDocument,
  viewerUrl,
  writeScript,
  type Dirs,
  type Launched,
} from './harness';

/**
 * M3 end-to-end (13 §8.2): interactive reading (E8, E9, plain-browser parity, 08 §2 item 6), the
 * "Document ready" notification (E16), merge suggestions (E11), local publishing (10), Settings
 * persistence (E13, E15) and the public build's hidden enterprise UI (E14). FakeProvider only;
 * requires a test build (ELI5_TEST_BUILD=1, `npm run test:e2e`).
 */

test.describe.configure({ mode: 'serial' });

const h = new Harness();
test.afterAll(() => h.cleanup());
// Modal guard after every test (13 §8.1), including those sharing the reading app.
test.afterEach(() => h.assertNoModals());

interface SpyRecord {
  title: string;
  body: string;
  shown: boolean;
}

const spyRecords = (app: ElectronApplication): Promise<SpyRecord[]> =>
  app.evaluate(() => {
    const spy = (globalThis as { __eli5NotificationSpy?: { records: SpyRecord[] } }).__eli5NotificationSpy;
    return (spy?.records ?? []).map((r) => ({ title: r.title, body: r.body, shown: r.shown }));
  });

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

async function openFromLibrary(l: Launched, title: string): Promise<void> {
  const nav = l.win.getByRole('navigation', { name: 'Library' });
  await nav
    .getByRole('button', { name: new RegExp(title) })
    .first()
    .click();
}

/** Section IDs of one tab in document order, with their headings. */
const sectionsOf = (page: Page, tabKey: string) =>
  page.evaluate(
    (k) =>
      Array.from(document.querySelectorAll<HTMLElement>(`.tabpanel[data-tab-key="${k}"] section[data-section-id]`)).map(
        (s) => ({ id: s.id, heading: s.querySelector(':scope > h2')?.textContent ?? '' }),
      ),
    tabKey,
  );

/** Selects a passage with a real triple click, then opens the inline menu with Cmd+. (08 §5.2 step 7). */
async function selectAndFocusMenu(page: Page, sectionId: string, text: string): Promise<void> {
  const target = page.locator(`#${sectionId}`).getByText(text, { exact: true });
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

/** Removes the target `<section>` and the embedded model: what must be byte-identical (08 acceptance). */
function outside(html: string, sectionId: string): string {
  const start = html.indexOf(`<section id="${sectionId}"`);
  expect(start, `section ${sectionId} in file`).toBeGreaterThanOrEqual(0);
  const end = html.indexOf('</section>', start) + '</section>'.length;
  const rest = html.slice(0, start) + html.slice(end);
  return rest.replace(/<script type="application\/json" id="eli5-model">[\s\S]*?<\/script>/, '');
}

const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;

test.describe('reading a finished document', () => {
  let dirs: Dirs;
  let l: Launched;
  let slug: string;
  let viewer: Page;
  const docFile = () => path.join(dirs.library, slug, 'index.html');
  const metaFile = () => path.join(dirs.library, slug, 'meta.json');

  test.beforeAll(async () => {
    dirs = await h.tempDirs('eli5-e2e-m3-read-');
    l = await h.launch(dirs);
    slug = (await generate(l)).topicSlug;
  });

  test.afterAll(() => h.closeAll());

  test('E16: a finished job posts exactly one "Document ready"; its click opens the document', async () => {
    await expect.poll(() => spyRecords(l.app)).toEqual([{ title: 'Document ready', body: TITLE, shown: true }]);

    // The user is elsewhere with the window closed (hidden, 11 §3).
    await l.win.getByRole('button', { name: 'Settings' }).click();
    await expect(l.win.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    expect(await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(false);

    await l.app.evaluate(() => {
      const spy = (globalThis as { __eli5NotificationSpy?: { records: { click(): void }[] } }).__eli5NotificationSpy;
      spy?.records[0]?.click();
    });
    await expect
      .poll(() => l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()))
      .toBe(true);
    await expect(l.win.locator('.doc-header h1')).toHaveText(TITLE);
    viewer = await viewerPage(l.app, slug);
    await expect(viewer.locator('nav.tabbar [role=tab]')).toHaveText(['In depth', 'ELI5']);
  });

  test('E8: Expand on a selection replaces only that section and scrolls the viewer to it', async () => {
    const before = await readFile(docFile(), 'utf8');
    const sectionsBefore = await sectionsOf(viewer, 'indepth');
    const target = sectionsBefore.find((s) => s.heading === 'How the forecast is built');
    expect(target).toBeDefined();
    const id = target?.id ?? '';
    await viewer.evaluate(() => window.scrollTo(0, 0));

    await selectAndFocusMenu(viewer, id, 'Lead time is six weeks.');
    await viewer.keyboard.press('Enter'); // note field: moves to the first action (08 §5.4)
    await viewer.keyboard.press('Enter'); // "Expand this"

    // The viewer reloads with the new section in place and scrolls it under the tab bar (08 §7.4).
    await expect(viewer.locator(`#${id} > h2`)).toHaveText('How the forecast is built, step by step', {
      timeout: 30_000,
    });
    await expect(viewer.locator(`#${id} > h2`)).toBeFocused();
    const pos = await viewer.evaluate((sid) => {
      const bar = document.querySelector('nav.tabbar')?.getBoundingClientRect().bottom ?? 0;
      const top = document.getElementById(sid)?.getBoundingClientRect().top ?? -1;
      return { scrollY: window.scrollY, offset: Math.abs(top - bar) };
    }, id);
    expect(pos.scrollY).toBeGreaterThan(0);
    expect(pos.offset).toBeLessThan(40);

    const after = await readFile(docFile(), 'utf8');
    expect(after).not.toBe(before);
    expect(outside(after, id)).toBe(outside(before, id));
    expect(await sectionsOf(viewer, 'indepth')).toEqual(
      sectionsBefore.map((s) => (s.id === id ? { id, heading: 'How the forecast is built, step by step' } : s)),
    );
    const report = validateDocument(after);
    expect(report.errors).toEqual([]);
    await probeDocument(l.app, docFile());
    const meta = await readJson<{ actions?: { action: string }[] }>(metaFile());
    expect(meta.actions?.map((a) => a.action)).toEqual(['expand']);
    // A section action never notifies (11 §14.2, E16).
    expect(await spyRecords(l.app)).toHaveLength(1);
  });

  test('E9: a Section ELI5 tab is created at the right from a selection, then closed', async () => {
    const source = (await sectionsOf(viewer, 'indepth')).find((s) => s.heading === 'Why the plan matters');
    const id = source?.id ?? '';
    await selectAndFocusMenu(viewer, id, 'The plan balances two costs: holding too much stock and running out.');
    await viewer.keyboard.press('Enter');
    for (let i = 0; i < 4; i++) await viewer.keyboard.press('ArrowRight');
    await viewer.keyboard.press('Enter'); // "Create a separate ELI5 for this section"

    const tabs = viewer.locator('nav.tabbar [role=tab]');
    await expect(tabs).toHaveText(['In depth', 'ELI5', 'ELI5: Why the plan matters'], { timeout: 30_000 });
    await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
    const meta = await readJson<{ tabs: { key: string; kind: string; label: string }[] }>(metaFile());
    const added = meta.tabs.find((t) => t.kind === 'section-eli5');
    expect(added?.label).toBe('ELI5: Why the plan matters');
    expect(validateDocument(await readFile(docFile(), 'utf8')).errors).toEqual([]);
    // The probe walks the third tab too.
    expect((await probeDocument(l.app, docFile())).tabs).toEqual(['indepth', 'eli5', added?.key]);

    // Two-step inline confirm, no modal (08 §7.2).
    const close = viewer.getByRole('button', { name: 'Close tab ELI5: Why the plan matters' });
    await close.click();
    await expect(close).toHaveText('Delete?');
    await close.click();
    await expect(tabs).toHaveText(['In depth', 'ELI5'], { timeout: 30_000 });
    const html = await readFile(docFile(), 'utf8');
    expect(html).not.toContain(`data-tab-key="${added?.key ?? 'none'}"`);
    const after = await readJson<{ tabs: { kind: string }[]; retiredIds?: string[] }>(metaFile());
    expect(after.tabs.map((t) => t.kind)).toEqual(['indepth', 'eli5']);
    expect(after.retiredIds?.length ?? 0).toBeGreaterThan(0);
  });

  test('the same index.html opened as a plain file has no interactive menu (08 §2 item 6)', async () => {
    const url = pathToFileURL(docFile()).href;
    const errors: string[] = [];
    const opened = l.app.waitForEvent('window', (p) => p.url() === url);
    await l.app.evaluate(({ BrowserWindow }, u) => {
      // A plain window: default session, no preload, no eli5doc:// protocol.
      const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
      void w.loadURL(u);
    }, url);
    const plain = await opened;
    plain.on('pageerror', (e) => errors.push(e.message));
    await plain.waitForLoadState('load');
    await expect(plain.locator('nav.tabbar [role=tab]')).toHaveText(['In depth', 'ELI5']);

    // E8 replaced the forecast section; select in an untouched one.
    await plain.getByText('The plan balances two costs', { exact: false }).click({ clickCount: 3 });
    expect(await plain.evaluate(() => document.getSelection()?.toString().trim())).toContain('two costs');
    // The runtime still ran (tabs work) but installed no bridge, menu host or close controls.
    await plain.getByRole('tab', { name: 'ELI5' }).click();
    await expect(plain.getByRole('tab', { name: 'ELI5' })).toHaveAttribute('aria-selected', 'true');
    const state = await plain.evaluate(() => ({
      bridge: typeof (window as { eli5Doc?: unknown }).eli5Doc,
      // The menu host is a bare body-level div; the chart tooltip (.viz-tip) shares the marker.
      menuHost: document.querySelectorAll('body > div[data-eli5-noact]:not(.viz-tip)').length,
      visibleClose: Array.from(document.querySelectorAll<HTMLElement>('.tab-close')).filter((b) => !b.hidden).length,
      busy: document.querySelectorAll('[data-eli5-busy]').length,
    }));
    expect(state).toEqual({ bridge: 'undefined', menuHost: 0, visibleClose: 0, busy: 0 });
    expect(errors).toEqual([]);
    await plain.close();
  });
});

test('E11: a related document is suggested; one suggestion is dismissed, another merged in', async () => {
  const dirs = await h.tempDirs('eli5-e2e-m3-merge-');
  const first = await h.launch(dirs);
  const a = await generate(first);
  // No other document yet: no suggestion.
  await expect(first.win.getByText(/^Suggestions/)).toHaveCount(0);
  await h.close(first.app);

  // The fake judge now matches the first document (09 §10.2 step 7: score ≥ 0.75).
  const script = await writeScript(dirs, 'merge', {
    responses: { 'merge-match': { matches: [{ catalogId: a.id, score: 0.9, reason: 'Same widget supply plan' }] } },
  });
  const l = await h.launch(dirs, { script });
  const panel = l.win.getByRole('region', { name: /Suggestions/ });

  const b = await generate(l);
  await expect(panel.getByRole('heading')).toHaveText('Suggestions (1)', { timeout: 30_000 });
  await expect(panel.getByText('This looks related to')).toBeVisible();
  await expect(panel.getByText('Same widget supply plan')).toBeVisible();
  let list = await l.win.evaluate(() => window.eli5.suggestions.list());
  expect(list.ok && list.value.map((s) => [s.source.id, s.target.id, s.status])).toEqual([[b.id, a.id, 'pending']]);

  await panel.getByRole('button', { name: 'Keep separate' }).click();
  await expect(panel).toHaveCount(0);
  expect((await libraryEntries(l.win)).map((e) => e.id).sort()).toEqual([a.id, b.id].sort());

  const c = await generate(l);
  await expect(panel.getByRole('heading')).toHaveText('Suggestions (1)', { timeout: 30_000 });
  list = await l.win.evaluate(() => window.eli5.suggestions.list());
  const pending = list.ok ? list.value.filter((s) => s.status === 'pending') : [];
  expect(pending.map((s) => [s.source.id, s.target.id])).toEqual([[c.id, a.id]]);
  const targetBefore = await readFile(path.join(dirs.library, a.topicSlug, 'index.html'), 'utf8');

  await panel.getByRole('button', { name: 'Merge in' }).click();
  await expect(panel).toHaveCount(0, { timeout: 30_000 });
  // The standalone leaves the Library; the target gains a marked section (09 §10.3, §10.6).
  await expect.poll(async () => (await libraryEntries(l.win)).map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
  await expect(l.win.getByRole('navigation', { name: 'Library' }).getByRole('button', { name: /Widget/ })).toHaveCount(
    2,
  );
  const html = await readFile(path.join(dirs.library, a.topicSlug, 'index.html'), 'utf8');
  expect(html).not.toBe(targetBefore);
  expect(html).toMatch(/data-merge-marker="[^"]+"/);
  expect(html).toContain('Added from:');
  expect(validateDocument(html).errors).toEqual([]);
  await probeDocument(l.app, path.join(dirs.library, a.topicSlug, 'index.html'));
  await expect(stat(path.join(dirs.library, c.topicSlug))).rejects.toThrow();
  const meta = await readJson<{ merges?: unknown[]; mergedFromCount?: number }>(
    path.join(dirs.library, a.topicSlug, 'meta.json'),
  );
  expect(meta.merges).toHaveLength(1);
  await h.closeAll();
});

test('local publish writes the copy to publish.local.dir and the link actions work', async () => {
  const dirs = await h.tempDirs('eli5-e2e-m3-publish-');
  const exportDir = path.join(dirs.root, 'exports');
  const l = await h.launch(dirs);
  const set = await l.win.evaluate(
    (dir) => window.eli5.settings.set({ publish: { local: { dir, revealAfter: false } } }),
    exportDir,
  );
  expect(set).toEqual({ ok: true, value: expect.anything() });
  const doc = await generate(l);
  await openFromLibrary(l, doc.title);
  await expect(l.win.locator('.doc-header h1')).toHaveText(TITLE);

  // Link actions reach the OS through shell; record them instead of opening Finder or a browser.
  await l.app.evaluate(({ shell }) => {
    const calls: [string, string][] = [];
    (globalThis as { __shellCalls?: unknown }).__shellCalls = calls;
    const s = shell as unknown as Record<string, unknown>;
    s.openPath = (p: string) => (calls.push(['openPath', p]), Promise.resolve(''));
    s.openExternal = (u: string) => (calls.push(['openExternal', u]), Promise.resolve());
    s.showItemInFolder = (p: string) => void calls.push(['showItemInFolder', p]);
  });
  const shellCalls = () =>
    l.app.evaluate(() => (globalThis as { __shellCalls?: [string, string][] }).__shellCalls ?? []);

  await l.win.getByRole('button', { name: 'Export copy' }).click();
  const chip = l.win.getByRole('group', { name: 'Export copy result' });
  await expect(chip).toBeVisible({ timeout: 30_000 });

  const files = await readdir(exportDir, { recursive: true });
  const exported = files.filter((f) => f.endsWith('.html'));
  expect(exported.length).toBeGreaterThan(0);
  const exportedFile = path.join(exportDir, exported[0] ?? '');
  const copy = await readFile(exportedFile, 'utf8');
  expect(validateDocument(copy).errors).toEqual([]);
  await probeDocument(l.app, exportedFile);
  expect(copy).toContain(TITLE);
  // Settings asked for no reveal.
  expect(await shellCalls()).toEqual([]);

  await chip.getByRole('button', { name: 'Copy link' }).click();
  await expect(chip.getByText('Copied')).toBeVisible();
  const clip = await l.app.evaluate(({ clipboard }) => clipboard.readText());
  expect(clip.startsWith('file://')).toBe(true);
  const linked = decodeURIComponent(new URL(clip).pathname);
  expect(linked.startsWith(exportDir + path.sep)).toBe(true);

  await chip.getByRole('button', { name: 'Open', exact: true }).click();
  await chip.getByRole('button', { name: 'Show in Finder' }).click();
  await expect.poll(shellCalls).toHaveLength(2);
  const calls = await shellCalls();
  expect(calls.map(([k]) => k)).toEqual([expect.stringMatching(/^open(Path|External)$/), 'showItemInFolder']);
  for (const [, target] of calls) expect(target.replace(/^file:\/\//, '')).toContain(exportDir);
  await expect(l.win.locator('.doc-header [role=alert]')).toHaveCount(0);

  // The publication is recorded; "Last published" returns when the document is reopened.
  const meta = await readJson<{ publications?: { kind: string }[] }>(
    path.join(dirs.library, doc.topicSlug, 'meta.json'),
  );
  expect(meta.publications?.map((p) => p.kind)).toEqual(['local']);
  await h.closeAll();
});

test('E13/E15: settings persist across relaunch and the API key never reaches settings.json', async () => {
  const dirs = await h.tempDirs('eli5-e2e-m3-settings-');
  const first = await h.launch(dirs, { fake: false });
  const w = first.win;
  await w.getByRole('button', { name: 'Settings' }).click();
  await expect(w.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

  const glossary = w.getByRole('switch', { name: 'Explain domain specific terms by default' });
  await expect(glossary).toBeChecked();
  await glossary.uncheck();
  await w.getByRole('radio', { name: 'OpenAI' }).check();
  // The key panel follows the saved provider (debounced save, then eli5:settings:changed).
  await expect(w.getByPlaceholder('OpenAI API key')).toBeVisible();
  await expect(w.getByTestId('key-state')).toHaveText('No key');
  const model = w.getByRole('combobox', { name: 'Model' });
  await model.fill('gpt-test-model');
  // A runtime-assembled key for the selected provider, saved through the form (12 §5.2).
  const key = TEST_KEY.replace('sk-test', 'sk-proj-test');
  await w.getByLabel('API key', { exact: true }).fill(key);
  await w.getByRole('button', { name: 'Save key' }).click();
  await expect(w.getByTestId('key-state')).toHaveText('Key saved in Keychain');
  await expect(w.getByLabel('API key', { exact: true })).toHaveValue('');

  const settingsFile = path.join(dirs.userData, 'settings.json');
  await expect
    .poll(async () => {
      const s = await readJson<{ llm?: { provider?: string; model?: string }; glossary?: { defaultOn?: boolean } }>(
        settingsFile,
      ).catch(() => null);
      return [s?.llm?.provider, s?.llm?.model, s?.glossary?.defaultOn];
    })
    .toEqual(['openai', 'gpt-test-model', false]);
  expect(await w.evaluate(() => window.eli5.settings.hasApiKey('openai'))).toEqual({ ok: true, value: true });
  await h.close(first.app);

  // Nothing under userData holds the key: it lived only in the (memory) key store.
  for (const f of await readdir(dirs.userData, { recursive: true })) {
    const full = path.join(dirs.userData, f);
    if (!(await stat(full)).isFile()) continue;
    expect((await readFile(full)).includes(key), f).toBe(false);
  }

  const second = await h.launch(dirs, { fake: false });
  await second.win.getByRole('button', { name: 'Settings' }).click();
  await expect(second.win.getByRole('switch', { name: 'Explain domain specific terms by default' })).not.toBeChecked();
  await expect(second.win.getByRole('radio', { name: 'OpenAI' })).toBeChecked();
  await expect(second.win.getByRole('combobox', { name: 'Model' })).toHaveValue('gpt-test-model');
  const s = await second.win.evaluate(() => window.eli5.settings.get());
  expect(s.ok && [s.value.llm.provider, s.value.llm.model, s.value.glossary.defaultOn]).toEqual([
    'openai',
    'gpt-test-model',
    false,
  ]);
  await h.closeAll();
});

test('E14: the public build shows no enterprise UI', async () => {
  const dirs = await h.tempDirs('eli5-e2e-m3-public-');
  const l = await h.launch(dirs);
  const info = await l.win.evaluate(() => window.eli5.edition.info());
  expect(info).toMatchObject({ ok: true, value: { edition: 'public', overlayLoaded: false, uiFeatures: [] } });

  const doc = await generate(l);
  await openFromLibrary(l, doc.title);
  await expect(l.win.locator('.doc-header h1')).toHaveText(TITLE);
  // Only the local export in the publish slot; no remote targets, no sign-in state (HOOK-UI-01).
  await expect(l.win.locator('.publish-controls button')).toHaveText(['Export copy']);
  await expect(l.win.getByRole('button', { name: /sign in|signed in/i })).toHaveCount(0);

  await l.win.getByRole('button', { name: 'Settings' }).click();
  await expect(l.win.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(l.win.getByRole('heading', { name: 'Enterprise' })).toHaveCount(0);
  await expect(l.win.locator('.sign-in')).toHaveCount(0);
  await expect(l.win.getByRole('radio', { name: 'Bedrock' })).toHaveCount(0);
  // No remote publisher is available, so the published-link click action stays disabled (11 §7).
  await expect(l.win.getByRole('radio', { name: 'Open its published link in my browser' })).toBeDisabled();
  await expect(l.win.getByRole('combobox', { name: 'Which published link' })).toBeDisabled();
  await h.closeAll();
});
