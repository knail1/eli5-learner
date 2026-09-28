import { app, net, session, type ClientRequest, type IncomingMessage, type Session } from 'electron';
import { log } from '../security';
import { FETCH_PARTITION } from './constants';
import { abortError, classifyNetError, TransportError } from './errors';
import type { FetcherDeps } from './fetcher';
import { clearJobCookies, fetchUserAgent, requestHeaders } from './network';
import { createThreadPool } from './readability-thread';
import { createElectronRenderBackend } from './render-electron';
import { RenderPool, renderInHiddenWindow } from './render-window';
import { RedirectStopped, type HttpTransport, type TransportRequest } from './transport';
import type { LoginSignature, NetworkConfigurator } from './types';
import { systemLookup } from './url';

/**
 * Production wiring (05 §4.2): Electron `net.request` with redirect: 'manual' on the in-memory
 * `eli5-fetch` session, the worker-thread Readability pool, and the hidden-window backend.
 * Loaded lazily by index.ts after app ready, so unit tests never import Electron.
 */

type Hop =
  | { kind: 'redirect'; statusCode: number; redirectUrl: string }
  | { kind: 'response'; status: number; headers: Record<string, string>; body: AsyncIterable<Uint8Array> };

/**
 * The response body as an iterator whose `return()` (also on a never-started iterator) cancels the
 * request and detaches the listeners, so a fetch that stops reading early stops the download (§4.5).
 */
function bodyOf(
  cr: ClientRequest,
  res: IncomingMessage,
  signal: AbortSignal,
  cleanup: () => void,
): AsyncIterable<Uint8Array> {
  const queue: Uint8Array[] = [];
  let ended = false;
  let closed = false;
  let failure: unknown = null;
  let wake: (() => void) | null = null;
  const poke = (): void => {
    wake?.();
    wake = null;
  };
  const onData = (c: Buffer): void => {
    queue.push(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
    poke();
  };
  const onEnd = (): void => {
    ended = true;
    poke();
  };
  const onAborted = (): void => {
    failure ??= signal.aborted ? abortError() : new TransportError('reset', 'ERR_ABORTED');
    poke();
  };
  const onError = (e: Error): void => {
    failure ??= signal.aborted ? abortError() : new TransportError(classifyNetError(e.message), e.message);
    poke();
  };
  res.on('data', onData);
  res.on('end', onEnd);
  res.on('aborted', onAborted);
  res.on('error', onError);
  const close = (): void => {
    if (closed) return;
    closed = true;
    res.off('data', onData);
    res.off('end', onEnd);
    res.off('aborted', onAborted);
    res.off('error', onError);
    queue.length = 0;
    cleanup();
    if (!ended) cr.abort();
  };
  const iterator: AsyncIterator<Uint8Array> = {
    async next() {
      for (;;) {
        if (closed) return { done: true, value: undefined };
        const next = queue.shift();
        if (next) return { done: false, value: next };
        if (failure) {
          const f = failure;
          close();
          throw f;
        }
        if (ended) {
          close();
          return { done: true, value: undefined };
        }
        await new Promise<void>((r) => (wake = r));
      }
    },
    async return() {
      close();
      return { done: true, value: undefined };
    },
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

/**
 * One ClientRequest. Electron cancels a manual redirect unless followRedirect() runs synchronously
 * inside the 'redirect' event (electron.d.ts, ClientRequest `redirect`), but the per-hop checks
 * (§4.4, DNS lookup) are async. So each hop is its own request: the 'redirect' event aborts this one
 * synchronously and reports the Location target; the caller issues the next request if approved.
 */
function oneHop(ses: Session, url: string, req: TransportRequest): Promise<Hop> {
  return new Promise((resolve, reject) => {
    if (req.signal.aborted) return reject(abortError());
    let settled = false;
    const cr = net.request({ url, method: 'GET', redirect: 'manual', session: ses, useSessionCookies: true });
    for (const [k, v] of Object.entries(req.headers)) {
      try {
        cr.setHeader(k, v);
      } catch {
        /* header Chromium manages itself */
      }
    }
    const onAbort = (): void => {
      cr.abort();
      if (!settled) {
        settled = true;
        reject(abortError());
      }
    };
    const detach = (): void => req.signal.removeEventListener('abort', onAbort);
    req.signal.addEventListener('abort', onAbort, { once: true });
    cr.on('redirect', (statusCode, _method, redirectUrl) => {
      // Stop here, synchronously; the next hop is a fresh request after the async checks.
      detach();
      cr.abort();
      if (settled) return;
      settled = true;
      resolve({ kind: 'redirect', statusCode, redirectUrl });
    });
    cr.on('response', (res) => {
      if (settled) return;
      settled = true;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
      // The abort listener stays attached while the body is read; the body's close() detaches it.
      resolve({ kind: 'response', status: res.statusCode, headers, body: bodyOf(cr, res, req.signal, detach) });
    });
    cr.on('error', (e) => {
      if (settled) return; // e.g. the cancelled redirect, or an error after the body took over
      settled = true;
      detach();
      reject(req.signal.aborted ? abortError() : new TransportError(classifyNetError(e.message), e.message));
    });
    cr.end();
  });
}

export function electronTransport(ses: Session): HttpTransport {
  return {
    async request(req) {
      let url = req.url;
      for (;;) {
        const hop = await oneHop(ses, url, req);
        if (hop.kind === 'response') return { url, status: hop.status, headers: hop.headers, body: hop.body };
        const next = new URL(hop.redirectUrl, url).href;
        if (!(await req.onRedirect({ statusCode: hop.statusCode, redirectUrl: next }))) throw new RedirectStopped();
        if (req.signal.aborted) throw abortError();
        url = next;
      }
    },
  };
}

export interface ElectronFetchOptions {
  configureSession: NetworkConfigurator; // registry.networkConfigurator() (HOOK-FETCH-01)
  loginSignatures: readonly LoginSignature[]; // registry.loginSignatures() (HOOK-FETCH-02)
}

/** Builds FetcherDeps for the running app. Call after app ready. */
export async function createElectronFetchDeps(o: ElectronFetchOptions): Promise<FetcherDeps> {
  const ses = session.fromPartition(FETCH_PARTITION); // no 'persist:' prefix: in memory, cleared on quit
  await o.configureSession(ses);
  const ua = fetchUserAgent(ses.getUserAgent(), app.getVersion());
  const pool = new RenderPool();
  const backend = createElectronRenderBackend({
    pool,
    configureSession: o.configureSession,
    userAgent: ua,
    lookup: systemLookup,
    loginSignatures: o.loginSignatures,
  });
  const readability = createThreadPool();
  return {
    transport: electronTransport(ses),
    headers: requestHeaders(ua, app.getPreferredSystemLanguages()),
    readability: readability.run,
    render: (url, opts) => renderInHiddenWindow(url, opts, { backend, pool }),
    lookup: systemLookup,
    loginSignatures: o.loginSignatures,
    log,
    onJobEnd: () => clearJobCookies(ses),
  };
}
