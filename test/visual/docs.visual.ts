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
/**
 * Phone widths (16 §12 Visual): 360 px is the common small Android width, 412 px a Pixel's. The
 * Android reader is a Chromium WebView, so these run in Chromium only.
 */
const PHONE_WIDTHS = [360, 412] as const;

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
      askQuestion: ok,
      askDeep: ok,
      askDeeper: ok,
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

    test('animation: the live frame (reduced motion: final state), and its poster in print', async ({ page }) => {
      await open(page, 'showcase');
      const fig = page.locator('#tab-indepth figure.animation');
      await fig.scrollIntoViewIfNeeded();
      await expect(fig).toHaveClass(/\banim-live\b/);
      const frame = page.frameLocator('#tab-indepth figure.animation iframe');
      await expect(frame.locator('.eli5-readout strong')).toHaveText(/^\d+$/);
      await page.mouse.move(0, 0);
      await expect(fig).toHaveScreenshot(shot('showcase-animation'));
      await page.emulateMedia({ media: 'print' });
      await expect(fig).toHaveScreenshot(shot('showcase-animation-print'));
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

    test('ASD-STE100 tab: fixed tab with its hint (07 §4.1)', async ({ page }) => {
      await open(page, 'with-ste');
      await showTab(page, 'ste');
      await expect(tab(page, 'ste').locator('.tab-hint')).toBeVisible();
      await expectRegion(page, shot('with-ste-tab-hint'), [
        page.locator('nav.tabbar [role="tab"]'),
        tab(page, 'ste').locator('.tab-hint'),
        tab(page, 'ste').locator(':scope > section').first().locator(':scope > h2, :scope > p'),
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

    test('selection action menu: Ask field with Ask, Ask deep and Ask deeper, Explain and ELI5 triggers, Edit with my note', async ({
      page,
    }) => {
      await open(page, 'full', { bridge: true });
      const para = section(page, 'indepth', 0).locator(':scope > p').first();
      const box = await para.boundingBox();
      if (!box) throw new Error('no paragraph');
      await page.mouse.move(box.x + 2, box.y + 10);
      await page.mouse.down();
      await page.mouse.move(box.x + 360, box.y + 10, { steps: 6 });
      await page.mouse.up();
      const menu = page.getByRole('group', { name: 'Selection actions' });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('button', { name: 'ELI5', exact: true })).toBeVisible();
      await expect(menu.getByRole('button', { name: 'Ask', exact: true })).toBeVisible();
      await expect(menu.getByRole('button', { name: 'Ask deep', exact: true })).toBeVisible();
      await expect(menu.getByRole('button', { name: 'Ask deeper', exact: true })).toBeVisible();
      await page.mouse.move(0, 0);
      await settle(page);
      await expectRegion(page, shot('full-selection-menu'), [
        section(page, 'indepth', 0).locator(':scope > h2'),
        para,
        menu,
      ]);
    });

    test('selection action menu with the Explain popup open', async ({ page }) => {
      await open(page, 'full', { bridge: true });
      const para = section(page, 'indepth', 0).locator(':scope > p').first();
      const box = await para.boundingBox();
      if (!box) throw new Error('no paragraph');
      await page.mouse.move(box.x + 2, box.y + 10);
      await page.mouse.down();
      await page.mouse.move(box.x + 360, box.y + 10, { steps: 6 });
      await page.mouse.up();
      const menu = page.getByRole('group', { name: 'Selection actions' });
      await expect(menu).toBeVisible();
      const trigger = menu.getByRole('button', { name: 'Explain', exact: true });
      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(menu.getByRole('menu', { name: 'Explain' }).getByRole('menuitem')).toHaveText([
        'Expand this',
        "This isn't clear, re-explain it",
        'Give me an analogy',
        'Go deeper',
      ]);
      await page.mouse.move(0, 0);
      // Opening the popup focuses its first item (no ring after a mouse click).
      await expect(menu.getByRole('menuitem', { name: 'Expand this' })).toBeFocused();
      await settle(page);
      await expectRegion(page, shot('menu-explain-open'), [
        section(page, 'indepth', 0).locator(':scope > h2'),
        para,
        menu,
      ]);
    });

    test('answer box at rest, then with its question open', async ({ page }) => {
      await open(page, 'asked');
      const qa = page.locator('#tab-indepth aside.qa').first();
      await qa.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await settle(page);
      // The chip notches the box's top border, so the region reaches above the box.
      await expectRegion(page, shot('qa-box'), [qa, qa.locator('.qa-chip')]);
      await qa.locator('.qa-chip').click();
      await expect(qa.locator('details.qa-q')).toHaveAttribute('open', '');
      await expect(qa.locator('.qa-q-text')).toBeVisible();
      await page.mouse.move(0, 0);
      await settle(page);
      await expectRegion(page, shot('qa-box-question-open'), [qa, qa.locator('.qa-chip')]);
    });

    test('deep answer boxes: badge per source mode (all, excerpts, none)', async ({ page }) => {
      await open(page, 'deep-asked');
      const boxes = page.locator('#tab-indepth aside.qa.qa-deep');
      await expect(boxes).toHaveCount(3);
      for (const [i, mode] of (['all', 'excerpts', 'none'] as const).entries()) {
        const qa = boxes.nth(i);
        await expect(qa.locator('.qa-badge')).toBeVisible();
        await qa.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await settle(page);
        await expectRegion(page, shot(`qa-deep-${mode}`), [qa, qa.locator('.qa-chip')]);
      }
    });

    test('deeper answer boxes: badge per reach (material, web with its pages, general)', async ({ page }) => {
      await open(page, 'deep-asked');
      const boxes = page.locator('#tab-indepth aside.qa.qa-deeper');
      await expect(boxes).toHaveCount(3);
      for (const [i, reach] of (['material', 'web', 'general'] as const).entries()) {
        const qa = boxes.nth(i);
        await expect(qa.locator('.qa-badge')).toBeVisible();
        await qa.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await settle(page);
        await expectRegion(page, shot(`qa-deeper-${reach}`), [qa, qa.locator('.qa-chip')]);
      }
      await expect(boxes.nth(1).locator('ul.qa-web > li')).toHaveCount(2);
    });

    test('selection menu with the Ask deeper tooltip open from keyboard focus', async ({ page }) => {
      await open(page, 'full', { bridge: true });
      const para = section(page, 'indepth', 0).locator(':scope > p').first();
      const box = await para.boundingBox();
      if (!box) throw new Error('no paragraph');
      await page.mouse.move(box.x + 2, box.y + 10);
      await page.mouse.down();
      await page.mouse.move(box.x + 360, box.y + 10, { steps: 6 });
      await page.mouse.up();
      const menu = page.getByRole('group', { name: 'Selection actions' });
      await expect(menu).toBeVisible();
      const q = menu.getByRole('textbox', { name: 'Your question about this passage' });
      await q.fill('How long does it take to catch up?');
      const deeper = menu.getByRole('button', { name: 'Ask deeper', exact: true });
      await expect(deeper).toBeEnabled();
      await deeper.focus();
      const tip = menu.locator('.tip');
      await expect(tip).toBeVisible();
      await expect(tip).toHaveText(
        "Searches every tab and the original sources first, then the web, then the AI's general knowledge. Anything from outside the document is marked. (⌘ ⇧ Enter or Ctrl+Shift+Enter)",
      );
      await expect(deeper).toHaveAccessibleDescription(/then the web, then the AI's general knowledge/);
      const tb = await tip.boundingBox();
      const vw = page.viewportSize()?.width ?? 0;
      if (!tb) throw new Error('no tooltip');
      expect(tb.x).toBeGreaterThanOrEqual(8 - 0.5);
      expect(tb.x + tb.width).toBeLessThanOrEqual(vw - 8 + 0.5);
      await page.mouse.move(0, 0);
      await settle(page);
      await expectRegion(page, shot('menu-ask-tooltip'), [para, menu, tip]);
      // Esc hides the tooltip first; the menu stays open.
      await page.keyboard.press('Escape');
      await expect(tip).toBeHidden();
      await expect(menu).toBeVisible();
    });

    test('selection menu at 320 px: question, then Ask, Ask deep and Ask deeper on one row', async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 700 });
      await open(page, 'full', { bridge: true });
      const para = section(page, 'indepth', 0).locator(':scope > p').first();
      const box = await para.boundingBox();
      if (!box) throw new Error('no paragraph');
      await page.mouse.move(box.x + 2, box.y + 10);
      await page.mouse.down();
      await page.mouse.move(box.x + 200, box.y + 10, { steps: 6 });
      await page.mouse.up();
      const menu = page.getByRole('group', { name: 'Selection actions' });
      await expect(menu).toBeVisible();
      const q = menu.getByRole('textbox', { name: 'Your question about this passage' });
      const ask = menu.getByRole('button', { name: 'Ask', exact: true });
      const deep = menu.getByRole('button', { name: 'Ask deep', exact: true });
      const deeper = menu.getByRole('button', { name: 'Ask deeper', exact: true });
      const [qb, ab, db, eb, mb] = await Promise.all([
        q.boundingBox(),
        ask.boundingBox(),
        deep.boundingBox(),
        deeper.boundingBox(),
        menu.boundingBox(),
      ]);
      if (!qb || !ab || !db || !eb || !mb) throw new Error('no ask row');
      // The three buttons never split: one row, left to right, below or beside the field.
      expect(Math.abs(db.y - ab.y)).toBeLessThan(4);
      expect(Math.abs(eb.y - ab.y)).toBeLessThan(4);
      expect(ab.x + ab.width).toBeLessThanOrEqual(db.x);
      expect(db.x + db.width).toBeLessThanOrEqual(eb.x);
      expect(ab.y).toBeGreaterThanOrEqual(qb.y);
      // Everything inside the menu, the menu inside the viewport, and the field keeps a usable width.
      for (const b of [qb, ab, db, eb]) {
        expect(b.x).toBeGreaterThanOrEqual(mb.x);
        expect(b.x + b.width).toBeLessThanOrEqual(mb.x + mb.width + 0.5);
      }
      expect(mb.x + mb.width).toBeLessThanOrEqual(320);
      expect(qb.width).toBeGreaterThan(100);
      // Each label stays on one line (a button no taller than the field).
      for (const b of [ab, db, eb]) expect(b.height).toBeLessThan(qb.height + 6);
      await page.mouse.move(0, 0);
      await settle(page);
      await expectRegion(page, shot('narrow-selection-menu'), [menu]);
      // The longest tooltip stays inside the 320 px viewport (8 px margins).
      await q.fill('How long does it take to catch up?');
      await deeper.focus();
      const tip = menu.locator('.tip');
      await expect(tip).toBeVisible();
      const tb = await tip.boundingBox();
      if (!tb) throw new Error('no tooltip');
      expect(tb.x).toBeGreaterThanOrEqual(8 - 0.5);
      expect(tb.x + tb.width).toBeLessThanOrEqual(320 - 8 + 0.5);
      expect(tb.y).toBeGreaterThanOrEqual(0);
      expect(tb.y + tb.height).toBeLessThanOrEqual(700);
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

    for (const width of PHONE_WIDTHS) {
      test(`phone ${width} px layout (Android reader)`, async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', 'phone widths: Chromium only (Android WebView)');
        await page.setViewportSize({ width, height: 800 });
        // No golden scrolls sideways at a phone width: wide content scrolls inside its own box.
        for (const g of GOLDENS) {
          await open(page, g.name);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
          expect(overflow, `${g.name} at ${width} px`).toBeLessThanOrEqual(0);
        }
        const p = (name: string) => shot(`phone${width}-${name}`);
        await open(page, 'full');
        await expect(page.locator('html')).not.toHaveClass(/\bgl-wide\b/);
        await expect(page).toHaveScreenshot(p('top'));
        const first = section(page, 'indepth', 0);
        await first.locator('details.gl-note > summary').first().click();
        await page.mouse.move(0, 0);
        await expectRegion(
          page,
          p('glossary-open'),
          [first.locator(':scope > h2'), first.locator(':scope > p'), first.locator('details.gl-note').first()],
          { pad: 8 },
        );
        await expect(page.locator('#tab-indepth figure.chart').first()).toHaveScreenshot(p('chart-bar'));
        await open(page, 'showcase');
        await expect(page.locator('#tab-indepth .stepper').first()).toHaveScreenshot(p('stepper'));
      });
    }
  });
}
