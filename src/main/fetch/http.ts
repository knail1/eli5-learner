import { randomBytes } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../security';
import { LIMITS, type Limits } from './constants';
import {
  abortError,
  isAbortError,
  netKindToSkip,
  TransportError,
  type NetErrorKind,
  type ReasonDetail,
} from './errors';
import { isLoginHop } from './login-wall';
import { declaredCap, decodeBody, effectiveMime, filenameFor, headerMime, routeMime } from './route';
import { RedirectStopped, type HttpTransport } from './transport';
import type { FetchedBinary, FetchSkipCode, LoginSignature } from './types';
import { isPrivateTarget, logUrl, validateUrl, type HostLookup } from './url';

/** Plain HTTP GET: redirects, private-address guard, timeouts, caps, sniffing, decoding (05 §4). */

export interface HttpDeps {
  transport: HttpTransport;
  lookup: HostLookup;
  headers: Record<string, string>; // §4.3 request headers (never Authorization or Cookie)
  loginSignatures: readonly LoginSignature[];
  limits?: Limits;
  log?: Logger;
  randomId?: () => string;
}

export interface HttpOptions {
  jobId: string;
  signal: AbortSignal; // job + budget; an abort rethrows AbortError
  stagingDir: string;
  allowPrivate: boolean; // the user-typed URL itself is private/loopback (§4.4 rule 4)
}

export type HttpResult =
  | {
      kind: 'html';
      status: number;
      finalUrl: string;
      headers: Record<string, string>;
      html: string;
      truncated: boolean;
    }
  | { kind: 'binary'; content: FetchedBinary }
  | { kind: 'http-error'; status: number; finalUrl: string; headers: Record<string, string>; html: string | null }
  | { kind: 'skip'; code: FetchSkipCode; detail: ReasonDetail; finalUrl?: string; netKind?: NetErrorKind };

const MAX_ERROR_BODY = 256 * 1024;

