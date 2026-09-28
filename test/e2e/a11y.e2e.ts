import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  Harness,
  dropFiles,
  generate,
  startDraft,
  jobText,
  openFromLibrary,
  writeScript,
  type Launched,
} from './harness';

/**
 * Accessibility of the app UI (13 §10 "Accessibility", 11 §12): axe-core reports zero serious or
 * critical violations on the Library, input zone, status area, suggestions and Settings, in light
 * and dark themes. The document inside the viewer is a separate surface and not scanned here.
 * FakeProvider only; needs a test build (ELI5_TEST_BUILD=1, `npm run test:e2e`).
 */

test.describe.configure({ mode: 'serial' });

const h = new Harness();
test.afterAll(() => h.cleanup());

interface Finding {
  id: string;
  impact: string | null | undefined;
  targets: string[];
  help: string;
}

/** Serious and critical axe findings for the app renderer as it is right now. */
async function blocking(win: Page): Promise<Finding[]> {
  // Legacy mode runs in the page itself: Electron cannot open the extra page axe uses otherwise.
  const r = await new AxeBuilder({ page: win }).setLegacyMode(true).analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.map((n) => n.target.join(' ')) }));
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

async function scanBothThemes(l: Launched, screen: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(l, theme);
    await expect
      .poll(() => l.win.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
      .toBe(theme === 'dark');
    expect(await blocking(l.win), `${screen} (${theme})`).toEqual([]);
  }
  await setTheme(l, 'system');
}

let l: Launched;

test.beforeAll(async () => {
  const dirs = await h.tempDirs('eli5-e2e-a11y-');
  // The first document leads a later one to a merge suggestion (09 §10.2); the first in-depth call
  // of the second launch fails, so a failed line with its Settings link is on screen too.
  const first = await h.launch(dirs);
  const a = await generate(first);
  await h.close(first.app);
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
  await openFromLibrary(l.win, b.title);
  await expect(l.win.locator('.doc-header h1')).toBeVisible();
  // The first launch's done line is still listed (06 §6: done lines stay 10 minutes).
  await expect(l.win.locator('.job-line[data-status="failed"]')).toHaveCount(1);
  await expect(l.win.locator('.job-line[data-status="done"]')).toHaveCount(2);
  await scanBothThemes(l, 'document view');
});

test('Settings, every section', async () => {
  // The sidebar gear (the failed job line also has a "Settings" link).
  await l.win
    .getByRole('button', { name: /^⚙?\s*Settings$/ })
    .first()
    .click();
  await expect(l.win.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await scanBothThemes(l, 'settings');
  await h.closeAll();
});
