import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VIEWER_CSP } from '../../../../src/main/security';
import { createDocProtocolHandler, DOC_SCHEME, installDocProtocol } from '../../../../src/main/library';

let base: string;
let root: string;
let helpRoot: string;
let handler: (r: Request) => Promise<Response>;
const catalogued = new Set(['widget-pricing', 'escaper', 'dot-link']);

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'eli5-proto-')));
  root = path.join(base, 'docs');
  helpRoot = path.join(base, 'help');
  await mkdir(path.join(root, 'widget-pricing'), { recursive: true });
  await writeFile(path.join(root, 'widget-pricing', 'index.html'), '<h1>Widgets</h1>');
  await writeFile(path.join(root, 'widget-pricing', 'meta.json'), '{"clarifyingInput":"private"}');
  await mkdir(path.join(root, 'uncatalogued'));
  await writeFile(path.join(root, 'uncatalogued', 'index.html'), 'x');
  await mkdir(path.join(root, '.staging', 'job-1'), { recursive: true });
  await writeFile(path.join(root, '.staging', 'job-1', 'index.html'), 'staged');
  await writeFile(path.join(base, 'settings.json'), '{"secret":true}');
  // Symlink escapes: a catalogued folder pointing outside the root, and one pointing at a dot-path.
  await mkdir(path.join(base, 'outside'));
  await writeFile(path.join(base, 'outside', 'index.html'), 'outside');
  await symlink(path.join(base, 'outside'), path.join(root, 'escaper'));
  await symlink(path.join(root, '.staging', 'job-1'), path.join(root, 'dot-link'));
  await mkdir(helpRoot);
  await writeFile(path.join(helpRoot, 'pages-help.html'), '<h1>Help</h1>');
  handler = createDocProtocolHandler({ root, isCatalogued: (s) => catalogued.has(s), helpRoot });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const get = (url: string, method = 'GET') => handler(new Request(url, { method }));

describe('eli5doc:// handler (12 §7.7)', () => {
  it.each(['eli5doc://doc/widget-pricing/index.html', 'eli5doc://doc/widget-pricing/'])(
    'serves %s with the viewer headers',
    async (url) => {
      const res = await get(url);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('<h1>Widgets</h1>');
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('content-security-policy')).toBe(VIEWER_CSP);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toBe('no-store');
    },
  );

  it('serves help pages from the help root', async () => {
    const res = await get('eli5doc://help/pages-help.html');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1>Help</h1>');
    expect(res.headers.get('content-security-policy')).toBe(VIEWER_CSP);
  });

  it('answers HEAD without a body', async () => {
    const res = await get('eli5doc://doc/widget-pricing/index.html', 'HEAD');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it.each([
    ['meta.json', 'eli5doc://doc/widget-pricing/meta.json'],
    ['traversal', 'eli5doc://doc/../settings.json'],
    ['encoded traversal', 'eli5doc://doc/widget-pricing/%2e%2e/%2e%2e/settings.json'],
    ['encoded slash', 'eli5doc://doc/widget-pricing%2Findex.html'],
    ['encoded backslash', 'eli5doc://doc/widget-pricing/..%5C..%5Csettings.json'],
    ['NUL', 'eli5doc://doc/widget-pricing/index.html%00'],
    ['dot-path', 'eli5doc://doc/.staging/job-1/index.html'],
    ['dot-file', 'eli5doc://doc/widget-pricing/.index.html'],
    ['uncatalogued slug', 'eli5doc://doc/uncatalogued/index.html'],
    ['symlink escape', 'eli5doc://doc/escaper/index.html'],
    ['symlink into a dot-path', 'eli5doc://doc/dot-link/index.html'],
    ['folder without slash', 'eli5doc://doc/widget-pricing'],
    ['root', 'eli5doc://doc/'],
    ['double slash', 'eli5doc://doc//widget-pricing/index.html'],
    ['extra segment', 'eli5doc://doc/widget-pricing/index.html/x'],
    ['uppercase slug', 'eli5doc://doc/Widget-Pricing/index.html'],
    ['bad percent-encoding', 'eli5doc://doc/widget-pricing/%E0%A4%A'],
    ['unknown host', 'eli5doc://other/widget-pricing/index.html'],
    ['help traversal', 'eli5doc://help/../docs/widget-pricing/index.html'],
    ['help non-html', 'eli5doc://help/pages-help.txt'],
    ['help missing', 'eli5doc://help/nope.html'],
    ['help nested', 'eli5doc://help/a/pages-help.html'],
    ['port', 'eli5doc://doc:81/widget-pricing/index.html'],
    ['other scheme', 'https://doc/widget-pricing/index.html'],
  ])('404s on %s', async (_n, url) => {
    const res = await get(url);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-security-policy')).toBe(VIEWER_CSP);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('404s on non-GET methods', async () => {
    expect((await get('eli5doc://doc/widget-pricing/index.html', 'POST')).status).toBe(404);
  });

  it('404s on help when no help root is configured', async () => {
    const h = createDocProtocolHandler({ root, isCatalogued: () => true });
    expect((await h(new Request('eli5doc://help/pages-help.html'))).status).toBe(404);
  });

  it('installDocProtocol registers on the given session only and can unregister', () => {
    const calls: string[] = [];
    const session = {
      protocol: {
        handle: (scheme: string) => void calls.push(`handle:${scheme}`),
        unhandle: (scheme: string) => void calls.push(`unhandle:${scheme}`),
      },
    } as unknown as Parameters<typeof installDocProtocol>[0];
    const off = installDocProtocol(session, handler);
    off();
    expect(calls).toEqual([`handle:${DOC_SCHEME}`, `unhandle:${DOC_SCHEME}`]);
  });
});
