/**
 * Cross-browser smoke (13 §7.3, §13 accessibility): every golden opened via file:// in Chromium and
 * WebKit. The default tab renders, tab switching works, glossary notes collapse below the
 * breakpoint, the select-and-act bridge stays absent and silent outside the app (08), there are no
 * page or console errors, and axe finds zero serious or critical violations.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { GOLDENS, NARROW, WIDE, instrument, type Probe } from './goldens';

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'load' });
  await expect(page.locator('html')).toHaveClass(/\bjs\b/);
}

async function expectActive(page: Page, key: string): Promise<void> {
  await expect(page.locator(`#tabbtn-${key}`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`#tab-${key}`)).toBeVisible();
  const others = page.locator(`.tabpanel[data-tab-key]:not([data-tab-key="${key}"])`);
  for (let i = 0; i < (await others.count()); i++) await expect(others.nth(i)).toBeHidden();
}

function expectClean(probe: Probe): void {
  expect(probe.pageErrors).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.requests).toEqual([]);
}

/**
 * Known product defect, tolerated here only until the renderer is fixed: the runtime un-hides
 * `button.theme-toggle` inside `nav.tabbar[role=tablist]` (07 §6.1), and a tablist may own only
 * tabs. Fix: move the toggle out of the tablist (or put the tabs in an inner role=tablist element),
 * then delete this entry. Each match is recorded as a test annotation so it stays visible.
 */
const KNOWN_A11Y: readonly { id: string; target: string; summary: RegExp }[] = [
  { id: 'aria-required-children', target: 'nav', summary: /not allowed: button\[aria-label\]$/ },
];

async function seriousViolations(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const out: string[] = [];
  for (const v of violations) {
    if (v.impact !== 'serious' && v.impact !== 'critical') continue;
    for (const n of v.nodes) {
      const target = n.target.join(' ');
      const summary = (n.failureSummary ?? '').trim();
      const line = `${v.id} (${v.impact}): ${target}: ${summary.replace(/\s+/g, ' ')}`;
      if (KNOWN_A11Y.some((k) => k.id === v.id && k.target === target && k.summary.test(summary))) {
        test.info().annotations.push({ type: 'known-a11y-issue', description: line });
      } else out.push(line);
    }
  }
  return out;
}

for (const g of GOLDENS) {
  test.describe(g.name, () => {
    test('default tab renders and every tab switches', async ({ context, page }) => {
      const probe = await instrument(context, page, g.url);
      await page.setViewportSize(WIDE);
      await open(page, g.url);
      await expectActive(page, 'indepth');
      await expect(page.locator('#tab-indepth section').first()).toBeVisible();

      const keys = await page
        .locator('nav.tabbar [role="tab"]')
        .evaluateAll((els) => els.map((e) => (e.getAttribute('aria-controls') ?? '').replace(/^tab-/, '')));
      expect(keys.slice(0, 2)).toEqual(['indepth', 'eli5']);
      for (const key of [...keys.slice(1), keys[0] ?? 'indepth']) {
        await page.locator(`#tabbtn-${key}`).click();
        await expectActive(page, key);
      }
      // Keyboard: arrow keys move focus, Enter activates (WAI-ARIA tabs, manual activation, 07 §12).
      await page.locator('#tabbtn-indepth').focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#tabbtn-eli5')).toBeFocused();
      await page.keyboard.press('Enter');
      await expectActive(page, 'eli5');
      expectClean(probe);
    });

    test('glossary notes are margin notes when wide and collapse below the breakpoint', async ({ context, page }) => {
      const probe = await instrument(context, page, g.url);
      await page.setViewportSize(WIDE);
      await open(page, g.url);
      const notes = page.locator('details.gl-note');
      const count = await notes.count();
      test.skip(count === 0, 'this golden has no glossary');
      // Glossary only in the In depth tab (13 §7.1 glossary-scope, checked at runtime too).
      expect(await page.locator('#tab-indepth details.gl-note').count()).toBe(count);

      await expect(page.locator('html')).toHaveClass(/\bgl-wide\b/);
      for (let i = 0; i < count; i++) await expect(notes.nth(i)).toHaveJSProperty('open', true);

      await page.setViewportSize(NARROW);
      await expect(page.locator('html')).not.toHaveClass(/\bgl-wide\b/);
      for (let i = 0; i < count; i++) {
        await expect(notes.nth(i)).toHaveJSProperty('open', false);
        expect(await notes.nth(i).evaluate((n) => getComputedStyle(n).position)).toBe('static');
      }
      // Collapsed notes open on demand and stay in the text column.
      const first = notes.first();
      await first.locator('summary').click();
      await expect(first).toHaveJSProperty('open', true);
      const colRight = await page.locator('#tab-indepth').evaluate((p) => p.getBoundingClientRect().right);
      expect(await first.evaluate((n) => n.getBoundingClientRect().right)).toBeLessThanOrEqual(colRight + 1);

      await page.setViewportSize(WIDE);
      await expect(page.locator('html')).toHaveClass(/\bgl-wide\b/);
      expectClean(probe);
    });

    test('the select-and-act bridge is absent and silent in a plain browser', async ({ context, page }) => {
      const probe = await instrument(context, page, g.url);
      await page.setViewportSize(WIDE);
      await open(page, g.url);
      expect(await page.evaluate(() => typeof (window as unknown as { eli5Doc?: unknown }).eli5Doc)).toBe('undefined');
      const before = await page.evaluate(() => document.body.children.length);
      const para = page.locator('#tab-indepth section p').first();
      const box = await para.boundingBox();
      if (!box) throw new Error('no paragraph to select');
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + Math.min(box.width - 2, 200), box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
      expect(await page.evaluate(() => String(window.getSelection() ?? '').length)).toBeGreaterThan(0);
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => document.body.children.length)).toBe(before);
      await expect(page.locator('nav.tabbar button.tab-close:visible')).toHaveCount(0);
      expectClean(probe);
    });

    test('axe: zero serious or critical violations', async ({ context, page }) => {
      const probe = await instrument(context, page, g.url);
      await page.setViewportSize(WIDE);
      await open(page, g.url);
      const found: string[] = [];
      const keys = await page
        .locator('nav.tabbar [role="tab"]')
        .evaluateAll((els) => els.map((e) => (e.getAttribute('aria-controls') ?? '').replace(/^tab-/, '')));
      for (const key of keys) {
        await page.locator(`#tabbtn-${key}`).click();
        found.push(...(await seriousViolations(page)).map((v) => `[${key}] ${v}`));
      }
      // Collapsed glossary layout, with one note opened.
      await page.locator('#tabbtn-indepth').click();
      await page.setViewportSize(NARROW);
      const summary = page.locator('details.gl-note > summary').first();
      if ((await summary.count()) > 0) await summary.click();
      found.push(...(await seriousViolations(page)).map((v) => `[narrow] ${v}`));
      expect(found).toEqual([]);
      expectClean(probe);
    });
  });
}
