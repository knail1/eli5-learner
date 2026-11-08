/**
 * Explorables over file:// in Chromium and WebKit (07 §7.1, §14; 13 §7.3): the runtime adds its
 * controls, the slider and buttons work from the keyboard, a divergent run stops on its own,
 * reduced motion shows the whole run at once, and nothing touches the network.
 */
import { expect, test, type Page } from '@playwright/test';
import { GOLDENS, WIDE, instrument } from './goldens';

const showcase = GOLDENS.find((g) => g.name === 'showcase');
if (!showcase) throw new Error('showcase golden missing');
const URL = showcase.url;

async function open(page: Page): Promise<void> {
  await page.setViewportSize(WIDE);
  await page.goto(URL, { waitUntil: 'load' });
  await expect(page.locator('html')).toHaveClass(/\bjs\b/);
}

const gd = (page: Page) => page.locator('figure.explorable[data-kind="gradient-descent"]');

test('keyboard: slider, presets, Play; a divergent run stops by itself', async ({ browserName, context, page }) => {
  const probe = await instrument(context, page, URL);
  await open(page);
  const fig = gd(page);
  const slider = fig.getByRole('slider', { name: 'Learning rate' });
  await expect(slider).toHaveAttribute('aria-valuetext', 'learning rate 0.1');
  await slider.focus();
  await page.keyboard.press('End');
  await expect(slider).toHaveAttribute('aria-valuetext', 'learning rate 2');
  await page.keyboard.press('Home');
  await expect(slider).toHaveAttribute('aria-valuetext', 'learning rate 0.001');
  await page.keyboard.press('ArrowRight');
  await expect(slider).not.toHaveAttribute('aria-valuetext', 'learning rate 0.001');

  // Tab order: slider, then the presets, then Play. WebKit on macOS skips buttons on Tab unless the
  // system setting is on, so there the buttons are focused directly; activation is still by key.
  const preset = fig.getByRole('button', { name: 'learning rate 1.5' });
  const play = fig.getByRole('button', { name: 'Play' });
  if (browserName === 'chromium') {
    await page.keyboard.press('Tab');
    await expect(fig.getByRole('button', { name: 'learning rate 0.001' })).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
  } else {
    await preset.focus();
  }
  await expect(preset).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(slider).toHaveAttribute('aria-valuetext', 'learning rate 1.5');
  if (browserName === 'chromium') await page.keyboard.press('Tab');
  else await play.focus();
  await expect(play).toBeFocused();
  await page.keyboard.press('Space');
  await expect(fig.locator('.explorable-status')).toHaveText('lr 1.5: diverges after 12 steps', { timeout: 10_000 });
  await expect(fig.getByRole('button', { name: 'Play' })).toHaveAttribute('aria-pressed', 'false');
  await expect(fig.getByRole('button', { name: 'Step' })).toBeDisabled();

  expect(probe.pageErrors).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.requests).toEqual([]);
  expect(await probe.cspViolations()).toEqual([]);
});

test('reduced motion shows the whole run at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const fig = gd(page);
  await expect(fig.locator('.explorable-status')).toHaveText('lr 0.1: converges in 37 steps');
  await fig.getByRole('button', { name: 'learning rate 0.001' }).click();
  await expect(fig.locator('.explorable-status')).toHaveText('lr 0.001: crawls');
});

test('the walk plays and the static picture stays visible', async ({ page }) => {
  await open(page);
  const fig = page.locator('figure.explorable[data-kind="metropolis-walk"]');
  await expect(fig.locator('svg.explorable-svg')).toBeVisible();
  await fig.getByRole('button', { name: 'step size 20' }).click();
  await fig.getByRole('button', { name: 'Play' }).click();
  await expect(fig.locator('.explorable-status')).toHaveText(/^step 20: stuck \(\d+% accepted\)$/, { timeout: 10_000 });
});
