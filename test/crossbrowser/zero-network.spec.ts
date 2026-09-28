/**
 * Runtime rule: zero network requests (13 §7.2). Each golden is opened over file:// with every
 * request intercepted; the probe walks every tab, toggles every glossary note and resizes below the
 * glossary breakpoint. Pass: no request other than the document itself, no CSP violation, no page
 * or console error. The canary proves the probe sees requests at all.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { GOLDENS, NARROW, WIDE, instrument } from './goldens';

test('canary: the probe records and blocks requests a document makes', async ({ context, page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'eli5-probe-'));
  try {
    const file = join(dir, 'leaky.html');
    writeFileSync(
      file,
      '<!doctype html><html><head><title>leaky</title></head><body>' +
        '<img src="https://example.invalid/pixel.png" alt="">' +
        '<script>fetch("https://example.invalid/beacon").catch(function(){})</script></body></html>',
    );
    const url = pathToFileURL(file).href;
    const probe = await instrument(context, page, url);
    await page.goto(url);
    await expect.poll(() => probe.requests.length).toBeGreaterThanOrEqual(2);
    expect(probe.requests).toEqual(
      expect.arrayContaining(['https://example.invalid/pixel.png', 'https://example.invalid/beacon']),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const g of GOLDENS) {
  test(`${g.name}: no request leaves the document`, async ({ context, page }) => {
    const probe = await instrument(context, page, g.url);
    await page.setViewportSize(WIDE);
    await page.goto(g.url, { waitUntil: 'load' });
    await expect(page.locator('html')).toHaveClass(/\bjs\b/);

    // Every tab.
    const tabs = page.locator('nav.tabbar [role="tab"]');
    for (let i = 0; i < (await tabs.count()); i++) await tabs.nth(i).click();
    await tabs.first().click();

    // Every glossary note, collapsed layout (the wide layout keeps notes open by design).
    await page.setViewportSize(NARROW);
    const summaries = page.locator('details.gl-note > summary');
    for (let i = 0; i < (await summaries.count()); i++) {
      await summaries.nth(i).click();
      await summaries.nth(i).click();
    }
    await page.setViewportSize(WIDE);
    await page.setViewportSize(NARROW);
    // Let any late timers or lazy work run.
    await page.waitForTimeout(250);

    expect(probe.requests).toEqual([]);
    expect(await probe.cspViolations()).toEqual([]);
    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
  });
}
