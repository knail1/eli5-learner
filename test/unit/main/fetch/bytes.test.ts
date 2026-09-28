import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchBytes } from '../../../../src/main/fetch/bytes';
import { Politeness } from '../../../../src/main/fetch/politeness';
import type { HttpTransport, TransportRequest } from '../../../../src/main/fetch/transport';
import { nodeTransport } from '../../../../src/main/fetch/node-transport';
import { startFixtureServer, type FixtureServer } from '../../../helpers/fixture-server';
import { PUBLIC_IP, makeFetcher, testLimits } from './helpers';

/** fetchBytes (05 §4.8): small in-memory GETs for stock photo search and download. */

interface Canned {
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array[];
  redirect?: string;
}

function cannedTransport(table: Record<string, Canned>): HttpTransport & { requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  return {
    requests,
    async request(req) {
      requests.push(req);
      let url = req.url;
      for (let i = 0; i < 5; i++) {
        const c = table[url];
        if (c?.redirect) {
          if (!(await req.onRedirect({ statusCode: 302, redirectUrl: c.redirect }))) {
            const { RedirectStopped } = await import('../../../../src/main/fetch/transport');
            throw new RedirectStopped();
          }
          url = c.redirect;
          continue;
        }
        const chunks = c?.body ?? [];
        async function* gen(): AsyncGenerator<Uint8Array> {
          for (const ch of chunks) yield ch;
        }
        return { url, status: c?.status ?? 404, headers: c?.headers ?? {}, body: gen() };
      }
      throw new Error('loop');
    },
  };
}

const deps = (t: HttpTransport, lookup = async () => [PUBLIC_IP]) => ({
  transport: t,
  lookup,
  headers: { 'User-Agent': 'Mozilla/5.0 TestChromium ELI5Learner/1.2.3', Accept: 'text/html', Cookie: 'x' },
  politeness: new Politeness({ hostIntervalMs: 0 }),
  limits: testLimits(),
});
const opts = (over: Partial<Parameters<typeof fetchBytes>[2]> = {}) => ({
  signal: new AbortController().signal,
  accept: 'application/json',
  maxBytes: 1024,
  ...over,
});

describe('fetchBytes', () => {
  it('returns the body, type and final URL, with a descriptive user agent and no cookies', async () => {
    const t = cannedTransport({
      'https://api.example.test/q': {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: [new TextEncoder().encode('{"a":'), new TextEncoder().encode('1}')],
      },
    });
    const r = await fetchBytes('https://api.example.test/q', deps(t), opts({ purpose: 'stock photo search' }));
    expect(r).toMatchObject({
      kind: 'ok',
      status: 200,
      mime: 'application/json',
      finalUrl: 'https://api.example.test/q',
    });
    expect(r.kind === 'ok' && new TextDecoder().decode(r.bytes)).toBe('{"a":1}');
    const h = t.requests[0]!.headers;
    expect(h['User-Agent']).toBe('ELI5Learner/1.2.3 (desktop explainer app; stock photo search)');
    expect(h.Accept).toBe('application/json');
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('cookie');
  });

  it('refuses invalid URLs, private targets and redirects to private addresses', async () => {
    const t = cannedTransport({
      'https://img.example.test/a.jpg': { redirect: 'http://10.0.0.5/a.jpg' },
    });
    expect(await fetchBytes('ftp://x.test/a', deps(t), opts())).toMatchObject({
      kind: 'skipped',
      code: 'blocked-scheme',
    });
    expect(await fetchBytes('http://localhost/a', deps(t), opts())).toMatchObject({
      kind: 'skipped',
      code: 'blocked-private-address',
    });
    expect(await fetchBytes('https://img.example.test/a.jpg', deps(t), opts())).toMatchObject({
      kind: 'skipped',
      code: 'blocked-private-address',
    });
    const internal = await fetchBytes(
      'https://intranet.example.test/a.jpg',
      deps(t, async () => ['192.168.1.4']),
      opts(),
    );
    expect(internal).toMatchObject({ kind: 'skipped', code: 'blocked-private-address' });
  });

  it('caps the body and maps HTTP errors', async () => {
    const t = cannedTransport({
      'https://img.example.test/big.jpg': {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
        body: [new Uint8Array(800), new Uint8Array(800)],
      },
      'https://img.example.test/declared.jpg': {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '999999' },
        body: [new Uint8Array(10)],
      },
      'https://img.example.test/limited': { status: 429, headers: {} },
    });
    expect(await fetchBytes('https://img.example.test/big.jpg', deps(t), opts())).toMatchObject({
      kind: 'skipped',
      code: 'too-large',
    });
    expect(await fetchBytes('https://img.example.test/declared.jpg', deps(t), opts())).toMatchObject({
      kind: 'skipped',
      code: 'too-large',
    });
    expect(await fetchBytes('https://img.example.test/limited', deps(t), opts())).toMatchObject({
      kind: 'skipped',
      code: 'rate-limited',
      status: 429,
    });
    expect(await fetchBytes('https://img.example.test/missing', deps(t), opts())).toMatchObject({
      kind: 'skipped',
      code: 'http-not-found',
    });
  });

  it('rejects with AbortError when cancelled', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const t = cannedTransport({});
    await expect(fetchBytes('https://api.example.test/q', deps(t), opts({ signal: ctl.signal }))).rejects.toThrow();
  });
});

describe('Fetcher.fetchBytes over a real socket', () => {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await startFixtureServer();
    server.route('/img.jpg', (_req, res) => res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end('jpeg'));
  });
  afterAll(async () => {
    await server.close();
  });

  it('never contacts a loopback address: photo downloads are not user-typed URLs', async () => {
    const f = makeFetcher({ transport: nodeTransport() });
    const r = await f.fetchBytes(server.url('/img.jpg'), opts({ accept: 'image/*' }));
    expect(r).toMatchObject({ kind: 'skipped', code: 'blocked-private-address' });
    expect(server.hits).toEqual([]);
  });
});
