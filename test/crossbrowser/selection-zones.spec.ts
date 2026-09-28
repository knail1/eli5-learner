/**
 * Selection zones in real engines (08 §5.6): a mouse drag through body paragraphs never selects the
 * glossary margin notes interleaved with them (neither visibly nor in copied text), and a drag that
 * starts inside a note stays inside that note. Chromium and WebKit, over the 'full' golden via file://.
 */
import { expect, test, type Page } from '@playwright/test';
import { GOLDENS, NARROW, WIDE } from './goldens';

const golden = GOLDENS.find((g) => g.name === 'full');
if (!golden) throw new Error('full golden missing');
const URL = golden.url;

const FIRST = '#tab-indepth > section:nth-of-type(1)';
const NOTE_TEXT = 'Revenue earned for each dollar spent on ads';

async function open(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto(URL, { waitUntil: 'load' });
  await expect(page.locator('html')).toHaveClass(/\bjs\b/);
}

/** Drags with the real mouse from the start of `from` to the end of `to` (element centres at the edges). */
async function drag(page: Page, from: string, to: string): Promise<void> {
  const a = await page.locator(from).first().boundingBox();
  const b = await page.locator(to).first().boundingBox();
  if (!a || !b) throw new Error('not visible');
  await page.mouse.move(a.x + 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y + b.height) / 2, { steps: 5 });
  await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
}

/** What a copy of the current selection puts on the clipboard, via a synthetic copy event. */
const copied = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const data = new DataTransfer();
    const e = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return e.defaultPrevented ? data.getData('text/plain') : (document.getSelection()?.toString() ?? '');
  });

const userSelect = (page: Page, selector: string): Promise<string> =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const cs = getComputedStyle(el) as CSSStyleDeclaration & { webkitUserSelect?: string };
      return cs.userSelect || cs.webkitUserSelect || '';
    });

for (const [mode, size] of [
  ['wide', WIDE],
  ['narrow', NARROW],
] as const) {
  test(`${mode}: a drag across body paragraphs skips the glossary note between them`, async ({ page }) => {
    await open(page, size);
    await drag(page, `${FIRST} > p`, `${FIRST} > ul li:last-child`);
    const sel = await page.evaluate(() => document.getSelection()?.toString() ?? '');
    expect(sel).toContain('judges every channel');
    expect(sel).toContain('tagged');
    // The engines leave user-select: none content out of the selection's own text as well.
    expect(sel).not.toContain(NOTE_TEXT);
    expect(await userSelect(page, `${FIRST} details.gl-note`)).toBe('none');
    const text = await copied(page);
    expect(text).toContain('judges every channel');
    expect(text).toContain('Paid search');
    expect(text).not.toContain(NOTE_TEXT);
    expect(text).not.toContain('return on ad spend');
    // The inline term in the body is still selected like any other word.
    expect(text).toContain('conversion is strong');
  });
}

test('wide: a drag that starts inside a note stays inside that note', async ({ page }) => {
  await open(page, WIDE);
  const note = `${FIRST} details.gl-note`;
  await drag(page, `${note} > p`, `#tab-indepth > section:nth-of-type(2) > h2`);
  const state = await page.evaluate((sel) => {
    const s = document.getSelection();
    const n = document.querySelector(sel);
    return {
      text: s?.toString() ?? '',
      anchorIn: !!(n && s?.anchorNode && n.contains(s.anchorNode)),
      focusIn: !!(n && s?.focusNode && (n.contains(s.focusNode) || s.focusNode === n)),
      zone: document.documentElement.classList.contains('eli5-sel-note'),
    };
  }, note);
  expect(state).toMatchObject({ anchorIn: true, focusIn: true, zone: true });
  expect(state.text).toContain('per $1 spent');
  expect(state.text).not.toContain('Paid search');
  expect(state.text).not.toContain('How the budget moved');
  expect(await userSelect(page, 'body')).toBe('none');

  // A click back in the body returns to the body zone: notes are unselectable again.
  await page.locator(`${FIRST} > p`).first().click();
  await expect(page.locator('html')).not.toHaveClass(/eli5-sel-note/);
  expect(await userSelect(page, note)).toBe('none');
});
