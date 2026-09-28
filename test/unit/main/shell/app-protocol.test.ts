import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_CSP_PROD } from '../../../../src/main/security';
import {
  APP_ENTRY_URL,
  APP_SCHEME,
  APP_SCHEME_PRIVILEGES,
  createAppProtocolHandler,
  isAppRendererUrl,
} from '../../../../src/main/shell/app-protocol';

/**
 * The app renderer scheme (12 §7.2, §7.8): with GrantFileProtocolExtraPrivileges off, Chromium
 * refuses file:// pages inside app.asar, so builds serve out/renderer over eli5app://app/.
 */

let base: string;
let rendererDir: string;
let handler: (r: Request) => Promise<Response>;
const get = (url: string, method = 'GET') => handler(new Request(url, { method }));

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'eli5-app-proto-')));
  rendererDir = path.join(base, 'renderer');
  await mkdir(path.join(rendererDir, 'assets'), { recursive: true });
  await writeFile(path.join(rendererDir, 'index.html'), '<!doctype html><title>ELI5 Learner</title>');
  await writeFile(path.join(rendererDir, 'assets', 'index-abc.js'), 'console.log(1)');
  await writeFile(path.join(rendererDir, 'assets', 'index-abc.css'), 'body{}');
  await writeFile(path.join(rendererDir, 'assets', '.hidden.js'), 'x');
  await writeFile(path.join(base, 'secret.js'), 'secret');
  await symlink(path.join(base, 'secret.js'), path.join(rendererDir, 'assets', 'escape.js'));
  handler = createAppProtocolHandler({ rendererDir });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('scheme', () => {
  it('is a standard, secure scheme with no CORS and no CSP bypass', () => {
    expect(APP_SCHEME).toBe('eli5app');
    expect(APP_ENTRY_URL).toBe('eli5app://app/index.html');
    expect(APP_SCHEME_PRIVILEGES).toEqual({
      scheme: 'eli5app',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, bypassCSP: false },
    });
  });
});

describe('createAppProtocolHandler', () => {
  it('serves index.html with the prod CSP and nosniff', async () => {
    const res = await get(APP_ENTRY_URL);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(APP_CSP_PROD);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toContain('ELI5 Learner');
  });

  it('serves hashed assets with their MIME types', async () => {
    const js = await get('eli5app://app/assets/index-abc.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    const css = await get('eli5app://app/assets/index-abc.css');
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('answers HEAD without a body and refuses other methods', async () => {
    const head = await get(APP_ENTRY_URL, 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await get(APP_ENTRY_URL, 'POST')).status).toBe(404);
  });

  it.each([
    ['another host', 'eli5app://other/index.html'],
    ['another scheme', 'eli5doc://app/index.html'],
    ['a port', 'eli5app://app:8080/index.html'],
    ['the bare root', 'eli5app://app/'],
    ['a missing file', 'eli5app://app/assets/nope.js'],
    ['an encoded traversal', 'eli5app://app/assets/%2e%2e/%2e%2e/secret.js'],
    ['an encoded slash', 'eli5app://app/assets%2F..%2F..%2Fsecret.js'],
    ['a backslash', 'eli5app://app/assets%5Cindex-abc.js'],
    ['a NUL byte', 'eli5app://app/index.html%00.js'],
    ['a dot file', 'eli5app://app/assets/.hidden.js'],
    ['a symlink out of the root', 'eli5app://app/assets/escape.js'],
    ['a directory', 'eli5app://app/assets'],
    ['an unlisted file type', 'eli5app://app/assets/x.exe'],
  ])('returns 404 for %s', async (_name, url) => {
    const res = await get(url);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('secret');
  });
});

describe('isAppRendererUrl', () => {
  const dev = 'http://localhost:5173';

  it('accepts only the eli5app entry page in builds', () => {
    expect(isAppRendererUrl(new URL(APP_ENTRY_URL), undefined)).toBe(true);
    expect(isAppRendererUrl(new URL('eli5app://app/index.html#/settings'), undefined)).toBe(true);
    for (const u of [
      'eli5app://app/assets/index-abc.js',
      'eli5app://other/index.html',
      'eli5app://app:1/index.html',
      'eli5app://u:p@app/index.html',
      'file:///Applications/ELI5%20Learner.app/Contents/Resources/app.asar/out/renderer/index.html',
      'eli5doc://doc/x/index.html',
      'http://localhost:5173/',
      'https://example.test/index.html',
    ]) {
      expect(isAppRendererUrl(new URL(u), undefined), u).toBe(false);
    }
  });

  it('accepts only the dev server origin when one is set', () => {
    expect(isAppRendererUrl(new URL('http://localhost:5173/'), dev)).toBe(true);
    expect(isAppRendererUrl(new URL('http://localhost:5174/'), dev)).toBe(false);
    expect(isAppRendererUrl(new URL(APP_ENTRY_URL), dev)).toBe(false);
  });
});
