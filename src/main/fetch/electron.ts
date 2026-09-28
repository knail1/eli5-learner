import { app, net, session, type IncomingMessage, type Session } from 'electron';
import { log } from '../security';
import { FETCH_PARTITION } from './constants';
import { abortError, classifyNetError, TransportError } from './errors';
import type { FetcherDeps } from './fetcher';
import { clearJobCookies, fetchUserAgent, requestHeaders } from './network';
import { createThreadPool } from './readability-thread';
import { createElectronRenderBackend } from './render-electron';
import { RenderPool, renderInHiddenWindow } from './render-window';
import { RedirectStopped, type HttpTransport } from './transport';
import type { LoginSignature, NetworkConfigurator } from './types';
import { systemLookup } from './url';

/**
 * Production wiring (05 §4.2): Electron `net.request` with redirect: 'manual' on the in-memory
 * `eli5-fetch` session, the worker-thread Readability pool, and the hidden-window backend.
 * Loaded lazily by index.ts after app ready, so unit tests never import Electron.
 */

function bodyOf(res: IncomingMessage, signal: AbortSignal): AsyncIterable<Uint8Array> {
  const queue: Uint8Array[] = [];
  let ended = false;
  let failure: unknown = null;
  let wake: (() => void) | null = null;
  const poke = (): void => {
    wake?.();
    wake = null;
  };
  res.on('data', (c: Buffer) => {
    queue.push(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
    poke();
  });
  res.on('end', () => {
    ended = true;
    poke();
  });
  res.on('aborted', () => {
    failure = signal.aborted ? abortError() : new TransportError('reset', 'ERR_ABORTED');
    poke();
  });
  res.on('error', (e: Error) => {
    failure = signal.aborted ? abortError() : new TransportError(classifyNetError(e.message), e.message);
    poke();
  });
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (failure) throw failure;
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
}

export function electronTransport(ses: Session): HttpTransport {
  return {
    request: (req) =>
      new Promise((resolve, reject) => {
        if (req.signal.aborted) return reject(abortError());
        let current = req.url;
        const cr = net.request({
          url: req.url,
          method: 'GET',
          redirect: 'manual',
          session: ses,
          useSessionCookies: true,
        });
        for (const [k, v] of Object.entries(req.headers)) {
          try {
            cr.setHeader(k, v);
          } catch {
            /* header Chromium manages itself */
          }
        }
        const onAbort = (): void => {
          cr.abort();
          reject(abortError());
        };
        req.signal.addEventListener('abort', onAbort, { once: true });
        // 'redirect' exposes the Location target; the hop proceeds only on followRedirect() (§4.2, §4.4).
        cr.on('redirect', (statusCode, _method, redirectUrl) => {
          req.onRedirect({ statusCode, redirectUrl }).then(
            (follow) => {
              if (follow) {
                current = redirectUrl;
                cr.followRedirect();
              } else {
                cr.abort();
                reject(new RedirectStopped());
              }
            },
            (e: unknown) => {
              cr.abort();
              reject(e);
            },
          );
        });
        cr.on('response', (res) => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers))
            headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
          resolve({ url: current, status: res.statusCode, headers, body: bodyOf(res, req.signal) });
        });
        cr.on('error', (e) => {
          req.signal.removeEventListener('abort', onAbort);
          reject(req.signal.aborted ? abortError() : new TransportError(classifyNetError(e.message), e.message));
        });
        cr.end();
      }),
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
