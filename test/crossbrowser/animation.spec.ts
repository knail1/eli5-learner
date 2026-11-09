/**
 * Animation frames over file:// in Chromium, WebKit and Firefox (07 §6.2, §7.1; 13 §7.3): the
 * sandboxed srcdoc frame runs its shell and the model's code under the inherited and its own CSP,
 * reports its height, takes the parent's theme, and its slider drives its readout. A hostile frame
 * cannot read the parent, has no network APIs, cannot load anything and cannot navigate. Reduced
 * motion shows the final state at once, and print shows the poster.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { PACKING_JS } from '../fixtures/documents/animation';
import { GOLDENS, WIDE, instrument, type Probe } from './goldens';

const showcase = GOLDENS.find((g) => g.name === 'showcase');
if (!showcase) throw new Error('showcase golden missing');
const URL = showcase.url;

const figure = (page: Page) => page.locator('#tab-indepth figure.animation');
const frameOf = (page: Page): FrameLocator => page.frameLocator('#tab-indepth figure.animation iframe');

async function open(page: Page, url = URL): Promise<void> {
  await page.setViewportSize(WIDE);
  await page.goto(url, { waitUntil: 'load' });
  await expect(page.locator('html')).toHaveClass(/\bjs\b/);
  await figure(page).scrollIntoViewIfNeeded();
}

function clean(probe: Probe): void {
  expect(probe.pageErrors).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.requests).toEqual([]);
}

test('the frame runs, reports its height, and its slider updates its readout', async ({ context, page }) => {
  const probe = await instrument(context, page, URL);
  await open(page);
  await expect(figure(page)).toHaveClass(/\banim-live\b/);
  const stage = figure(page).locator('.anim-stage');
  await expect
    .poll(() => stage.evaluate((el) => Number.parseInt((el as HTMLElement).style.height, 10) || 0))
    .toBeGreaterThanOrEqual(120);

  const frame = frameOf(page);
  const slider = frame.getByRole('slider', { name: 'Packers on shift' });
  await expect(slider).toHaveAttribute('aria-valuetext', 'Packers on shift 3');
  const readout = frame.locator('.eli5-readout strong');
  await expect(readout).toHaveText(/^\d+$/, { timeout: 10_000 });
  const enough = Number(await readout.textContent());
  await slider.fill('1');
  await expect(slider).toHaveAttribute('aria-valuetext', 'Packers on shift 1');
  await expect(readout).toHaveText(/^\d+$/, { timeout: 10_000 });
  const short = Number(await readout.textContent());
  expect(short).toBeGreaterThan(enough + 50); // one packer: the queue grows all hour
  await expect(frame.getByRole('button', { name: 'Replay' })).toBeVisible();

  clean(probe);
  expect(await probe.cspViolations()).toEqual([]);
});

test('the frame takes the parent theme', async ({ page }) => {
  await open(page);
  await expect(figure(page)).toHaveClass(/\banim-live\b/);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await expect(frameOf(page).locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await expect(frameOf(page).locator('html')).toHaveAttribute('data-theme', 'light');
});

test('reduced motion: the final state shows at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const frame = frameOf(page);
  await expect(frame.locator('.eli5-readout strong')).toHaveText(/^\d+$/, { timeout: 2_000 });
  expect(
    await frame
      .locator('html')
      .evaluate(() => (window as unknown as { ELI5: { reducedMotion: boolean } }).ELI5.reducedMotion),
  ).toBe(true);
  await frame.getByRole('slider', { name: 'Packers on shift' }).fill('2');
  await expect(frame.locator('.eli5-readout strong')).toHaveText(/^\d+$/, { timeout: 1_000 });
});

test('print shows the poster, not the frame', async ({ page }) => {
  await open(page);
  await expect(figure(page)).toHaveClass(/\banim-live\b/);
  await page.emulateMedia({ media: 'print' });
  await expect(figure(page).locator('iframe')).toBeHidden();
  await expect(figure(page).locator('.anim-poster svg')).toBeVisible();
  await expect(figure(page).locator('figcaption')).toBeVisible();
});

const sha = (js: string): string => `sha256-${createHash('sha256').update(js, 'utf8').digest('base64')}`;
const escAttr = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The showcase with its animation code replaced by `js` in the frame and both CSPs, bypassing the
 * lint, to test the boundary itself (sandbox + CSP) rather than the lint.
 */
function hostileDocument(js: string): string {
  let html = readFileSync(fileURLToPath(URL), 'utf8');
  const at = html.lastIndexOf(escAttr(PACKING_JS));
  expect(at).toBeGreaterThan(0);
  html = html.slice(0, at) + escAttr(js) + html.slice(at + escAttr(PACKING_JS).length);
  html = html.split(sha(PACKING_JS)).join(sha(js));
  const dir = resolve(import.meta.dirname, '../../test-results/crossbrowser-docs');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `hostile-${process.pid}-${Date.now()}.html`);
  writeFileSync(file, html);
  return pathToFileURL(file).href;
}

