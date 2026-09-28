import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { GOLDEN_DIR, GOLDENS } from '../crossbrowser/goldens';
import { Harness, runProbe, type Dirs, type Launched } from './harness';

/**
 * The runtime zero-network probe itself (13 §7.2): it must see a request made by script and a
 * console error, and it must walk every tab and glossary note and cross the glossary breakpoint.
 * The synthetic pages are written at run time; they carry no CSP so a script request reaches the
 * session's webRequest hook. Then every golden document is probed in Electron. The e2e flows call
 * probeDocument on every document they produce (harness `generate`, generate.e2e.ts, m3.e2e.ts).
 * Needs a test build (ELI5_TEST_BUILD=1, `npm run test:e2e`).
 */

test.describe.configure({ mode: 'serial' });

const h = new Harness();
let dirs: Dirs;
let l: Launched;

test.beforeAll(async () => {
  dirs = await h.tempDirs('eli5-e2e-probe-');
  l = await h.launch(dirs);
});
test.afterAll(async () => {
  await h.closeAll();
  await h.cleanup();
});

/** A two-tab page shaped like a document (07 §12), with one glossary note and a script body. */
async function page(name: string, script: string): Promise<string> {
  const file = path.join(dirs.root, `${name}.html`);
  await writeFile(
    file,
    `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body>
<nav class="tabbar"><button role="tab" aria-controls="tab-indepth">In depth</button><button role="tab" aria-controls="tab-eli5">ELI5</button></nav>
<div class="tabpanel" id="tab-indepth" data-tab-key="indepth"><p>Block</p><details class="gl-note"><summary>Term</summary>Note</details></div>
<div class="tabpanel" id="tab-eli5" data-tab-key="eli5" hidden><p>Simple</p></div>
<script>
for (const b of document.querySelectorAll('[role=tab]')) b.addEventListener('click', () => {
  for (const p of document.querySelectorAll('.tabpanel')) p.hidden = 'tab-' + p.dataset.tabKey !== b.getAttribute('aria-controls');
});
const mq = matchMedia('(min-width: 1100px)');
const sync = () => document.documentElement.classList.toggle('gl-wide', mq.matches);
mq.addEventListener('change', sync); sync();
${script}
</script></body></html>`,
  );
  return file;
}

test('a clean page: no requests, no console errors; every tab, every note, both widths', async () => {
  const r = await runProbe(l.app, await page('clean', ''));
  expect(r).toMatchObject({ requests: [], consoleErrors: [], tabs: ['indepth', 'eli5'], notes: 1 });
  expect(r.wide).toEqual([true, false]);
});

test('a request made by script at run time is recorded and cancelled', async () => {
  const r = await runProbe(
    l.app,
    await page(
      'fetches',
      `document.querySelector('[aria-controls=tab-eli5]').addEventListener('click', () => { fetch('http://127.0.0.1:9/beacon').catch(() => {}); });`,
    ),
  );
  // Once per walk: before and after the resize.
  expect(r.requests).toEqual(['http://127.0.0.1:9/beacon', 'http://127.0.0.1:9/beacon']);
});

test('a console error is recorded', async () => {
  const r = await runProbe(l.app, await page('logs', `console.error('boom from the page');`));
  expect(r.consoleErrors).toEqual([expect.stringContaining('boom from the page')]);
});

for (const g of GOLDENS) {
  test(`golden ${g.name}: no request leaves the document and no console error`, async () => {
    const r = await runProbe(l.app, path.join(GOLDEN_DIR, `${g.name}.html`));
    expect(r).toMatchObject({ requests: [], consoleErrors: [] });
    expect(r.tabs.length).toBeGreaterThanOrEqual(2);
  });
}
