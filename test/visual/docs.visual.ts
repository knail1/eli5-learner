/**
 * Visual regression of the golden documents (13 §7.4): each committed golden opened via file:// in
 * Chromium and WebKit (the projects), light and dark, compared pixel by pixel with the committed
 * baselines under __screenshots__/. Component and region shots, not whole pages, so a diff points
 * at the component and the baselines stay small. Deterministic by construction: fixed viewport and
 * 2x pixels, reduced motion, animations off, caret hidden, a fixed clock, seeded section ids (the
 * goldens), fonts loaded, the mouse parked in a corner, every request other than the file aborted.
 */
import { expect, test, type Page } from '@playwright/test';
import { GOLDENS } from '../crossbrowser/goldens';
import { expectRegion, settle } from './shots';

const NOW = new Date('2026-09-28T12:00:00.000Z');
const NARROW = { width: 420, height: 800 };

const url = (name: string): string => {
  const g = GOLDENS.find((x) => x.name === name);
  if (!g) throw new Error(`golden ${name} missing`);
  return g.url;
};

/**
 * In-app stand-in for the viewer bridge (07 §6.3), for the shots of in-app states only (the
 * selection menu, a section being updated). Every call resolves at once; nothing leaves the page.
 * The menu lives in a closed shadow root; opening it lets the locators reach it.
 */
async function stubBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      return attach.call(this, { ...init, mode: 'open' });
    };
    const ok = () => Promise.resolve({ ok: true });
    const w = window as unknown as { eli5Doc: unknown; __busy?: (e: unknown) => void };
    w.eli5Doc = {
      regenerateSection: ok,
      createSectionEli5: ok,
      closeTab: ok,
      openExternal: ok,
      onScrollTo: () => () => {},
      onSectionBusy: (cb: (e: unknown) => void) => {
        w.__busy = cb;
        return () => {};
      },
    };
  });
}

async function open(page: Page, name: string, opts: { bridge?: boolean } = {}): Promise<void> {
  const docUrl = url(name);
  // 13 §7.2: nothing but the document itself (and data: URIs) may load.
  await page.context().route('**/*', (route) => {
    const u = route.request().url();
    return u === docUrl || u.startsWith('data:') ? route.continue() : route.abort('blockedbyclient');
  });
  await page.clock.setFixedTime(NOW);
  if (opts.bridge) await stubBridge(page);
  await page.goto(docUrl, { waitUntil: 'load' });
  await expect(page.locator('html')).toHaveClass(/\bjs\b/);
  await page.mouse.move(0, 0);
  await settle(page);
}

const tab = (page: Page, key: string) => page.locator(`#tab-${key}`);
const section = (page: Page, key: string, n: number) => tab(page, key).locator(':scope > section').nth(n);
/** The header's content column and the tab buttons (not the full-bleed bars around them). */
const header = (page: Page) => [
  page.locator('header.doc-head > *:not([hidden])'),
  page.locator('nav.tabbar [role="tab"]'),
];
const refs = (page: Page) => page.locator('#tab-indepth section[data-kind="references"]');

