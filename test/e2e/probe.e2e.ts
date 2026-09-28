import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { GOLDEN_DIR, GOLDENS } from '../crossbrowser/goldens';
import { Harness, type Launched } from './harness';
import { probeDocument } from './probe';

/**
 * Runtime rule, zero network requests (13 §7.2), in Electron: probeDocument on every golden. The
 * canary proves the probe records a document's requests and console errors at all. The e2e flows
 * call probeDocument on every document they produce (generate.e2e.ts, m3.e2e.ts).
 */
const h = new Harness();
let l: Launched;

test.beforeAll(async () => {
  l = await h.launch(await h.tempDirs('eli5-e2e-probe-'));
});

test.afterAll(async () => {
  await h.closeAll();
  await h.cleanup();
});

test('canary: the probe records and cancels requests and records console errors', async () => {
  const dirs = await h.tempDirs('eli5-e2e-probe-canary-');
  await mkdir(dirs.root, { recursive: true });
  const file = path.join(dirs.root, 'leaky.html');
  await writeFile(
    file,
    '<!doctype html><html><head><title>leaky</title></head><body>' +
      '<img src="https://example.invalid/pixel.png" alt="">' +
      '<script>fetch("https://example.invalid/beacon").catch(function(){});console.error("canary")</script>' +
      '</body></html>',
  );
  const r = await probeDocument(l.app, file);
  expect(r.requests).toEqual(
    expect.arrayContaining(['https://example.invalid/pixel.png', 'https://example.invalid/beacon']),
  );
  expect(r.consoleErrors).toEqual(expect.arrayContaining([expect.stringContaining('canary')]));
});

for (const g of GOLDENS) {
  test(`${g.name}: no request leaves the document and no console error`, async () => {
    const r = await probeDocument(l.app, path.join(GOLDEN_DIR, `${g.name}.html`));
    expect(r).toEqual({ booted: true, tabs: expect.any(Number), requests: [], consoleErrors: [] });
    expect(r.tabs).toBeGreaterThanOrEqual(2);
  });
}
