import { expect, test, type Page } from '@playwright/test';
import {
  Harness,
  TITLE,
  docPath,
  dropFiles,
  startDraft,
  fakeCalls,
  jobLine,
  jobText,
  libraryEntries,
  probeDocument,
  statusLines,
  writeScript,
} from './harness';

/**
 * Jobs and the status area end to end (13 §8.2 E6, E7; 06 §6, §7.3; 11 §5.5): the pipeline's
 * status line strings, an injected auth failure with its Settings link, Retry after a failure,
 * Dismiss, and a second and third job queued behind a running one. FakeProvider only; needs a test
 * build (ELI5_TEST_BUILD=1, `npm run test:e2e`).
 */

test.describe.configure({ mode: 'serial' });

const h = new Harness();
test.afterAll(() => h.cleanup());
// PRD: no modals during ingest and generation (13 §8.1 modal guard).
test.afterEach(() => h.closeAll());

const lines = (win: Page) => win.locator('.job-line');

async function startWith(win: Page, rel: string): Promise<void> {
  await dropFiles(win, [rel]);
  await startDraft(win);
}

test('E6: an auth error on the in-depth call fails the job with the Settings hint; nothing is saved', async () => {
  const dirs = await h.tempDirs('eli5-e2e-jobs-auth-');
  const script = await writeScript(dirs, 'auth', { errors: { 'in-depth': 'auth' } });
  const l = await h.launch(dirs, { script });
  await startWith(l.win, 'text/notes.md');

  await expect(jobText(l.win)).toHaveText('Failed: API key rejected. Check Settings', { timeout: 30_000 });
  await expect(jobLine(l.win)).toHaveAttribute('data-status', 'failed');
  expect(await libraryEntries(l.win)).toEqual([]);
  // A failed line offers Retry and Dismiss, never Cancel (06 §6, 11 §5.5).
  await expect(jobLine(l.win).getByRole('button')).toHaveText(['Settings', 'Retry', 'Dismiss']);
  // "Settings" in an LLM_AUTH line is a link to the Settings screen (11 §5.5).
  await jobLine(l.win).getByRole('button', { name: 'Settings' }).click();
  await expect(l.win.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

  await jobLine(l.win).getByRole('button', { name: 'Dismiss' }).click();
  await expect(lines(l.win)).toHaveCount(0);
  const jobs = await l.win.evaluate(() => window.eli5.jobs.list());
  expect(jobs.ok && jobs.value.map((j) => j.status)).toEqual([]);
});

test('Retry after a failure runs the same job again and finishes it', async () => {
  const dirs = await h.tempDirs('eli5-e2e-jobs-retry-');
  // The first in-depth call fails; the retried call succeeds (FakeScript errors per call index).
  const script = await writeScript(dirs, 'retry', { errors: { 'in-depth': ['auth'] } });
  const l = await h.launch(dirs, { script });
  await startWith(l.win, 'text/notes.md');
  await expect(jobText(l.win)).toHaveText(/^Failed: /, { timeout: 30_000 });
  const failed = await l.win.evaluate(() => window.eli5.jobs.list());
  const id = failed.ok ? failed.value[0]?.id : undefined;

  await jobLine(l.win).getByRole('button', { name: 'Retry' }).click();
  await expect(jobText(l.win)).toHaveText(`Done: ${TITLE}`, { timeout: 30_000 });
  // One line, one job: the same id moved failed -> queued -> done (06 §7.3).
  await expect(lines(l.win)).toHaveCount(1);
  const after = await l.win.evaluate(() => window.eli5.jobs.list());
  expect(after.ok && after.value.map((j) => [j.id, j.status])).toEqual([[id, 'done']]);
  expect((await fakeCalls(l.app)).filter((c) => c.taskId === 'in-depth')).toHaveLength(2);
  const listed = await libraryEntries(l.win);
  expect(listed.map((e) => e.title)).toEqual([TITLE]);
  const [entry] = listed;
  await probeDocument(l.app, await docPath(l.win, entry?.topicSlug ?? ''));

  // A done line opens its document on click and can be dismissed (11 §5.5).
  await jobText(l.win).click();
  await expect(l.win.locator('.doc-header h1')).toHaveText(TITLE);
  await jobLine(l.win).getByRole('button', { name: 'Dismiss' }).click();
  await expect(lines(l.win)).toHaveCount(0);
});

test('E7: jobs started while one runs wait as Queued, then all finish; the Library lists newest first', async () => {
  const dirs = await h.tempDirs('eli5-e2e-jobs-queue-');
  const script = await writeScript(dirs, 'queue', { latencyMs: 1_200 });
  const l = await h.launch(dirs, { script });

  await startWith(l.win, 'text/notes.md');
  await expect(lines(l.win).nth(0).locator('.job-text')).toHaveText(/^(Reading sources|Extracting|Generating)/, {
    timeout: 30_000,
  });
  await startWith(l.win, 'text/plain.txt');
  await expect(lines(l.win)).toHaveCount(2);
  await expect(lines(l.win).nth(1).locator('.job-text')).toHaveText('Queued');
  await startWith(l.win, 'text/sales.csv');
  await expect(lines(l.win)).toHaveCount(3);
  await expect(lines(l.win).nth(2).locator('.job-text')).toHaveText('Queued (2 ahead)');
  // Queued lines can be cancelled but not retried (06 §6).
  await expect(lines(l.win).nth(2).getByRole('button')).toHaveText(['Cancel']);

  for (let i = 0; i < 3; i++) {
    await expect(lines(l.win).nth(i).locator('.job-text')).toHaveText(`Done: ${TITLE}`, { timeout: 60_000 });
  }
  const jobs = await l.win.evaluate(() => window.eli5.jobs.list());
  const byCreated = jobs.ok ? [...jobs.value].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [];
  const slugs = byCreated.map((j) => j.result?.topicSlug);
  // Newest first by createdAt (11 §5.2): the last job's document heads the Library.
  const entries = await libraryEntries(l.win);
  expect(entries.map((e) => e.topicSlug)).toEqual([...slugs].reverse());
  const nav = l.win.getByRole('navigation', { name: 'Library' });
  await expect(nav.getByRole('button', { name: new RegExp(TITLE) })).toHaveCount(3);
  for (const e of entries) await probeDocument(l.app, await docPath(l.win, e.topicSlug));

  // Every line the pipeline produced is one of the 06 §6 strings.
  const known = [
    /^Queued$/,
    /^Queued \(\d+ ahead\)$/,
    /^Reading sources$/,
    /^Extracting content$/,
    // The bare PRD wording shows while the stage starts, before a step is running.
    /^Generating document( \((in-depth and ELI5|in-depth explainer|ELI5 version|glossary notes|finishing up)\))?$/,
    /^Saving$/,
    new RegExp(`^Done: ${TITLE}$`),
  ];
  const seen = [...new Set(await statusLines(l.win))];
  expect(seen.filter((s) => !known.some((re) => re.test(s)))).toEqual([]);
  // ...and the recorder really saw the run: an empty capture must not pass the check above.
  expect(seen).toEqual(
    expect.arrayContaining(['Queued', 'Queued (2 ahead)', 'Reading sources', 'Saving', `Done: ${TITLE}`]),
  );
  expect(seen.some((s) => s.startsWith('Generating document'))).toBe(true);
});
