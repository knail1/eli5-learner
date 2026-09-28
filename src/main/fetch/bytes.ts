import type { Logger } from '../security';
import { LIMITS, type Limits } from './constants';
import { abortError, httpErrorCode, isAbortError, netKindToSkip, TransportError } from './errors';
import type { Politeness, PoliteSlot } from './politeness';
import { headerMime } from './route';
import { RedirectStopped, type HttpTransport } from './transport';
import type { BytesOutcome, BytesRequest, FetchSkipCode } from './types';
import { isPrivateTarget, logUrl, systemLookup, validateUrl, type HostLookup } from './url';

/**
 * fetchBytes (05 §4.8): a small GET into memory for app-initiated downloads (stock photo search and
 * images, 07 §7.4). Same transport, session, politeness, redirect limit, private-address guard and
 * timeouts as fetchUrl; no HTML routing, no staging files, no render fallback. Never throws except
 * AbortError on `o.signal`.
 */

export interface BytesDeps {
  transport: HttpTransport;
  lookup?: HostLookup;
  /** The fetch session's request headers (05 §4.3); Cookie, Authorization and Referer are never sent. */
  headers: Record<string, string>;
  politeness?: Politeness;
  limits?: Limits;
  log?: Logger;
}

const DROPPED_HEADERS = new Set(['cookie', 'authorization', 'referer', 'user-agent', 'accept']);

/** `ELI5Learner/<version> (desktop explainer app; <purpose>)`, the version taken from the session UA. */
export function descriptiveUserAgent(sessionUa: string | undefined, purpose: string): string {
  const version = /ELI5Learner\/(\S+)/.exec(sessionUa ?? '')?.[1] ?? '0';
  return `ELI5Learner/${version} (desktop explainer app; ${purpose.replace(/[()\r\n]/g, ' ').trim()})`;
}

function requestHeaders(base: Record<string, string>, o: BytesRequest): Record<string, string> {
  const ua = Object.entries(base).find(([k]) => k.toLowerCase() === 'user-agent')?.[1];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (!DROPPED_HEADERS.has(k.toLowerCase())) out[k] = v;
  out['User-Agent'] = o.purpose ? descriptiveUserAgent(ua, o.purpose) : (ua ?? 'ELI5Learner');
  out.Accept = o.accept;
  return out;
}

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

const skip = (code: FetchSkipCode, status?: number): BytesOutcome => ({
  kind: 'skipped',
  code,
  ...(status !== undefined ? { status } : {}),
});

export async function fetchBytes(url: string, deps: BytesDeps, o: BytesRequest): Promise<BytesOutcome> {
  if (o.signal.aborted) throw abortError();
  const limits = deps.limits ?? LIMITS;
  const lookup = deps.lookup ?? systemLookup;
  const v = validateUrl(url.trim());
  if (!v.ok) return skip(v.code);
  const privateCache = new Map<string, boolean>();
  if (await isPrivateTarget(v.url, lookup, privateCache)) return skip('blocked-private-address');

  let slot: PoliteSlot | null = null;
  const ctl = new AbortController();
  const onOuter = (): void => ctl.abort();
  o.signal.addEventListener('abort', onOuter, { once: true });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, ms);
  };
  const hop: { skip: BytesOutcome | null } = { skip: null };
  let hops = 0;
  const seen = new Set<string>([v.href]);
  let drained = false;
  let bodyDeadline: ReturnType<typeof setTimeout> | undefined;

  try {
    if (deps.politeness) {
      slot = await deps.politeness.acquire(v.href, o.signal);
      await slot.beforeRequest(o.signal);
    }
    arm(limits.HTTP_HEADERS_TIMEOUT_MS);
    const res = await deps.transport.request({
      url: v.href,
      headers: requestHeaders(deps.headers, o),
      signal: ctl.signal,
      onRedirect: async (r) => {
        hops += 1;
        const next = validateUrl(r.redirectUrl);
        if (!next.ok) hop.skip = skip(next.code);
        else if (hops > limits.MAX_REDIRECTS || seen.has(next.href)) hop.skip = skip('too-many-redirects');
        else if (await isPrivateTarget(next.url, lookup, privateCache)) hop.skip = skip('blocked-private-address');
        else seen.add(next.href);
        if (hop.skip) return false;
        arm(limits.HTTP_HEADERS_TIMEOUT_MS);
        return true;
      },
    });
    const it = res.body[Symbol.asyncIterator]();
    bodyDeadline = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, limits.HTTP_BODY_TIMEOUT_MS);
    try {
      if (res.status < 200 || res.status >= 300) return skip(httpErrorCode(res.status), res.status);
      const cl = Number(res.headers['content-length']);
      if (Number.isFinite(cl) && cl > o.maxBytes) return skip('too-large', res.status);
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        arm(limits.HTTP_STALL_TIMEOUT_MS);
        const s = await step(it, ctl.signal);
        if (s.done) {
          drained = true;
          break;
        }
        total += s.value.length;
        if (total > o.maxBytes) return skip('too-large', res.status);
        chunks.push(s.value);
      }
      const bytes = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        bytes.set(c, off);
        off += c.length;
      }
      return {
        kind: 'ok',
        status: res.status,
        mime: headerMime(res.headers['content-type']),
        bytes,
        finalUrl: res.url,
      };
    } finally {
      void it.return?.().catch(() => {});
    }
  } catch (e) {
    if (hop.skip) return hop.skip;
    if (e instanceof RedirectStopped) return skip('too-many-redirects');
    if (o.signal.aborted) throw abortError();
    if (timedOut) return skip('timeout');
    if (e instanceof TransportError) return skip(netKindToSkip(e.kind));
    if (isAbortError(e)) return skip('timeout');
    deps.log?.debug('fetch.bytes-failed', {
      sourceRef: logUrl(v.href),
      errorKind: e instanceof Error ? e.name : 'Error',
    });
    return skip('connect-failure');
  } finally {
    clearTimeout(timer);
    clearTimeout(bodyDeadline);
    o.signal.removeEventListener('abort', onOuter);
    if (!drained) ctl.abort();
    slot?.release();
  }
}
