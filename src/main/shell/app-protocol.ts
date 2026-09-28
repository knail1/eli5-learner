/**
 * App renderer scheme (12 §7.2, §7.8). The GrantFileProtocolExtraPrivileges fuse is off, so
 * Chromium refuses file:// pages inside app.asar; builds load out/renderer from
 * `eli5app://app/index.html` instead. Pure request -> Response with no runtime electron import;
 * bootstrap registers it on the default session, the app renderer's session.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { CustomScheme } from 'electron';
import { APP_CSP_PROD } from '../security';

export const APP_SCHEME = 'eli5app';
const APP_HOST = 'app';
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

/** Pass to protocol.registerSchemesAsPrivileged before ready (12 §7.7): 'self' is eli5app://app. */
export const APP_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, bypassCSP: false },
};

/** The file types electron-vite emits for the renderer; anything else is 404. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function headers(type: string): Headers {
  return new Headers({
    'Content-Type': type,
    'Content-Security-Policy': APP_CSP_PROD,
    'X-Content-Type-Options': 'nosniff',
  });
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: headers('text/plain; charset=utf-8') });
}

/** Decoded path segments, or undefined for empty, dot-leading, NUL, slash or backslash segments. */
function segments(pathname: string): string[] | undefined {
  const out: string[] = [];
  for (const raw of pathname.replace(/^\//, '').split('/')) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (seg === '' || seg.startsWith('.') || /[\0/\\]/.test(seg)) return undefined;
    out.push(seg);
  }
  return out;
}

function isAppHost(url: URL): boolean {
  return (
    url.protocol === `${APP_SCHEME}:` &&
    url.hostname === APP_HOST &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  );
}

/**
 * The IPC sender and navigation guard's app origin (12 §7.2 steps 3 and 6): the dev server origin
 * in dev, else exactly the eli5app entry page (fragments allowed).
 */
export function isAppRendererUrl(url: URL, devServerUrl: string | undefined): boolean {
  if (devServerUrl) return url.origin === new URL(devServerUrl).origin;
  return isAppHost(url) && url.pathname === '/index.html';
}

export interface AppProtocolDeps {
  /** out/renderer (inside app.asar when packaged). */
  rendererDir: string;
}

/** Serves files under rendererDir only; realpath containment stops symlink escapes (as 12 §7.7 step 5). */
export function createAppProtocolHandler(deps: AppProtocolDeps): (request: Request) => Promise<Response> {
  const rootReal = fsp.realpath(deps.rendererDir).catch(() => undefined);
  return async (request) => {
    const head = request.method === 'HEAD';
    if (request.method !== 'GET' && !head) return notFound();
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    if (!isAppHost(url)) return notFound();
    const segs = segments(url.pathname);
    const type = segs && MIME[path.extname(segs.at(-1) ?? '').toLowerCase()];
    const root = await rootReal;
    if (!segs || !type || !root) return notFound();
    let real: string;
    try {
      real = await fsp.realpath(path.resolve(root, ...segs));
      if (!real.startsWith(root + path.sep) || !(await fsp.stat(real)).isFile()) return notFound();
      const body = head ? null : await fsp.readFile(real);
      return new Response(body, { status: 200, headers: headers(type) });
    } catch {
      return notFound();
    }
  };
}
