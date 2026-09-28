import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { validateDocument } from '../helpers/doc-validity';
import type { FixtureServer } from '../helpers/fixture-server';
import {
  Harness,
  TITLE,
  addUrl,
  dropFiles,
  jobLine,
  jobText,
  libraryEntries,
  statusLines,
  viewerUrl,
  writeScript,
  type Dirs,
  type Launched,
} from './harness';

/**
 * M2 end-to-end (13 §8.2): create jobs through the real input zone with the FakeProvider, watch the
 * pipeline's status lines, and check the Library, the viewer and the saved file. Covers E1, E3
 * (article), E4, the no-key block, cancellation, crash-resume (06 §9.4) and close-to-hide while a
 * job runs (11 §3). Requires a test build (ELI5_TEST_BUILD=1, `npm run test:e2e`).
 */

// The fixture server registers its port with net-guard, which would also block Playwright's own
// loopback connection to Electron; the guard stays off in this runner process.
process.env.ELI5_ALLOW_NET = '1';
const { startFixtureServer } = await import('../helpers/fixture-server');

test.describe.configure({ mode: 'serial' });

let server: FixtureServer;
const h = new Harness();

test.beforeAll(async () => {
  server = await startFixtureServer();
  h.fixtureOrigin = server.origin;
});

test.afterAll(async () => {
  await h.cleanup();
  await server?.close();
});

// PRD: no modals during ingest and generation (13 §8.1 modal guard).
test.afterEach(() => h.closeAll());

const tempDirs = (): Promise<Dirs> => h.tempDirs('eli5-e2e-gen-');
const launch = (dirs: Dirs, opts: { fake?: boolean; script?: string } = {}): Promise<Launched> => h.launch(dirs, opts);
/** A copy of the default fake script with added latency, so a job stays in flight long enough. */
const slowScript = (dirs: Dirs, latencyMs: number): Promise<string> =>
  writeScript(dirs, `slow-${String(latencyMs)}`, { latencyMs });

