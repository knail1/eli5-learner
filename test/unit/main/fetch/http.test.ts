import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTextAtLeast, httpFetch, metaRefreshTarget } from '../../../../src/main/fetch/http';
import { nodeTransport } from '../../../../src/main/fetch/node-transport';
import type { HttpTransport, TransportRequest } from '../../../../src/main/fetch/transport';
import { startFixtureServer, type FixtureServer } from '../../../helpers/fixture-server';
import { PUBLIC_IP, testLimits, tmpStaging } from './helpers';

/** http.ts in isolation: early-stop cancellation (05 §4.5) and bounded meta-refresh scanning (§4.4 rule 6). */

interface Probe {
  signal: AbortSignal | null;
  returned: boolean;
  pulled: number;
}

/** One 200 response whose body is endless 16 KiB chunks; records cancellation. */
function endlessTransport(headers: Record<string, string>, first?: Uint8Array): HttpTransport & { probe: Probe } {
  const probe: Probe = { signal: null, returned: false, pulled: 0 };
  return {
    probe,
    async request(req: TransportRequest) {
      probe.signal = req.signal;
      const iterator: AsyncIterator<Uint8Array> = {
        async next() {
          probe.pulled += 1;
          return { done: false, value: probe.pulled === 1 && first ? first : new Uint8Array(16 * 1024) };
        },
        async return() {
          probe.returned = true;
          return { done: true, value: undefined };
        },
      };
      return { url: req.url, status: 200, headers, body: { [Symbol.asyncIterator]: () => iterator } };
    },
  };
}

async function run(t: HttpTransport, url = 'https://files.example.test/x') {
  const staging = await tmpStaging();
  try {
    return await httpFetch(
      url,
      { transport: t, lookup: async () => [PUBLIC_IP], headers: {}, loginSignatures: [], limits: testLimits() },
      { jobId: 'job-http', signal: new AbortController().signal, stagingDir: staging.dir, allowPrivate: false },
    );
  } finally {
    await staging.cleanup();
  }
}

describe('httpFetch cancels the download when it stops reading early (§4.5)', () => {
  it('oversized Content-Length: skipped before any body read, request aborted', async () => {
    const t = endlessTransport({ 'content-type': 'application/pdf', 'content-length': String(60 * 1024 * 1024) });
    expect(await run(t)).toMatchObject({ kind: 'skip', code: 'too-large' });
    expect(t.probe.pulled).toBe(0);
    expect(t.probe.returned).toBe(true);
    expect(t.probe.signal?.aborted).toBe(true);
  });

  it('unsupported type after the sniff: request aborted', async () => {
    const t = endlessTransport({ 'content-type': 'video/mp4' });
    expect(await run(t)).toMatchObject({ kind: 'skip', code: 'unsupported-type' });
    expect(t.probe.signal?.aborted).toBe(true);
  });

  it('binary over its cap mid-stream: request aborted', async () => {
    const t = endlessTransport({ 'content-type': 'application/pdf' }, new TextEncoder().encode('%PDF-1.7\n'));
    expect(await run(t)).toMatchObject({ kind: 'skip', code: 'too-large' });
    expect(t.probe.signal?.aborted).toBe(true);
    // ~90 ms alone; the loop to the binary cap starves under a loaded full-suite run (no retries).
  }, 20_000);

  it('a fully read body is not aborted', async () => {
    let signal: AbortSignal | null = null;
    const t: HttpTransport = {
      async request(req) {
        signal = req.signal;
        async function* body() {
          yield new TextEncoder().encode('<html><body><p>Example Widgets Inc.</p></body></html>');
        }
        return { url: req.url, status: 200, headers: { 'content-type': 'text/html' }, body: body() };
      },
    };
    expect(await run(t)).toMatchObject({ kind: 'html' });
    expect((signal as AbortSignal | null)?.aborted).toBe(false);
  });
});

describe('nodeTransport body', () => {
  let server: FixtureServer;
  let closed: Promise<void>;
  beforeAll(async () => {
    server = await startFixtureServer();
    server.route('/endless', (req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(Buffer.alloc(1024)); // never ends
      closed = new Promise((r) => req.socket.once('close', () => r()));
    });
  });
  afterAll(() => server.close());

  it('return() on a never-started body destroys the response', async () => {
    const res = await nodeTransport().request({
      url: server.url('/endless'),
      headers: {},
      signal: new AbortController().signal,
      onRedirect: async () => true,
    });
    const it = res.body[Symbol.asyncIterator]();
    await it.return?.();
    await closed; // the server sees the connection close
    expect((await it.next()).done).toBe(true);
  });
});

describe('meta refresh scan is linear (§4.4 rule 6)', () => {
  const refresh = '<meta http-equiv="refresh" content="0;url=/next">';

  it('still follows a short page and ignores a long one', () => {
    expect(
      metaRefreshTarget(`<html><head>${refresh}</head><body>Moved.</body></html>`, 'https://a.example.test/'),
    ).toBe('https://a.example.test/next');
    const long = `<html><head>${refresh}</head><body><p>${'Example Widgets Inc. '.repeat(300)}</p></body></html>`;
    expect(metaRefreshTarget(long, 'https://a.example.test/')).toBeNull();
    const scripted = `${refresh}<script>${'var x = 1; '.repeat(1000)}</script><style>p{}</style>Moved.`;
    expect(metaRefreshTarget(scripted, 'https://a.example.test/')).toBe('https://a.example.test/next');
  });

  it('text counting skips tags, scripts and styles and collapses whitespace', () => {
    expect(hasTextAtLeast('<p>ab</p>   <b>c</b>', 4)).toBe(true); // "ab c"
    expect(hasTextAtLeast('<p>ab</p>   <b>c</b>', 5)).toBe(false);
    expect(hasTextAtLeast('<script>abcdef</script>ab', 3)).toBe(false);
    expect(hasTextAtLeast('ab<script>never closed', 3)).toBe(false);
  });

  it('hostile markup finishes quickly', () => {
    const inputs = [
      refresh + '<script'.repeat(80_000),
      refresh + '<'.repeat(500_000),
      '<meta http-equiv=refresh '.repeat(2_600),
      refresh + '<style'.repeat(80_000) + '</style>',
    ];
    const t0 = performance.now();
    for (const html of inputs) metaRefreshTarget(html, 'https://a.example.test/');
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});
