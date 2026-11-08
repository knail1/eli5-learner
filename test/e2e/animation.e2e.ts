import { readFile } from 'node:fs/promises';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { validateDocument } from '../helpers/doc-validity';
import { PACKING_ANIMATION } from '../fixtures/documents/animation';
import {
  DEFAULT_SCRIPT,
  Harness,
  TITLE,
  docPath,
  generate,
  openFromLibrary,
  spyShell,
  viewerUrl,
  writeScript,
  type Launched,
} from './harness';

/**
 * Animation frames in the app viewer (07 §7.1, 12 §7.2): a generated document with an AI-written
 * animation (FakeProvider only) saves valid, its sandboxed srcdoc frame loads in the viewer (the
 * one subframe navigation the viewer allows), runs under the viewer's header CSP plus the
 * document's meta CSP, and cannot navigate anywhere or reach the app's bridge. Requires a test
 * build (ELI5_TEST_BUILD=1, `npm run test:e2e`).
 */

test.describe.configure({ mode: 'serial' });

const h = new Harness();
test.afterAll(() => h.cleanup());
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

/** The packing animation (the default script's In depth draft also has its own safety-stock one). */
const PACKING_FIG = '#tab-indepth figure.animation:has-text("One packer short")';

test.describe('a document with an animation', () => {
  let l: Launched;
  let viewer: Page;
  let shellCalls: () => Promise<[string, string][]>;

  test.beforeAll(async () => {
    const dirs = await h.tempDirs('eli5-e2e-anim-');
    const base = JSON.parse(await readFile(DEFAULT_SCRIPT, 'utf8')) as {
      responses: { 'in-depth': { sections: { blocks: unknown[] }[] } };
    };
    const indepth = structuredClone(base.responses['in-depth']);
    indepth.sections[0]?.blocks.push(PACKING_ANIMATION);
    const script = await writeScript(dirs, 'animation', { responses: { 'in-depth': indepth } });
    l = await h.launch(dirs, { script });
    shellCalls = await spyShell(l.app);
    const entry = await generate(l);
    const html = await readFile(await docPath(l.win, entry.topicSlug), 'utf8');
    expect(html).toContain('<iframe sandbox="allow-scripts" srcdoc="');
    expect(validateDocument(html).errors).toEqual([]);
    await openFromLibrary(l.win, TITLE);
    viewer = await viewerPage(l.app, entry.topicSlug);
  });

  test.afterAll(() => h.closeAll());

  test('the frame loads in the viewer, reports its height and runs its controls', async () => {
    const fig = viewer.locator(PACKING_FIG);
    await fig.scrollIntoViewIfNeeded();
    await expect(fig).toHaveClass(/\banim-live\b/, { timeout: 15_000 });
    const frame = viewer.frameLocator(`${PACKING_FIG} iframe`);
    const slider = frame.getByRole('slider', { name: 'Packers on shift' });
    await slider.fill('1');
    await expect(slider).toHaveAttribute('aria-valuetext', 'Packers on shift 1');
    await expect(frame.locator('.eli5-readout strong')).toHaveText(/^\d+$/, { timeout: 10_000 });
    // The bridge lives only in the document, never in its frames (no preload in subframes).
    expect(await frame.locator('body').evaluate(() => typeof (window as { eli5Doc?: unknown }).eli5Doc)).toBe(
      'undefined',
    );
  });

  test('the frame cannot navigate itself or the viewer, and opens nothing', async () => {
    const frame = viewer.frameLocator(`${PACKING_FIG} iframe`);
    const body = frame.locator('body');
    const topNav = await body.evaluate(() => {
      try {
        (top as Window).location.href = 'https://leak.example/top';
        return 'navigated';
      } catch {
        return 'blocked';
      }
    });
    expect(topNav).toBe('blocked');
    await body.evaluate(() => {
      location.href = 'https://leak.example/self';
    });
    await viewer.waitForTimeout(500);
    expect(viewer.url()).toMatch(/^eli5doc:\/\/doc\//);
    for (const f of viewer.frames()) expect(f.url()).not.toMatch(/^https?:/);
    expect(await shellCalls()).toEqual([]);
  });
});
