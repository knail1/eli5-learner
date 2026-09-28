import { readFile, readdir } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderOptions, RenderResult } from '../../../../src/main/fetch/render-window';
import type { HttpTransport } from '../../../../src/main/fetch/transport';
import type { FetchOutcome } from '../../../../src/main/fetch/types';
import { startFixtureServer, syntheticZip, type FixtureServer } from '../../../helpers/fixture-server';
import { articleHtml, ctxFor, makeFetcher, testLimits, tmpStaging } from './helpers';

/** 05 §13 fixture table, against the local fixture server (13 §6.4). */

let server: FixtureServer;
let staging: { dir: string; cleanup: () => Promise<void> };

beforeAll(async () => {
  server = await startFixtureServer({ slowMs: 5_000 });
  const html = (body: string, status = 200, extra: Record<string, string> = {}) =>
    ((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...extra }).end(body);
    }) as Parameters<FixtureServer['route']>[1];

  server.route('/auth/basic', html('<p>no</p>', 401, { 'WWW-Authenticate': 'Basic realm="x"' }));
  server.route('/proxy-auth', html('<p>no</p>', 407));
  server.route('/members/', (_req, res) => res.writeHead(302, { Location: '/login?returnUrl=%2Fmembers%2F' }).end());
  server.route('/login', html('<title>Sign in</title><form><input type="password"></form>'));
  server.route('/binary/report.pdf', (_req, res) =>
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(Buffer.from('%PDF-1.4\n% synthetic\n')),
  );
  server.route('/images/chart', (_req, res) =>
    res
      .writeHead(200, { 'Content-Type': 'image/png' })
      .end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])),
  );
  server.route('/download', (_req, res) =>
    res
      .writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="Quarterly Plan.docx"',
      })
      .end(syntheticZip()),
  );
  server.route('/latin1', (_req, res) =>
    res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(
        Buffer.from(
          '<!doctype html><html><head><meta charset="iso-8859-1"><title>Café crème</title></head><body><p>Café</p></body></html>',
          'latin1',
        ),
      ),
  );
  server.route('/huge.pdf', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': String(60 * 1024 * 1024) });
    res.write('%PDF-1.4\n'); // the rest never comes; the fetch must not wait for it
  });
  server.route('/big-html', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.write(articleHtml('Big Page', 10).replace('</body></html>', ''));
    res.end(`<div>${'x'.repeat(1024 * 1024)}</div></body></html>`);
  });
  server.route('/clip.mp4', (_req, res) => res.writeHead(200, { 'Content-Type': 'video/mp4' }).end(Buffer.alloc(64)));
  let limited = 0;
  server.route('/rate-limited/', (_req, res) => {
    limited += 1;
    if (limited === 1) res.writeHead(429, { 'Retry-After': '1', 'Content-Type': 'text/plain' }).end('slow down');
    else res.writeHead(200, { 'Content-Type': 'text/html' }).end(articleHtml('After The Wait'));
  });
  const challenge =
    '<!doctype html><html><head><title>Just a moment...</title></head><body><div id="challenge-form">Checking</div></body></html>';
  server.route('/challenge/', html(challenge, 403));
  server.route('/forbidden/', html('<!doctype html><title>Forbidden</title><p>Forbidden</p>', 403));
  server.route('/gone', html('gone', 410));
  let fiveHundreds = 0;
  server.route('/broken', (_req, res) => {
    fiveHundreds += 1;
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('oops');
  });
  server.route('/logo.svg', (_req, res) =>
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  );
  server.route('/count-500s', (_req, res) =>
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(String(fiveHundreds)),
  );
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  staging = await tmpStaging();
});
afterEach(async () => {
  await staging.cleanup();
});

const hitsFor = (p: string) => server.hits.filter((h) => h.path === p);

function expectSkip(o: FetchOutcome, code: string) {
  expect(o.kind).toBe('skipped');
  if (o.kind === 'skipped') expect(o.code).toBe(code);
  return o as Extract<FetchOutcome, { kind: 'skipped' }>;
}

