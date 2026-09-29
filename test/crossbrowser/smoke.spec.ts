/**
 * Cross-browser smoke (13 §7.3, §13 accessibility): every golden opened via file:// in Chromium and
 * WebKit. The default tab renders, tab switching works, glossary notes collapse below the
 * breakpoint, the select-and-act bridge stays absent and silent outside the app (08), there are no
 * page or console errors, and axe finds zero serious or critical violations in both themes. Chart
 * and diagram marks get a real computed color in both themes (07 §16).
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

async function seriousViolations(page: Page, include?: string): Promise<string[]> {
  const builder = new AxeBuilder({ page });
  if (include) builder.include(include);
  const { violations } = await builder.analyze();
  const out: string[] = [];
  for (const v of violations) {
    if (v.impact !== 'serious' && v.impact !== 'critical') continue;
    for (const n of v.nodes) {
      const target = n.target.join(' ');
      const summary = (n.failureSummary ?? '').trim();
      out.push(`${v.id} (${v.impact}): ${target}: ${summary.replace(/\s+/g, ' ')}`);
    }
  }
  return out;
}

/** Chart and diagram marks colored through viz-fill-* / viz-stroke-* classes (07 §7.2 rule 11). */
interface Mark {
  cls: string;
  prop: 'fill' | 'stroke';
  value: string;
}

async function markColors(page: Page): Promise<Mark[]> {
  return page.locator('figure.chart svg, figure.diagram svg').evaluateAll((svgs) => {
    const out: { cls: string; prop: 'fill' | 'stroke'; value: string }[] = [];
    for (const svg of svgs) {
      for (const el of [svg, ...Array.from(svg.querySelectorAll('[class]'))]) {
        for (const cls of Array.from(el.classList)) {
          const m = /^viz-(fill|stroke)-/.exec(cls);
          if (!m) continue;
          const prop = m[1] as 'fill' | 'stroke';
          out.push({ cls, prop, value: getComputedStyle(el).getPropertyValue(prop).trim() });
        }
      }
    }
    return out;
  });
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

    test('chart and diagram marks have a real computed color in both themes (07 §16)', async ({ context, page }) => {
      const probe = await instrument(context, page, g.url);
      await page.setViewportSize(WIDE);
      const byTheme: Record<string, Mark[]> = {};
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        await open(page, g.url);
        const marks = await markColors(page);
        expect(marks.length, colorScheme).toBeGreaterThan(0);
        const bad = marks.filter((m) => m.value === '' || m.value === 'none' || m.value === 'rgb(0, 0, 0)');
        expect(bad, colorScheme).toEqual([]);
        byTheme[colorScheme] = marks;
      }
      // The marks follow the theme without re-render: at least one class resolves differently.
      const light = byTheme.light ?? [];
      const dark = byTheme.dark ?? [];
      expect(dark.map((m) => m.cls)).toEqual(light.map((m) => m.cls));
      expect(dark.some((m, i) => m.value !== light[i]?.value)).toBe(true);
      expectClean(probe);
    });

    test('axe: zero serious or critical violations, light and dark', async ({ context, page }) => {
      const probe = await instrument(context, page, g.url);
      await page.setViewportSize(WIDE);
      // 07 §16: both themes pass WCAG AA for body text.
      await page.emulateMedia({ colorScheme: 'dark' });
      await open(page, g.url);
      await expect(page.locator('body')).not.toHaveCSS('background-color', 'rgb(255, 255, 255)');
      // A themed document carries a derived dark variant (07 §11.4), so the whole page is scanned
      // in dark too, its accent kicker and links included.
      const dark = (await seriousViolations(page)).map((v) => `[dark] ${v}`);
      await page.emulateMedia({ colorScheme: 'light' });
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
      expect([...dark, ...found]).toEqual([]);
      expectClean(probe);
    });
  });
}

/** Relative luminance of a computed `rgb(...)` color, in the page. */
async function paperLuminance(page: Page): Promise<number> {
  return page.evaluate(() => {
    const m = /rgba?\(([^)]*)\)/.exec(getComputedStyle(document.body).backgroundColor)?.[1] ?? '0,0,0';
    const [r, g, b] = m.split(',').map((x) => Number(x.trim()) / 255);
    const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r ?? 0) + 0.7152 * lin(g ?? 0) + 0.0722 * lin(b ?? 0);
  });
}

const themed = GOLDENS.find((g) => g.name === 'themed');
test.describe('themed document: dark variant (07 §11.2, §11.4)', () => {
  test.skip(!themed, 'no themed golden');
  const url = themed?.url ?? '';

  test('follows the system in auto and honours the toggle both ways', async ({ context, page }) => {
    const probe = await instrument(context, page, url);
    await page.setViewportSize(WIDE);
    const kicker = page.locator('header.doc-head .kicker');
    const setTheme = (t: string) => page.evaluate((v) => document.documentElement.setAttribute('data-theme', v), t);

    await page.emulateMedia({ colorScheme: 'light' });
    await open(page, url);
    expect(await paperLuminance(page)).toBeGreaterThan(0.8);
    const lightAccent = await kicker.evaluate((e) => getComputedStyle(e).color);
    await setTheme('dark'); // explicit dark on a light system
    expect(await paperLuminance(page)).toBeLessThan(0.02);
    const darkAccent = await kicker.evaluate((e) => getComputedStyle(e).color);
    expect(darkAccent).not.toBe(lightAccent);

    await page.emulateMedia({ colorScheme: 'dark' });
    await setTheme('auto'); // auto follows the dark system
    expect(await paperLuminance(page)).toBeLessThan(0.02);
    expect(await kicker.evaluate((e) => getComputedStyle(e).color)).toBe(darkAccent);
    await setTheme('light'); // explicit light on a dark system
    expect(await paperLuminance(page)).toBeGreaterThan(0.8);
    expect(await kicker.evaluate((e) => getComputedStyle(e).color)).toBe(lightAccent);

    // The toggle button cycles auto -> light -> dark on a dark system.
    await setTheme('auto');
    await open(page, url);
    await page.locator('.theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await paperLuminance(page)).toBeGreaterThan(0.8);
    await page.locator('.theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await paperLuminance(page)).toBeLessThan(0.02);
    expectClean(probe);
  });

  test('axe: zero serious or critical violations in dark, auto and explicit', async ({ context, page }) => {
    const probe = await instrument(context, page, url);
    await page.setViewportSize(WIDE);
    await page.emulateMedia({ colorScheme: 'dark' });
    await open(page, url);
    const found = (await seriousViolations(page)).map((v) => `[auto dark] ${v}`);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    found.push(...(await seriousViolations(page)).map((v) => `[explicit dark] ${v}`));
    expect(found).toEqual([]);
    expectClean(probe);
  });
});