/** The finished document: in the Library, opens in the viewer, and the saved file is valid (07, 13 §7). */
async function expectDocument(l: Launched, dirs: Dirs): Promise<string> {
  const entries = await libraryEntries(l.win);
  expect(entries[0]?.title).toBe(TITLE);
  const slug = entries[0]?.topicSlug ?? '';
  const nav = l.win.getByRole('navigation', { name: 'Library' });
  await nav.getByRole('button', { name: new RegExp(TITLE) }).click();
  await expect.poll(() => viewerUrl(l.app)).toBe(`eli5doc://doc/${slug}/index.html`);

  await access(path.join(dirs.library, 'catalog.json'));
  const meta = JSON.parse(await readFile(path.join(dirs.library, slug, 'meta.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const html = await readFile(path.join(dirs.library, slug, 'index.html'), 'utf8');
  const report = validateDocument(html);
  expect(report.errors).toEqual([]);
  expect(report.ok).toBe(true);
  expect(meta.title).toBe(TITLE);
  return slug;
}

test('E1: a dropped deck progresses through every status line to Done and opens in the viewer', async () => {
  const dirs = await tempDirs();
  const l = await launch(dirs);
  await dropFiles(l.win, ['pptx/quarterly-review.pptx']);
  await l.win.getByRole('button', { name: 'Start' }).click();

  await expect(jobText(l.win)).toHaveText(new RegExp(`Done: ${TITLE}`), { timeout: 30_000 });
  const lines = await statusLines(l.win);
  const order = ['Reading sources', 'Extracting content', 'Generating document', 'Saving', `Done: ${TITLE}`];
  const firstIndex = order.map((o) => lines.findIndex((s) => s.startsWith(o)));
  expect(
    firstIndex.every((i) => i >= 0),
    `status lines: ${lines.join(' | ')}`,
  ).toBe(true);
  expect([...firstIndex].sort((a, b) => a - b)).toEqual(firstIndex);
  // In-depth and ELI5 may run together (06 §5.4 rule 4).
  expect(lines.some((s) => /^Generating document \(in-depth/.test(s))).toBe(true);

  await expectDocument(l, dirs);
  // The draft is cleared once a job starts (11 §5.4).
  await expect(l.win.getByRole('list', { name: 'Added sources' })).toHaveCount(0);
});

test('E2: a dropped image reaches the model through the hidden render window (04 §6.3, §7.1)', async () => {
  const dirs = await tempDirs();
  const l = await launch(dirs);
  await dropFiles(l.win, ['images/diagram.png']);
  await l.win.getByLabel('Specifics').fill('Explain the diagram');
  await l.win.getByRole('button', { name: 'Start' }).click();
  // Nothing skipped: the image was normalized, not dropped as unreadable.
  await expect(jobText(l.win)).toHaveText(`Done: ${TITLE}`, { timeout: 30_000 });
  await expectDocument(l, dirs);
});

test('E3: a URL served by the fixture server becomes a document', async () => {
  const dirs = await tempDirs();
  const l = await launch(dirs);
  await addUrl(l.win, server.url('/article/'));
  await expect(l.win.getByRole('list', { name: 'Added sources' })).toBeVisible();
  await l.win.getByRole('button', { name: 'Start' }).click();
  await expect(jobText(l.win)).toHaveText(new RegExp(`Done: ${TITLE}$`), { timeout: 30_000 });
  expect(server.hits.some((h) => h.path === '/article/')).toBe(true);
  await expectDocument(l, dirs);
});

test('E4: a partial failure finishes with the skipped count and lists the skipped URL', async () => {
  const dirs = await tempDirs();
  const l = await launch(dirs);
  await dropFiles(l.win, ['docx/policy-memo.docx']);
  await addUrl(l.win, server.url('/login-wall/'));
  await l.win.getByRole('button', { name: 'Start' }).click();
  await expect(jobText(l.win)).toHaveText(new RegExp(`Done: ${TITLE} · 1 source\\(s\\) skipped`), {
    timeout: 30_000,
  });
  const slug = await expectDocument(l, dirs);
  const html = await readFile(path.join(dirs.library, slug, 'index.html'), 'utf8');
  expect(html).toContain(server.url('/login-wall/'));
});

test('E5: only an unsupported file fails with no usable content and adds nothing to the Library', async () => {
  const dirs = await tempDirs();
  const l = await launch(dirs);
  await dropFiles(l.win, ['unsupported/memo.rtf']);
  await l.win.getByRole('button', { name: 'Start' }).click();
  await expect(jobText(l.win)).toHaveText(/Failed: no usable content in 1 source\(s\)/, { timeout: 30_000 });
  expect(await libraryEntries(l.win)).toEqual([]);
});

test('without an API key the start is blocked inline and no job is created', async () => {
  const dirs = await tempDirs();
  const l = await launch(dirs, { fake: false });
  await dropFiles(l.win, ['text/notes.md']);
  await l.win.getByRole('button', { name: 'Start' }).click();
  await expect(l.win.getByText('Add an API key in Settings to start')).toBeVisible();
  await expect(l.win.getByRole('list', { name: 'Added sources' }).getByText('notes.md')).toBeVisible();
  const jobs = await l.win.evaluate(() => window.eli5.jobs.list());
  expect(jobs).toMatchObject({ ok: true, value: [] });
  await expect(l.win.locator('.job-line')).toHaveCount(0);
});

test('Cancel stops a running job; nothing is saved', async () => {
  const dirs = await tempDirs();
  const l = await launch(dirs, { script: await slowScript(dirs, 4_000) });
  await dropFiles(l.win, ['text/notes.md']);
  await l.win.getByRole('button', { name: 'Start' }).click();
  await expect(jobText(l.win)).toHaveText(/Generating document/, { timeout: 30_000 });
  await jobLine(l.win).getByRole('button', { name: 'Cancel' }).click();
  await expect(jobText(l.win)).toHaveText(/Cancelled/);
  await expect(jobLine(l.win)).toHaveAttribute('data-status', 'failed');
  expect(await libraryEntries(l.win)).toEqual([]);
});

test('crash-resume: a job killed mid-generation resumes on relaunch and finishes', async () => {
  const dirs = await tempDirs();
  const first = await launch(dirs, { script: await slowScript(dirs, 5_000) });
  await dropFiles(first.win, ['text/notes.md']);
  await first.win.getByRole('button', { name: 'Start' }).click();
  await expect(jobText(first.win)).toHaveText(/Generating document/, { timeout: 30_000 });
  const before = await first.win.evaluate(() => window.eli5.jobs.list());
  const jobId = before.ok ? before.value[0]?.id : undefined;
  expect(jobId).toBeTruthy();

  // Hard kill: no before-quit, no queue flush beyond what was persisted as the job ran.
  const exited = first.app.waitForEvent('close');
  first.app.process().kill('SIGKILL');
  await exited;
  h.running.splice(h.running.indexOf(first.app), 1);

  const second = await launch(dirs);
  await expect(jobText(second.win)).toHaveText(new RegExp(`Done: ${TITLE}`), { timeout: 30_000 });
  const after = await second.win.evaluate(() => window.eli5.jobs.list());
  expect(after.ok && after.value.find((j) => j.id === jobId)?.status).toBe('done');
  await expectDocument(second, dirs);
});

test('closing the window keeps a running job going; it is Done when the window returns', async () => {
  const dirs = await tempDirs();
  const l = await launch(dirs, { script: await slowScript(dirs, 1_500) });
  await dropFiles(l.win, ['text/notes.md']);
  await l.win.getByRole('button', { name: 'Start' }).click();
  await expect(jobText(l.win)).toHaveText(/Reading sources|Extracting content|Generating document/);
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  expect(await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false);

  // The job keeps running in main with the window hidden (11 §3).
  await expect
    .poll(
      async () => {
        const r = await l.win.evaluate(() => window.eli5.jobs.list());
        return r.ok ? r.value[0]?.status : undefined;
      },
      { timeout: 30_000 },
    )
    .toBe('done');
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.show());
  await expect(jobText(l.win)).toHaveText(new RegExp(`Done: ${TITLE}`));
  await expectDocument(l, dirs);
});
