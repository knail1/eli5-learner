import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {
  REDIRECT_STATUSES,
  RedirectStopped,
  toTransportError,
  type HttpTransport,
  type TransportRequest,
} from './transport';

/**
 * HttpTransport over node:http(s), with manual redirects. Used by unit tests against the local
 * fixture server and usable outside Electron; the app itself uses electron.ts (05 §4.2).
 * Plain-http sockets are opened with `socket.connect({ host, port })` so test/helpers/net-guard.ts
 * can see and vet the target.
 */

function stripBrackets(h: string): string {
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function send(url: URL, req: TransportRequest): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const opts: http.RequestOptions = { method: 'GET', headers: req.headers, signal: req.signal };
    if (!isHttps) {
      opts.createConnection = () =>
        new net.Socket().connect({ host: stripBrackets(url.hostname), port: Number(url.port || 80) });
    }
    const r = (isHttps ? https : http).request(url, opts, resolve);
    r.on('error', (e) => reject(toTransportError(e, req.signal)));
    r.end();
  });
}

async function* bodyOf(res: http.IncomingMessage, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of res) yield chunk as Buffer;
  } catch (e) {
    throw toTransportError(e, signal);
  } finally {
    res.destroy();
  }
}

export function nodeTransport(): HttpTransport {
  return {
    async request(req) {
      let url = req.url;
      for (;;) {
        const res = await send(new URL(url), req);
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (REDIRECT_STATUSES.has(status) && location) {
          res.destroy();
          const next = new URL(location, url).href;
          if (!(await req.onRedirect({ statusCode: status, redirectUrl: next }))) throw new RedirectStopped();
          url = next;
          continue;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
        }
        return { url, status, headers, body: bodyOf(res, req.signal) };
      }
    },
  };
}
