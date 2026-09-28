/**
 * `eli5doc://` handler (12 §7.7, 01 §2.1, 09 §9). Pure request -> Response; `installDocProtocol`
 * registers it on the viewer session only.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Session } from 'electron';
import { VIEWER_CSP } from '../security';
import { isValidSlug } from './slug';

export const DOC_SCHEME = 'eli5doc';
const HELP_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.html$/;

export interface DocProtocolDeps {
  /** The realpath'd library root (09 §3.1 step 5). */
  root: string;
  /** True only for slugs in the current catalog (by slug, never by id). */
  isCatalogued(slug: string): boolean;
  /** `resources/help/` from the app bundle; help requests 404 when absent. */
  helpRoot?: string;
}

/** 12 §7.7 step 6; also sent on 404s so no response is ever unconstrained. */
function headers(): Headers {
  return new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': VIEWER_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
}

export function notFound(): Response {
  const h = headers();
  h.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response('Not found', { status: 404, headers: h });
}

/**
 * 12 §7.7 step 2: decoded segments; undefined when any segment is `.`/`..`, holds NUL, a slash or
 * backslash after decoding, starts with `.`, or is empty (a single trailing empty segment is kept
 * so `/<slug>/` can be told apart).
 */
export function decodeSegments(pathname: string): string[] | undefined {
  if (!pathname.startsWith('/')) return undefined;
  const raw = pathname.slice(1).split('/');
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw[i] ?? '');
    } catch {
      return undefined;
    }
    const last = i === raw.length - 1;
    if (seg === '' && !(last && i > 0)) return undefined;
    if (seg.startsWith('.') || /[\0/\\]/.test(seg)) return undefined;
    out.push(seg);
  }
  return out;
}

/** Realpath inside `root` (not `root` itself) with no dot segment on the way; else undefined. */
async function containedFile(root: string, rel: string[]): Promise<string | undefined> {
  const target = path.resolve(root, ...rel);
  let real: string;
  try {
    real = await fsp.realpath(target);
  } catch {
    return undefined;
  }
  if (!real.startsWith(root + path.sep)) return undefined;
  if (
    path
      .relative(root, real)
      .split(path.sep)
      .some((s) => s.startsWith('.'))
  )
    return undefined;
  const st = await fsp.stat(real).catch(() => undefined);
  return st?.isFile() ? real : undefined;
}

async function serve(file: string, head: boolean): Promise<Response> {
  try {
    const body = head ? null : await fsp.readFile(file);
    return new Response(body, { status: 200, headers: headers() });
  } catch {
    return notFound();
  }
}

export function createDocProtocolHandler(deps: DocProtocolDeps): (request: Request) => Promise<Response> {
  const helpRootReal = deps.helpRoot ? fsp.realpath(deps.helpRoot).catch(() => undefined) : undefined;
  return async (request) => {
    const head = request.method === 'HEAD';
    if (request.method !== 'GET' && !head) return notFound();
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    if (url.protocol !== `${DOC_SCHEME}:` || url.username !== '' || url.password !== '' || url.port !== '') {
      return notFound();
    }
    const segs = decodeSegments(url.pathname);
    if (!segs) return notFound();

    if (url.hostname === 'doc') {
      // Exactly /<slug>/ or /<slug>/index.html, and only catalogued slugs (12 §7.7 step 3).
      const [slug, file, ...rest] = segs;
      if (slug === undefined || rest.length > 0) return notFound();
      if (file !== '' && file !== 'index.html') return notFound();
      if (!isValidSlug(slug) || !deps.isCatalogued(slug)) return notFound();
      const real = await containedFile(deps.root, [slug, 'index.html']);
      return real ? serve(real, head) : notFound();
    }

    if (url.hostname === 'help') {
      // A single segment naming an .html file in resources/help/ (12 §7.7 step 4).
      const [file, ...rest] = segs;
      const helpRoot = await helpRootReal;
      if (!helpRoot || file === undefined || rest.length > 0 || !HELP_FILE.test(file)) return notFound();
      const real = await containedFile(helpRoot, [file]);
      return real ? serve(real, head) : notFound();
    }

    return notFound();
  };
}

/** Registers the handler on one session (the viewer's `eli5-viewer` partition, 12 §7.7 step 2). */
export function installDocProtocol(
  session: Pick<Session, 'protocol'>,
  handler: (request: Request) => Promise<Response>,
): () => void {
  session.protocol.handle(DOC_SCHEME, handler);
  return () => session.protocol.unhandle(DOC_SCHEME);
}