describe('fetchUrl against the fixture server (05 §13)', () => {
  it('static article → article via http with metadata, sanitized HTML and honest headers', async () => {
    const f = makeFetcher();
    const out = await f.fetchUrl(server.url('/article/'), ctxFor(staging.dir));
    expect(out.kind).toBe('article');
    if (out.kind !== 'article') return;
    const a = out.content;
    expect(a.via).toBe('http');
    expect(a.title).toBe('Example Widgets Inc. Opens a Solar-Powered Widget Plant');
    expect(a.byline).toContain('Jordan Sample');
    expect(a.publishedTime).toBe('2026-03-14T09:30:00Z');
    expect(a.textLength).toBeGreaterThanOrEqual(1500);
    expect(a.contentHtml).not.toMatch(/<script/i);
    expect(a.contentHtml).toContain('<table');
    expect(a.imageUrls).toEqual([server.url('/images/plant-large.jpg')]);
    expect(a.requestedUrl).toBe(server.url('/article/'));
    expect(a.finalUrl).toBe(server.url('/article/'));

    const hit = hitsFor('/article/').at(-1)!;
    expect(hit.headers['user-agent']).toMatch(/ELI5Learner\//);
    expect(hit.headers['dnt']).toBe('1');
    expect(hit.headers['sec-gpc']).toBe('1');
    expect(hit.headers['accept']).toContain('text/html');
    expect(hit.headers['accept-language']).toContain('en-US');
    expect(hit.headers['authorization']).toBeUndefined();
    expect(hit.headers['cookie']).toBeUndefined();
    expect(hit.headers['referer']).toBeUndefined();
  });

  it('SPA shell → render fallback → article via render', async () => {
    const render = vi.fn(async (url: string, _o: RenderOptions): Promise<RenderResult> => ({
      ok: true,
      html: articleHtml('The Widget Catalog, Explained'),
      finalUrl: url,
      timedOut: false,
    }));
    const progress: string[] = [];
    const f = makeFetcher({ render });
    const out = await f.fetchUrl(server.url('/spa/'), {
      ...ctxFor(staging.dir),
      onProgress: (p) => progress.push(p.phase),
    });
    expect(render).toHaveBeenCalledOnce();
    expect(render.mock.calls[0]![1].allowPrivate).toBe(true); // user-typed loopback
    expect(render.mock.calls[0]![1].timeoutMs).toBeLessThanOrEqual(20_000);
    expect(out.kind).toBe('article');
    if (out.kind === 'article') expect(out.content.via).toBe('render');
    expect(progress).toEqual(['http', 'extract', 'render', 'extract']);
  });

  it('SPA that renders nothing → empty-content', async () => {
    const shell = await readFile(new URL('../../../fixtures/sites/spa/index.html', import.meta.url), 'utf8');
    const f = makeFetcher({ render: async (url) => ({ ok: true, html: shell, finalUrl: url, timedOut: false }) });
    const o = expectSkip(await f.fetchUrl(server.url('/spa/'), ctxFor(staging.dir)), 'empty-content');
    expect(o.reason).toBe('page had no readable content');
  });

  it('client-rendered page without a render lane → render-failed', async () => {
    const f = makeFetcher();
    expectSkip(await f.fetchUrl(server.url('/spa/'), ctxFor(staging.dir)), 'render-failed');
  });

  it('render skipped when the remaining budget is under RENDER_MIN_BUDGET_MS → timeout', async () => {
    const render = vi.fn();
    const f = makeFetcher({ render, limits: testLimits({ URL_TOTAL_BUDGET_MS: 10_000 }) });
    expectSkip(await f.fetchUrl(server.url('/spa/'), ctxFor(staging.dir)), 'timeout');
    expect(render).not.toHaveBeenCalled();
  });

  it('401 with WWW-Authenticate → login-required, no render attempted', async () => {
    const render = vi.fn();
    const f = makeFetcher({ render });
    const o = expectSkip(await f.fetchUrl(server.url('/auth/basic'), ctxFor(staging.dir)), 'login-required');
    expect(o.reason).toBe('page required login');
    expect(render).not.toHaveBeenCalled();
  });

  it('407 → login-required with the proxy reason', async () => {
    const o = expectSkip(
      await makeFetcher().fetchUrl(server.url('/proxy-auth'), ctxFor(staging.dir)),
      'login-required',
    );
    expect(o.reason).toBe('network proxy requires sign-in');
  });

  it('302 → /login?returnUrl=… → login-required with finalUrl = login URL, login page never fetched', async () => {
    const before = hitsFor('/login?returnUrl=%2Fmembers%2F').length;
    const o = expectSkip(await makeFetcher().fetchUrl(server.url('/members/'), ctxFor(staging.dir)), 'login-required');
    expect(o.finalUrl).toBe(server.url('/login?returnUrl=%2Fmembers%2F'));
    expect(hitsFor('/login?returnUrl=%2Fmembers%2F').length).toBe(before);
  });

  it('page with a password form → login-required', async () => {
    expectSkip(await makeFetcher().fetchUrl(server.url('/login-wall/'), ctxFor(staging.dir)), 'login-required');
  });

  it('paywall teaser → paywall', async () => {
    const o = expectSkip(await makeFetcher().fetchUrl(server.url('/paywall/'), ctxFor(staging.dir)), 'paywall');
    expect(o.reason).toBe('page required a subscription');
  });

  it('PDF served as application/octet-stream → binary, sniffed application/pdf, written under stagingDir', async () => {
    const out = await makeFetcher().fetchUrl(server.url('/binary/report.pdf'), ctxFor(staging.dir));
    expect(out.kind).toBe('binary');
    if (out.kind !== 'binary') return;
    expect(out.content.mime).toBe('application/pdf');
    expect(out.content.filename).toBe('report.pdf');
    expect(out.content.path.startsWith(staging.dir)).toBe(true);
    expect((await readFile(out.content.path)).subarray(0, 5).toString()).toBe('%PDF-');
    expect(out.content.sizeBytes).toBe(21);
  });

  it('PNG at a URL → binary image', async () => {
    const out = await makeFetcher().fetchUrl(server.url('/images/chart'), ctxFor(staging.dir));
    expect(out.kind === 'binary' && out.content.mime).toBe('image/png');
    if (out.kind === 'binary') expect(out.content.filename).toBe('chart.png');
  });

  it('.docx via Content-Disposition → binary with that filename', async () => {
    const out = await makeFetcher().fetchUrl(server.url('/download'), ctxFor(staging.dir));
    expect(out.kind).toBe('binary');
    if (out.kind !== 'binary') return;
    expect(out.content.filename).toBe('Quarterly Plan.docx');
    expect(out.content.mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('PPTX content type → binary', async () => {
    const out = await makeFetcher().fetchUrl(server.url('/binary/deck.pptx'), ctxFor(staging.dir));
    expect(out.kind === 'binary' && out.content.filename).toBe('deck.pptx');
  });

  it('SVG → binary delivered as text/plain', async () => {
    const out = await makeFetcher().fetchUrl(server.url('/logo.svg'), ctxFor(staging.dir));
    expect(out.kind === 'binary' && out.content.mime).toBe('text/plain');
  });

  it('Latin-1 page with meta charset is decoded correctly', async () => {
    const readability = vi.fn(async (job: { html: string; url: string }) => {
      expect(job.html).toContain('Café crème');
      throw new Error('stop here');
    });
    const out = await makeFetcher({ readability }).fetchUrl(server.url('/latin1'), ctxFor(staging.dir));
    expect(readability).toHaveBeenCalled();
    expect(out.kind).toBe('skipped');
  });

  it('redirect loop → too-many-redirects', async () => {
    const o = expectSkip(
      await makeFetcher().fetchUrl(server.url('/redirect-loop/'), ctxFor(staging.dir)),
      'too-many-redirects',
    );
    expect(o.reason).toBe('too many redirects');
  });

  it('meta refresh loop counts as redirect hops → too-many-redirects', async () => {
    expectSkip(
      await makeFetcher().fetchUrl(server.url('/redirect-loop/index.html'), ctxFor(staging.dir)),
      'too-many-redirects',
    );
  });

  it('stalled body → timeout', async () => {
    const f = makeFetcher({ limits: testLimits({ HTTP_STALL_TIMEOUT_MS: 200 }) });
    const t0 = Date.now();
    const o = expectSkip(await f.fetchUrl(server.url('/slow/'), ctxFor(staging.dir)), 'timeout');
    expect(o.reason).toBe('fetch timed out');
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('60 MiB PDF by Content-Length → too-large before the body is read', async () => {
    const t0 = Date.now();
    const o = expectSkip(await makeFetcher().fetchUrl(server.url('/huge.pdf'), ctxFor(staging.dir)), 'too-large');
    expect(o.reason).toBe('file was too large (limit 50 MB)');
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(await readdir(staging.dir)).toEqual([]);
  });

  it('oversized HTML with the article in the prefix → article from the truncated prefix', async () => {
    const f = makeFetcher({ limits: testLimits({ MAX_HTML_BYTES: 512 * 1024, MIN_HTML_PREFIX_BYTES: 256 * 1024 }) });
    const out = await f.fetchUrl(server.url('/big-html'), ctxFor(staging.dir));
    expect(out.kind).toBe('article');
    if (out.kind === 'article') expect(out.content.title).toBe('Big Page');
  });

  it('video/mp4 → unsupported-type with the MIME in the reason', async () => {
    const o = expectSkip(
      await makeFetcher().fetchUrl(server.url('/clip.mp4'), ctxFor(staging.dir)),
      'unsupported-type',
    );
    expect(o.reason).toBe('unsupported content type (video/mp4)');
  });

  it('429 with Retry-After: 1, then 200 → article after exactly one retry', async () => {
    const sleeps: number[] = [];
    const f = makeFetcher({ sleep: async (ms) => void sleeps.push(ms) });
    const out = await f.fetchUrl(server.url('/rate-limited/'), ctxFor(staging.dir));
    expect(out.kind).toBe('article');
    expect(sleeps).toEqual([1000]);
    expect(hitsFor('/rate-limited/').length).toBe(2);
  });

  it('challenge interstitial that never clears → render-failed ("site blocked automated access")', async () => {
    const render = vi.fn(async (url: string): Promise<RenderResult> => ({
      ok: true,
      html: '<!doctype html><html><head><title>Just a moment...</title></head><body><div id="challenge-form"></div></body></html>',
      finalUrl: url,
      timedOut: false,
    }));
    const o = expectSkip(
      await makeFetcher({ render }).fetchUrl(server.url('/challenge/'), ctxFor(staging.dir)),
      'render-failed',
    );
    expect(o.reason).toBe('site blocked automated access');
    expect(render).toHaveBeenCalledOnce();
  });

  it('403 without login signals tries the render lane, then reports the HTTP error', async () => {
    const render = vi.fn(async (): Promise<RenderResult> => ({ ok: false, code: 'render-failed' }));
    const o = expectSkip(
      await makeFetcher({ render }).fetchUrl(server.url('/forbidden/'), ctxFor(staging.dir)),
      'http-client-error',
    );
    expect(o.reason).toBe('site refused the request (HTTP 403)');
    expect(render).toHaveBeenCalledOnce();
  });

  it('404 / 410 map to their codes without a render attempt', async () => {
    const render = vi.fn();
    const f = makeFetcher({ render });
    expectSkip(await f.fetchUrl(server.url('/nope/'), ctxFor(staging.dir)), 'http-not-found');
    expectSkip(await f.fetchUrl(server.url('/gone'), ctxFor(staging.dir)), 'http-gone');
    expect(render).not.toHaveBeenCalled();
  });

  it('5xx is retried once after 2 s, then http-server-error', async () => {
    const sleeps: number[] = [];
    const before = hitsFor('/broken').length;
    const f = makeFetcher({ sleep: async (ms) => void sleeps.push(ms) });
    const o = expectSkip(await f.fetchUrl(server.url('/broken'), ctxFor(staging.dir)), 'http-server-error');
    expect(o.reason).toBe('site returned an error (HTTP 500)');
    expect(sleeps).toEqual([2000]);
    expect(hitsFor('/broken').length - before).toBe(2);
  });

  it('dedupes the same URL within a job, not across jobs', async () => {
    const f = makeFetcher();
    const before = hitsFor('/article/').length;
    const [a, b] = await Promise.all([
      f.fetchUrl(server.url('/article/#top'), ctxFor(staging.dir)),
      f.fetchUrl(server.url('/article/'), ctxFor(staging.dir)),
    ]);
    expect(a).toBe(b);
    expect(hitsFor('/article/').length - before).toBe(1);
    await f.endJob('job-1');
    await f.fetchUrl(server.url('/article/'), ctxFor(staging.dir));
    expect(hitsFor('/article/').length - before).toBe(2);
  });

  it('endJob runs the cookie-clearing hook', async () => {
    const onJobEnd = vi.fn(async () => {});
    await makeFetcher({ onJobEnd }).endJob('job-9');
    expect(onJobEnd).toHaveBeenCalledWith('job-9');
  });

  it('aborting ctx.signal rejects with AbortError instead of skipping', async () => {
    const ac = new AbortController();
    const p = makeFetcher().fetchUrl(server.url('/slow/'), ctxFor(staging.dir, ac.signal, 'job-abort'));
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await expect(makeFetcher().fetchUrl(server.url('/article/'), ctxFor(staging.dir, ac.signal))).rejects.toMatchObject(
      {
        name: 'AbortError',
      },
    );
  });

  it('invalid, non-http and credentialed URLs are skipped without a request', async () => {
    const f = makeFetcher();
    const n = server.hits.length;
    expectSkip(await f.fetchUrl('not a url', ctxFor(staging.dir)), 'invalid-url');
    expectSkip(await f.fetchUrl('ftp://files.example/x', ctxFor(staging.dir)), 'blocked-scheme');
    expectSkip(await f.fetchUrl('javascript:alert(1)', ctxFor(staging.dir)), 'blocked-scheme');
    const user = ['u', 's', 'e', 'r'].join('');
    expectSkip(
      await f.fetchUrl(`http://${user}:${user}@127.0.0.1:${server.port}/`, ctxFor(staging.dir)),
      'credentials-in-url',
    );
    expect(server.hits.length).toBe(n);
  });
});

describe('fetchUrl redirect guards with a scripted transport', () => {
  /** A transport that answers one public URL with a redirect, and fails every other request. */
  function redirectingTransport(from: string, to: string): HttpTransport & { requested: string[] } {
    const requested: string[] = [];
    return {
      requested,
      async request(req) {
        requested.push(req.url);
        if (req.url === from) {
          const ok = await req.onRedirect({ statusCode: 302, redirectUrl: to });
          if (!ok) throw Object.assign(new Error('redirect stopped'), { name: 'RedirectStopped' });
        }
        throw new Error('unexpected request');
      },
    };
  }

  it('a public page redirecting into loopback → blocked-private-address, target never requested', async () => {
    const t = redirectingTransport('https://news.example.test/story', server.url('/article/'));
    const f = makeFetcher({ transport: t, lookup: async () => ['203.0.113.10'] });
    const o = expectSkip(
      await f.fetchUrl('https://news.example.test/story', ctxFor(staging.dir)),
      'blocked-private-address',
    );
    expect(o.reason).toBe('link redirected to a private network address');
    expect(t.requested).toEqual(['https://news.example.test/story']);
  });

  it('a redirect whose host resolves to a private address is blocked (DNS check)', async () => {
    const t = redirectingTransport('https://news.example.test/a', 'https://intranet.example.test/b');
    const lookup = async (h: string) => (h === 'intranet.example.test' ? ['10.1.2.3'] : ['203.0.113.10']);
    const f = makeFetcher({ transport: t, lookup });
    expectSkip(await f.fetchUrl('https://news.example.test/a', ctxFor(staging.dir)), 'blocked-private-address');
  });

  it('a redirect to a signature-matched identity host is login-required (HOOK-FETCH-02)', async () => {
    const t = redirectingTransport('https://wiki.example.test/page', 'https://portal.example.test/start');
    const f = makeFetcher({
      transport: t,
      loginSignatures: [{ hostPattern: /^portal\.example\.test$/, kind: 'conclusive' }],
    });
    const o = expectSkip(await f.fetchUrl('https://wiki.example.test/page', ctxFor(staging.dir)), 'login-required');
    expect(o.finalUrl).toBe('https://portal.example.test/start');
  });

  it('a DOM-selector login signature marks an otherwise readable page as login-required', async () => {
    const f = makeFetcher({ loginSignatures: [{ domSelector: 'article', kind: 'conclusive' }] });
    expectSkip(await f.fetchUrl(server.url('/article/'), ctxFor(staging.dir, undefined, 'job-sig')), 'login-required');
  });

  it('a network reset is retried once after 1 s', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const transport: HttpTransport = {
      async request() {
        calls += 1;
        const { TransportError } = await import('../../../../src/main/fetch/errors');
        throw new TransportError('reset', 'ECONNRESET');
      },
    };
    const f = makeFetcher({ transport, sleep: async (ms) => void sleeps.push(ms) });
    expectSkip(await f.fetchUrl('https://flaky.example.test/', ctxFor(staging.dir)), 'connect-failure');
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1000]);
  });
});
