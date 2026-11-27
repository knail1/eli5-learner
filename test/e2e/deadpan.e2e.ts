import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { validateDocument } from '../helpers/doc-validity';
import {
  Harness,
  TITLE,
  docPath,
  dropFiles,
  fakeCalls,
  jobText,
  libraryEntries,
  openFromLibrary,
  probeDocument,
  startDraft,
  statusLines,
  viewerUrl,
  type Launched,
} from './harness';

/**
 * The optional Deadpan tab end to end (07 §3, 06 step 1c, 11 §5.4): the per-job "Deadpan tab"
 * switch next to Start sends `options.deadpan`, the pipeline runs one more model call after the
 * ASD-STE100 step, and the saved document shows a fourth tab, Deadpan, after ASD-STE100. A job
 * started with the switch off makes no deadpan call and has no such tab. FakeProvider only;
 * requires a test build (ELI5_TEST_BUILD=1, `npm run test:e2e`).
 */

test.describe.configure({ mode: 'serial' });

const h = new Harness();
test.afterAll(() => h.cleanup());
// No modals during generation (13 §8.1 modal guard).
test.afterEach(() => h.assertNoModals());

async function viewerPage(app: ElectronApplication, slug: string): Promise<Page> {
  const url = `eli5doc://doc/${slug}/index.html`;
  await expect.poll(() => viewerUrl(app)).toBe(url);
  await expect.poll(() => app.windows().some((p) => p.url() === url)).toBe(true);
  const page = app.windows().find((p) => p.url() === url);
  if (!page) throw new Error('viewer page not found');
  await page.waitForLoadState('domcontentloaded');
  return page;
}

/** Drops one source, starts it as one job and waits for the new Library entry and its Done line. */
async function runJob(l: Launched): Promise<{ topicSlug: string }> {
  const before = new Set((await libraryEntries(l.win)).map((e) => e.id));
  await dropFiles(l.win, ['text/notes.md']);
  await startDraft(l.win);
  await expect
    .poll(async () => (await libraryEntries(l.win)).filter((e) => !before.has(e.id)).length, { timeout: 30_000 })
    .toBe(1);
  const entry = (await libraryEntries(l.win)).find((e) => !before.has(e.id));
  if (!entry) throw new Error('no new Library entry');
  await expect(jobText(l.win)).toHaveText(/^Done: /);
  return entry;
}

const deadpanCalls = async (app: ElectronApplication): Promise<number> =>
  (await fakeCalls(app)).filter((c) => c.taskId === 'deadpan').length;

test.describe('the Deadpan tab switch', () => {
  let l: Launched;

  test.beforeAll(async () => {
    const dirs = await h.tempDirs('eli5-e2e-deadpan-');
    l = await h.launch(dirs);
  });

  test.afterAll(() => h.closeAll());

  test('off by default: no deadpan call and three tabs', async () => {
    const toggle = l.win.getByRole('switch', { name: 'Deadpan tab' });
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    const entry = await runJob(l);
    expect(await deadpanCalls(l.app)).toBe(0);
    const report = await probeDocument(l.app, await docPath(l.win, entry.topicSlug));
    expect(report.tabs).toEqual(['indepth', 'eli5', 'ste']);
  });

  test('ticked: the job writes a Deadpan tab after ASD-STE100', async () => {
    const toggle = l.win.getByRole('switch', { name: 'Deadpan tab' });
    await toggle.check();
    await expect(toggle).toBeChecked();
    const entry = await runJob(l);

    expect(await deadpanCalls(l.app)).toBe(1);
    expect(await statusLines(l.win)).toContain('Generating document (Deadpan version)');

    const file = await docPath(l.win, entry.topicSlug);
    const html = await readFile(file, 'utf8');
    expect(validateDocument(html).errors).toEqual([]);
    const report = await probeDocument(l.app, file);
    expect(report.tabs).toEqual(['indepth', 'eli5', 'ste', 'deadpan']);
    const meta = JSON.parse(await readFile(path.join(path.dirname(file), 'meta.json'), 'utf8')) as {
      tabs: { key: string; kind: string }[];
    };
    expect(meta.tabs.map((t) => t.kind)).toEqual(['indepth', 'eli5', 'ste', 'deadpan']);

    // The viewer shows the fourth tab, and its sections carry stable sec-deadpan-* ids.
    await openFromLibrary(l.win, TITLE);
    const viewer = await viewerPage(l.app, entry.topicSlug);
    const tabs = viewer.locator('nav.tabbar [role=tab]');
    await expect(tabs).toHaveText(['In depth', 'ELI5', 'ASD-STE100', 'Deadpan']);
    await viewer.getByRole('tab', { name: 'Deadpan' }).click();
    await expect(viewer.getByRole('tab', { name: 'Deadpan' })).toHaveAttribute('aria-selected', 'true');
    const ids = await viewer.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>('.tabpanel[data-tab-key="deadpan"] section[data-section-id]'),
      ).map((s) => s.id),
    );
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^sec-deadpan-[0-9a-f]{8}$/);
  });
});
