/**
 * Shared screenshot helpers for the visual suite (13 §7.4). Not a spec file itself. Region shots
 * clip the union of a few elements (plus a margin) out of a full-page capture, so one image can
 * hold a paragraph and its margin note, or a quote and the callout beside it, without the rest of
 * the page.
 */
import { expect, type Locator, type Page } from '@playwright/test';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Document coordinates (not viewport) of every element matched by `locators`, as one box. */
export async function unionBox(page: Page, locators: Locator[], pad = 16): Promise<Box> {
  const boxes: Box[] = [];
  for (const l of locators) {
    for (const el of await l.all()) {
      boxes.push(
        await el.evaluate((n) => {
          const r = n.getBoundingClientRect();
          return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
        }),
      );
    }
  }
  if (boxes.length === 0) throw new Error('unionBox: nothing matched');
  const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const x0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.x)) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.y)) - pad));
  const x1 = Math.min(docWidth, Math.ceil(Math.max(...boxes.map((b) => b.x + b.width)) + pad));
  const y1 = Math.ceil(Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** A full-page capture clipped to the union of `locators` (document coordinates). */
export async function expectRegion(
  page: Page,
  name: string,
  locators: Locator[],
  opts: { pad?: number; mask?: Locator[] } = {},
): Promise<void> {
  const clip = await unionBox(page, locators, opts.pad);
  await expect(page).toHaveScreenshot(name, { fullPage: true, clip, mask: opts.mask ?? [] });
}

/** Every web font (and the system fonts it falls back to) has loaded; layout has settled. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}