/** Races an iterator step against an abort (fake transports may ignore the signal). */
function step<T>(it: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    it.next().then(
      (r) => {
        signal.removeEventListener('abort', onAbort);
        resolve(r);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** The first `<meta http-equiv=refresh>` tag in `head`; a linear scan (a single backtracking regex is quadratic). */
function findMetaRefresh(head: string): string | null {
  const open = /<meta\b/gi;
  for (let m = open.exec(head); m; m = open.exec(head)) {
    const end = head.indexOf('>', m.index);
    if (end < 0) return null;
    const tag = head.slice(m.index, end + 1);
    // Real meta tags are short; bounding the tag bounds the attribute regexes below.
    if (tag.length <= 4096 && /\bhttp-equiv\s*=\s*["']?refresh\b/i.test(tag)) return tag;
    open.lastIndex = end + 1;
  }
  return null;
}

const RAW_TEXT_OPEN = /<(script|style)\b/iy;

/**
 * Whether the visible text (tags, script and style removed, whitespace runs collapsed) reaches
 * `limit` characters. One linear pass that stops at `limit`: no backtracking regexes over the body,
 * so hostile markup cannot stall the main thread (05 §4.4 rule 6; the DOM is only parsed in the worker).
 */
export function hasTextAtLeast(html: string, limit: number): boolean {
  let n = 0;
  let i = 0;
  let space = false;
  let noMoreGt = false; // once a '>' search fails, none exists further on
  while (i < html.length) {
    const c = html.charCodeAt(i);
    if (c === 60 /* < */ && !noMoreGt) {
      RAW_TEXT_OPEN.lastIndex = i;
      const raw = RAW_TEXT_OPEN.exec(html)?.[1]?.toLowerCase();
      if (raw) {
        const close = new RegExp(`</${raw}`, 'gi');
        close.lastIndex = i;
        const m = close.exec(html);
        const end = m ? html.indexOf('>', m.index + m[0].length) : -1;
        if (end < 0) return false; // unclosed script/style runs to the end
        i = end + 1;
        continue;
      }
      const gt = html.indexOf('>', i + 1);
      if (gt < 0) noMoreGt = true;
      else {
        i = gt + 1;
        continue;
      }
    }
    const ws = c === 32 || (c >= 9 && c <= 13);
    if (!ws || !space) n += 1;
    space = ws;
    if (n >= limit) return true;
    i += 1;
  }
  return false;
}

/** §4.4 rule 6: a meta refresh with delay <= 5 s in a body with < 4 KB of text is one more hop. */
export function metaRefreshTarget(html: string, base: string, limits: Limits = LIMITS): string | null {
  const tag = findMetaRefresh(html.slice(0, 64 * 1024));
  if (!tag) return null;
  const content = /content\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
  const m = /^\s*(\d+(?:\.\d+)?)\s*[;,]\s*url\s*=\s*['"]?([^'"]+)/i.exec(content?.[2] ?? content?.[3] ?? '');
  if (!m?.[1] || !m[2] || Number(m[1]) > limits.META_REFRESH_MAX_DELAY_S) return null;
  if (hasTextAtLeast(html, limits.META_REFRESH_MAX_TEXT)) return null;
  try {
    return new URL(m[2].trim(), base).href;
  } catch {
    return null;
  }
}

export async function httpFetch(startUrl: string, deps: HttpDeps, opts: HttpOptions): Promise<HttpResult> {
  const limits = deps.limits ?? LIMITS;
  const seen = new Set<string>([startUrl]);
  let hops = 0;
  let url = startUrl;
  const privateCache = new Map<string, boolean>();

  /** Per-hop checks (§4.4 rules 1–5). Returns a skip, or null to follow. */
  const checkHop = async (target: string): Promise<HttpResult | null> => {
    hops += 1;
    const v = validateUrl(target);
    if (!v.ok) return { kind: 'skip', code: v.code, detail: {}, finalUrl: target };
    if (hops > limits.MAX_REDIRECTS || seen.has(v.href)) {
      return { kind: 'skip', code: 'too-many-redirects', detail: {}, finalUrl: v.href };
    }
    seen.add(v.href);
    if (new URL(url).protocol === 'https:' && v.url.protocol === 'http:') {
      deps.log?.debug('fetch.https-downgrade', { jobId: opts.jobId, sourceRef: logUrl(v.href) });
    }
    if (!opts.allowPrivate && (await isPrivateTarget(v.url, deps.lookup, privateCache))) {
      return { kind: 'skip', code: 'blocked-private-address', detail: {}, finalUrl: v.href };
    }
    if (isLoginHop(v.href, startUrl, deps.loginSignatures)) {
      return { kind: 'skip', code: 'login-required', detail: {}, finalUrl: v.href };
    }
    url = v.href;
    return null;
  };

  for (;;) {
    const r = await oneRequest(url, checkHop, deps, opts, limits);
    if (r.kind === 'html' && r.status >= 200 && r.status < 300) {
      const target = metaRefreshTarget(r.html, r.finalUrl, limits);
      if (target) {
        url = r.finalUrl;
        const stop = await checkHop(target);
        if (stop) return stop;
        continue;
      }
    }
    return r;
  }
}

async function oneRequest(
  reqUrl: string,
  checkHop: (target: string) => Promise<HttpResult | null>,
  deps: HttpDeps,
  opts: HttpOptions,
  limits: Limits,
): Promise<HttpResult> {
  const ctl = new AbortController();
  const onOuter = (): void => ctl.abort();
  opts.signal.addEventListener('abort', onOuter, { once: true });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, ms);
  };
  const hop: { skip: HttpResult | null } = { skip: null };
  let drained = false; // the body was read to its end; otherwise the request is cancelled (§4.5 steps 1–2)
  let partialFile: string | null = null;

  try {
    if (opts.signal.aborted) throw abortError();
    arm(limits.HTTP_HEADERS_TIMEOUT_MS);
    const res = await deps.transport.request({
      url: reqUrl,
      headers: { ...deps.headers },
      signal: ctl.signal,
      onRedirect: async (r) => {
        hop.skip = await checkHop(r.redirectUrl);
        if (!hop.skip) arm(limits.HTTP_HEADERS_TIMEOUT_MS); // each hop gets its own headers window
        return hop.skip === null;
      },
    });
    const finalUrl = res.url;
    const it = res.body[Symbol.asyncIterator]();
    const bodyDeadline = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, limits.HTTP_BODY_TIMEOUT_MS);
    try {
      const next = (): Promise<IteratorResult<Uint8Array>> => {
        arm(limits.HTTP_STALL_TIMEOUT_MS);
        return step(it, ctl.signal).then((s) => {
          if (s.done) drained = true;
          return s;
        });
      };
      const declared = headerMime(res.headers['content-type']);
      const ok = res.status >= 200 && res.status < 300;

      if (!ok) {
        // Non-2xx: keep a small HTML body for login-wall / challenge checks (§3 step 5, §7.1).
        let html: string | null = null;
        if (declared === 'text/html' || declared === 'application/xhtml+xml' || declared === '') {
          const chunks: Uint8Array[] = [];
          let total = 0;
          for (let s = await next(); !s.done && total < MAX_ERROR_BODY; s = await next()) {
            chunks.push(s.value);
            total += s.value.length;
          }
          html = decodeBody(concat(chunks, total), res.headers['content-type']);
        }
        return { kind: 'http-error', status: res.status, finalUrl, headers: res.headers, html };
      }

      // §4.5 step 1: Content-Length over the declared type's cap aborts before the body is read.
      const cl = Number(res.headers['content-length']);
      const preCap = declaredCap(declared, limits);
      if (preCap !== null && Number.isFinite(cl) && cl > preCap) {
        return { kind: 'skip', code: 'too-large', detail: { limitBytes: preCap }, finalUrl };
      }

      // Sniff from at most the first 4 KiB (§4.5 step 2, §4.6).
      const head: Uint8Array[] = [];
      let headLen = 0;
      let done = false;
      while (headLen < limits.SNIFF_BYTES) {
        const s = await next();
        if (s.done) {
          done = true;
          break;
        }
        head.push(s.value);
        headLen += s.value.length;
      }
      const cd = res.headers['content-disposition'];
      const nameHint = filenameFor(cd, finalUrl, declared);
      const mime = effectiveMime(declared, concat(head, headLen), nameHint);
      const route = routeMime(mime, limits);

      if (route.lane === 'unsupported') {
        return { kind: 'skip', code: 'unsupported-type', detail: { mime: route.mime }, finalUrl };
      }

      if (route.lane === 'html') {
        const chunks = head;
        let total = headLen;
        let truncated = false;
        while (!done) {
          const s = await next();
          if (s.done) break;
          if (total + s.value.length > limits.MAX_HTML_BYTES) {
            // §4.5 step 3: keep the prefix when at least MIN_HTML_PREFIX_BYTES were read.
            chunks.push(s.value.subarray(0, limits.MAX_HTML_BYTES - total));
            total = limits.MAX_HTML_BYTES;
            truncated = true;
            break;
          }
          chunks.push(s.value);
          total += s.value.length;
        }
        if (truncated && total < limits.MIN_HTML_PREFIX_BYTES) {
          return { kind: 'skip', code: 'too-large', detail: { limitBytes: limits.MAX_HTML_BYTES }, finalUrl };
        }
        if (truncated) deps.log?.debug('fetch.html-truncated', { jobId: opts.jobId, bytes: total });
        const html = decodeBody(concat(chunks, total), res.headers['content-type']);
        return { kind: 'html', status: res.status, finalUrl, headers: res.headers, html, truncated };
      }

      // Binary (and SVG-as-text): stream into stagingDir with 'wx'; partial files are deleted.
      const outMime = route.lane === 'svg' ? 'text/plain' : route.mime;
      const filename = filenameFor(cd, finalUrl, route.lane === 'svg' ? 'image/svg+xml' : route.mime);
      await mkdir(opts.stagingDir, { recursive: true });
      const id = deps.randomId?.() ?? randomBytes(6).toString('hex');
      const file = path.join(opts.stagingDir, `${id}-${filename}`);
      partialFile = file;
      const fh = await open(file, 'wx');
      let size = 0;
      try {
        const write = async (b: Uint8Array): Promise<boolean> => {
          size += b.length;
          if (size > route.capBytes) return false;
          await fh.write(b);
          return true;
        };
        let within = true;
        for (const b of head) within = within && (await write(b));
        while (within && !done) {
          const s = await next();
          if (s.done) break;
          within = await write(s.value);
        }
        if (!within) {
          const unsupportedSvg = route.lane === 'svg';
          return unsupportedSvg
            ? { kind: 'skip', code: 'unsupported-type', detail: { mime: 'image/svg+xml' }, finalUrl }
            : { kind: 'skip', code: 'too-large', detail: { limitBytes: route.capBytes }, finalUrl };
        }
      } finally {
        await fh.close();
      }
      partialFile = null;
      return {
        kind: 'binary',
        content: { requestedUrl: '', finalUrl, mime: outMime, filename, path: file, sizeBytes: size },
      };
    } finally {
      clearTimeout(bodyDeadline);
      void it.return?.().catch(() => {});
    }
  } catch (e) {
    if (hop.skip) return hop.skip;
    if (e instanceof RedirectStopped) return hop.skip ?? { kind: 'skip', code: 'too-many-redirects', detail: {} };
    if (opts.signal.aborted) throw abortError();
    if (timedOut) return { kind: 'skip', code: 'timeout', detail: {}, finalUrl: reqUrl };
    if (e instanceof TransportError) {
      return { kind: 'skip', code: netKindToSkip(e.kind), detail: {}, finalUrl: reqUrl, netKind: e.kind };
    }
    if (isAbortError(e)) return { kind: 'skip', code: 'timeout', detail: {}, finalUrl: reqUrl };
    throw e;
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', onOuter);
    // Stopped reading early (cap, unsupported type, truncation, error-body cap): cancel the download.
    // Timers are already cleared, so this is not counted as a timeout.
    if (!drained) ctl.abort();
    if (partialFile) await rm(partialFile, { force: true }).catch(() => {});
  }
}