async function showTab(page: Page, key: string): Promise<void> {
  await page.locator(`#tabbtn-${key}`).click();
  await expect(page.locator(`#tabbtn-${key}`)).toHaveAttribute('aria-selected', 'true');
  await page.mouse.move(0, 0);
  await settle(page);
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(theme, () => {
    test.use({ colorScheme: theme });
    // Dark tokens are the same CSS in both engines; WebKit covers light only, which keeps the
    // baselines small while still catching its font and layout differences (13 §7.4).
    test.skip(({ browserName }) => browserName === 'webkit' && theme === 'dark', 'dark: Chromium only');
    const shot = (name: string) => `${name}-${theme}.png`;

    test('header and tab bar', async ({ page }) => {
      await open(page, 'full');
      await expectRegion(page, shot('full-header'), header(page));
      await open(page, 'themed');
      await expectRegion(page, shot('themed-header'), header(page));
    });

    test('In depth: first section with glossary margin notes', async ({ page }) => {
      await open(page, 'full');
      await expect(page.locator('html')).toHaveClass(/\bgl-wide\b/);
      const first = section(page, 'indepth', 0);
      await expectRegion(page, shot('full-indepth-glossary'), [
        first.locator(':scope > h2'),
        first.locator(':scope > p'),
        first.locator(':scope > ul'),
        first.locator('details.gl-note'),
      ]);
    });

    test('pull quote and callouts', async ({ page }) => {
      await open(page, 'full');
      const first = section(page, 'indepth', 0);
      await expectRegion(page, shot('full-pullquote-keypoint'), [
        first.locator('figure.pullquote'),
        first.locator('aside.callout'),
      ]);
      const third = section(page, 'indepth', 2);
      await expectRegion(page, shot('full-analogy-callouts'), [
        third.locator('.analogy'),
        third.locator('aside.callout'),
        third.locator('details.gl-note'),
      ]);
    });

    test('charts', async ({ page }) => {
      await open(page, 'full');
      const charts = page.locator('#tab-indepth figure.chart');
      const kinds = await charts.evaluateAll((els) => els.map((e) => e.getAttribute('data-chart-kind') ?? 'chart'));
      expect(kinds).toEqual(['bar', 'line', 'area', 'stacked-bar', 'pie', 'scatter']);
      for (const [i, kind] of kinds.entries()) {
        await expect(charts.nth(i)).toHaveScreenshot(shot(`full-chart-${kind}`));
      }
    });

    test('SVG diagram and annotated figure', async ({ page }) => {
      await open(page, 'full');
      await expect(page.locator('#tab-indepth figure.diagram')).toHaveScreenshot(shot('full-diagram'));
      await expect(page.locator('#tab-indepth figure.annotated')).toHaveScreenshot(shot('full-figure-annotated'));
    });

    test('stepper on step 3 of 4', async ({ page }) => {
      await open(page, 'showcase');
      const stepper = page.locator('#tab-indepth .stepper').first();
      const next = stepper.getByRole('button', { name: 'Next' });
      await next.click();
      await next.click();
      await page.mouse.move(0, 0);
      await expect(stepper.locator('.stepper-nav [aria-live]')).toHaveText('Step 3 of 4');
      // The badge is the current step's own number (attr(data-step)), not a counter.
      await expect(stepper.locator('.step.is-current')).toHaveAttribute('data-step', '3');
      await expect(stepper.locator('.step.is-current .step-label')).toHaveText('Pack');
      await expect(stepper).toHaveScreenshot(shot('showcase-stepper-step3'));
    });

    test('stock photo with its credit caption', async ({ page }) => {
      await open(page, 'showcase');
      const fig = page.locator('#tab-indepth figure.stock-photo');
      await expect(fig.locator('.fig-credit')).toContainText('Illustrative stock photo');
      await expect(fig).toHaveScreenshot(shot('showcase-stock-photo'));
    });

    test('ELI5 tab', async ({ page }) => {
      await open(page, 'full');
      await showTab(page, 'eli5');
      await expect(tab(page, 'eli5')).toHaveScreenshot(shot('full-eli5-tab'));
      await open(page, 'showcase');
      await showTab(page, 'eli5');
      await expect(tab(page, 'eli5')).toHaveScreenshot(shot('showcase-eli5-tab-photo'));
    });

    test('"ELI5 this selection" tab quotes the selection', async ({ page }) => {
      await open(page, 'showcase');
      const key = await page
        .locator('nav.tabbar [role="tab"]')
        .nth(2)
        .evaluate((b) => (b.getAttribute('aria-controls') ?? '').replace(/^tab-/, ''));
      await showTab(page, key);
      await expect(tab(page, key).locator('.tab-asked')).toContainText('You asked about:');
      await expectRegion(page, shot('showcase-selection-tab'), [
        page.locator('nav.tabbar [role="tab"]'),
        tab(page, key).locator(':scope > :not(.panel-title)'),
      ]);
    });

    test('references: used and skipped, image credits, added by merge', async ({ page }) => {
      await open(page, 'full');
      await expect(refs(page)).toHaveScreenshot(shot('full-references'));
      await open(page, 'showcase');
      await expect(refs(page).locator('h3.ref-group').last()).toHaveText('Image credits');
      await expect(refs(page)).toHaveScreenshot(shot('showcase-references-credits'));
      await open(page, 'merged');
      await expect(refs(page).locator('h3.ref-group').last()).toHaveText('Added by merge');
      await expect(refs(page)).toHaveScreenshot(shot('merged-references'));
    });

    test('merged document: violet enhancements, legend, and "Hide highlights"', async ({ page }) => {
      await open(page, 'merged');
      const first = section(page, 'indepth', 0);
      const legend = page.locator('.enh-legend');
      const body = [first.locator(':scope > h2'), first.locator(':scope > p'), first.locator(':scope > ul')];
      await expect(legend).toHaveScreenshot(shot('merged-legend'));
      await expectRegion(page, shot('merged-enhancements'), [...body, first.locator('details.gl-note')]);
      await expect(first.locator('[data-enh="new"]')).toHaveScreenshot(shot('merged-new-callout'));
      await page.getByRole('button', { name: 'Hide highlights' }).click();
      await page.mouse.move(0, 0);
      await expect(page.locator('html')).toHaveAttribute('data-hide-enh', '');
      await expect(page.getByRole('button', { name: 'Show highlights' })).toBeVisible();
      await expect(legend).toHaveScreenshot(shot('merged-legend-hidden'));
      await expectRegion(page, shot('merged-highlights-hidden'), body);
    });

    test('selection action menu with "ELI5 this selection"', async ({ page }) => {
      await open(page, 'full', { bridge: true });
      const para = section(page, 'indepth', 0).locator(':scope > p').first();
      const box = await para.boundingBox();
      if (!box) throw new Error('no paragraph');
      await page.mouse.move(box.x + 2, box.y + 10);
      await page.mouse.down();
      await page.mouse.move(box.x + 360, box.y + 10, { steps: 6 });
      await page.mouse.up();
      const menu = page.getByRole('toolbar', { name: 'Section actions' });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('button', { name: 'ELI5 this selection' })).toBeVisible();
      await page.mouse.move(0, 0);
      await settle(page);
      await expectRegion(page, shot('full-selection-menu'), [
        section(page, 'indepth', 0).locator(':scope > h2'),
        para,
        menu,
      ]);
    });

    test('a section being updated shows "Updating…"', async ({ page }) => {
      await open(page, 'full', { bridge: true });
      const second = section(page, 'indepth', 1);
      const id = await second.getAttribute('id');
      await page.evaluate(
        (sectionId) =>
          (window as unknown as { __busy: (e: unknown) => void }).__busy({
            busy: [{ sectionId, action: 'expand' }],
          }),
        id,
      );
      await expect(second.locator('.eli5-busy-label')).toHaveText('Updating…');
      await expectRegion(page, shot('full-section-updating'), [
        second.locator(':scope > h2'),
        second.locator('.eli5-busy-label'),
        second.locator(':scope > p').first(),
      ]);
    });

    test('narrow 420 px layout', async ({ page }) => {
      await page.setViewportSize(NARROW);
      await open(page, 'full');
      await expect(page.locator('html')).not.toHaveClass(/\bgl-wide\b/);
      await expect(page).toHaveScreenshot(shot('narrow-top'));
      const first = section(page, 'indepth', 0);
      await first.locator('details.gl-note > summary').first().click();
      await page.mouse.move(0, 0);
      await expectRegion(
        page,
        shot('narrow-glossary-open'),
        [first.locator(':scope > h2'), first.locator(':scope > p'), first.locator('details.gl-note').first()],
        { pad: 8 },
      );
      await expect(page.locator('#tab-indepth figure.chart').first()).toHaveScreenshot(shot('narrow-chart-bar'));
      await open(page, 'showcase');
      await expect(page.locator('#tab-indepth .stepper').first()).toHaveScreenshot(shot('narrow-stepper'));
    });
  });
}