const HOSTILE = `var r = {};
// top is not touched by the shell, so this probes the sandbox itself (an opaque origin).
try { r.top = String(top.document.title); } catch (e) { r.top = e.name; }
r.parent = typeof parent;
try { ELI5.el('iframe', {}, document.body); r.el = 'made'; } catch (e) { r.el = 'threw'; }
try { document.createElement('iframe'); r.ce = 'made'; } catch (e) { r.ce = 'threw'; }
try { document.createElementNS('http://www.w3.org/1999/xhtml', 'link'); r.ceNS = 'made'; } catch (e) { r.ceNS = 'threw'; }
try { document.createElement('div').innerHTML = '<iframe></iframe>'; r.html = 'set'; } catch (e) { r.html = 'threw'; }
try { ELI5.el('div', { onclick: 'x()' }); r.attr = 'set'; } catch (e) { r.attr = 'threw'; }
r.ces = typeof customElements;
try { CustomElementRegistry.prototype.define.call(null, 'x-a', class extends HTMLElement {}); r.define = 'ran'; } catch (e) { r.define = e instanceof TypeError && /ELI5/.test(e.message) ? 'denied' : 'threw'; }
r.metas = String(document.querySelectorAll('meta').length);
try { document.body.cloneNode(true); r.clone = 'made'; } catch (e) { r.clone = 'threw'; }
try { document.importNode(document.createElement('div'), true); r.importDiv = 'ok'; } catch (e) { r.importDiv = 'threw'; }
try { document.implementation.createDocument('http://www.w3.org/1999/xhtml', 'meta'); r.createDoc = 'made'; } catch (e) { r.createDoc = 'threw'; }
r.navigation = typeof navigation;
r.fetch = typeof fetch; r.xhr = typeof XMLHttpRequest; r.ws = typeof WebSocket;
r.rtc = typeof RTCPeerConnection; r.worker = typeof Worker; r.open = typeof open;
try { r.storage = typeof localStorage; } catch (e) { r.storage = 'threw'; }
var img = new Image(); img.src = 'https://leak.example/p.png'; document.body.appendChild(img);
var st = document.createElement('div'); st.style.backgroundImage = 'url(https://leak.example/bg.png)';
document.body.appendChild(st);
document.body.setAttribute('data-probe', JSON.stringify(r));`;

test('a hostile frame cannot read the parent, reach the network or navigate', async ({ context, page }) => {
  const url = hostileDocument(HOSTILE);
  const probe = await instrument(context, page, url);
  // What actually reaches the network layer (Chromium also reports a CSP-blocked image as a
  // 'request' event, which the probe records, though it never leaves the renderer).
  const network: string[] = [];
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u === url || u.startsWith('data:')) return route.continue();
    network.push(u);
    return route.abort('blockedbyclient');
  });
  await open(page, url);
  const frame = frameOf(page);
  const body = frame.locator('body');
  await expect(body).toHaveAttribute('data-probe', /\{/);
  const r = JSON.parse((await body.getAttribute('data-probe')) ?? '{}') as Record<string, string>;
  expect(r).toEqual({
    top: 'SecurityError',
    parent: 'undefined',
    el: 'threw',
    ce: 'threw',
    ceNS: 'threw',
    html: 'threw',
    attr: 'threw',
    // audit round 2: no customized built-in (new F() for a class extending HTMLAnchorElement)
    ces: 'undefined',
    define: 'denied',
    // audit round 3: no meta to copy into a refresh, no copy of a banned element, no Navigation API
    metas: '0',
    clone: 'threw',
    importDiv: 'ok',
    createDoc: 'threw',
    navigation: 'undefined',
    fetch: 'undefined',
    xhr: 'undefined',
    ws: 'undefined',
    rtc: 'undefined',
    worker: 'undefined',
    open: 'undefined',
    storage: 'undefined',
  });
  // The frame trying to navigate the top window, then itself, goes nowhere. (Top first: a blocked
  // self-navigation leaves an engine error page in the frame, which is not the document's code.)
  const topNav = await body.evaluate(() => {
    try {
      (top as Window).location.href = 'https://leak.example/top';
      return 'navigated';
    } catch {
      return 'blocked';
    }
  });
  expect(topNav).toBe('blocked');
  await page.waitForTimeout(300);
  expect(page.url()).toBe(url);
  await body.evaluate(() => {
    location.href = 'https://leak.example/nav';
  });
  await page.waitForTimeout(500);
  expect(page.url()).toBe(url);
  for (const f of page.frames()) expect(f.url()).not.toMatch(/^https?:/);
  expect(network).toEqual([]);
  expect(probe.requests.filter((u) => !u.startsWith('https://leak.example/'))).toEqual([]);
  // The only errors are the engines reporting the blocked top navigation.
  expect(probe.pageErrors.filter((e) => !/sandbox/i.test(e))).toEqual([]);
});

test('a frame whose code throws at start-up keeps the poster', async ({ page }) => {
  const url = hostileDocument("document.body.setAttribute('data-ran', '1'); throw new Error('boom');");
  await open(page, url);
  await expect(frameOf(page).locator('body')).toHaveAttribute('data-ran', '1');
  await page.waitForTimeout(500);
  await expect(figure(page)).not.toHaveClass(/\banim-live\b/);
  await expect(figure(page).locator('.anim-poster svg')).toBeVisible();
});
