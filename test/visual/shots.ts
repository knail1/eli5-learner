/**
 * Shared screenshot helpers for the visual suite (13 §7.4). Not a spec file itself. Region shots
 * clip the union of a few elements (plus a margin) out of the page, so one image can
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

/**
 * A capture clipped to the union of `locators` (document coordinates). See `expectClip`.
 */
export async function expectRegion(
  page: Page,
  name: string,
  locators: Locator[],
  opts: { pad?: number; mask?: Locator[] } = {},
): Promise<void> {
  const clip = await unionBox(page, locators, opts.pad);
  await expectClip(page, name, clip, opts);
}

/**
 * A capture of `clip` (document coordinates). When the clip lies inside the viewport it is taken
 * from the viewport as it stands: a `fullPage` capture of a page taller than the viewport makes
 * Chromium resize the view to the clip for the capture (captureBeyondViewport), and the resize and
 * scroll events that fire then can close a selection menu whose anchor no longer fits. Only a
 * region that does not fit the viewport is taken from a full-page capture, after scrolling it into
 * view.
 */
export async function expectClip(page: Page, name: string, clip: Box, opts: { mask?: Locator[] } = {}): Promise<void> {
  const mask = opts.mask ?? [];
  const vp = await page.evaluate(() => ({ x: scrollX, y: scrollY, w: innerWidth, h: innerHeight }));
  const fits =
    clip.x >= vp.x && clip.y >= vp.y && clip.x + clip.width <= vp.x + vp.w && clip.y + clip.height <= vp.y + vp.h;
  if (fits) {
    await expect(page).toHaveScreenshot(name, { clip: { ...clip, x: clip.x - vp.x, y: clip.y - vp.y }, mask });
    return;
  }
  await page.evaluate((c) => {
    window.scrollTo({ left: scrollX, top: Math.max(0, c.y + c.height / 2 - innerHeight / 2), behavior: 'instant' });
  }, clip);
  await settle(page);
  await expect(page).toHaveScreenshot(name, { fullPage: true, clip, mask });
}

/** Every web font (and the system fonts it falls back to) has loaded; layout has settled. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}
