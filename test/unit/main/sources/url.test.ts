import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FetchContext, FetchOutcome, FetchSkipCode } from '../../../../src/main/fetch';
import { sha256Text } from '../../../../src/main/sources/io';
import { mapFetchSkipCode, normalizeUrl, UrlResolver } from '../../../../src/main/sources/url';
import { DEFAULT_RESOLVE_LIMITS, type SkipCode, type SourceInput } from '../../../../src/main/sources/types';
import * as fx from './fixtures';
import { fakeCtx } from './helpers';

describe('normalizeUrl (03 §7.1)', () => {
  it.each([
    ['https://Example.COM/Path?Q=1#frag', 'https://example.com/Path?Q=1#frag', 'https://example.com/Path?Q=1'],
    ['  <https://example.com/a>  ', 'https://example.com/a', 'https://example.com/a'],
    ['"https://example.com/a"', 'https://example.com/a', 'https://example.com/a'],
    ["'http://example.com'", 'http://example.com/', 'http://example.com/'],
    ['example.com', 'https://example.com/', 'https://example.com/'],
    [
      'docs.example.co.uk/guide?x=A%20b',
      'https://docs.example.co.uk/guide?x=A%20b',
      'https://docs.example.co.uk/guide?x=A%20b',
    ],
    ['example.com:8443/x#y', 'https://example.com:8443/x#y', 'https://example.com:8443/x'],
  ])('%j -> %s', (raw, href, key) => {
    const n = normalizeUrl(raw);
    expect(n.ok).toBe(true);
    if (n.ok) {
      expect(n.url.href).toBe(href);
      expect(n.key).toBe(key);
    }
  });

  it.each([
    ['', 'not-a-url'],
    ['ABC-123', 'not-a-url'],
    ['just some words', 'not-a-url'],
    ['http://', 'not-a-url'],
    ['mailto:someone@example.com', 'unsupported-scheme'],
    ['javascript:alert(1)', 'unsupported-scheme'],
    ['exampleapp://open/doc', 'unsupported-scheme'],
    ['ftp://example.com/file', 'unsupported-scheme'],
  ] as const)('%j -> %s', (raw, code) => {
    expect(normalizeUrl(raw)).toEqual({ ok: false, code });
  });

  it('accepts file: URLs (the chain rewrites them to file inputs)', () => {
    const n = normalizeUrl('file:///tmp/a.md');
    expect(n.ok && n.url.protocol).toBe('file:');
  });
});

describe('mapFetchSkipCode (03 §7.2 table)', () => {
  const table: Record<FetchSkipCode, SkipCode> = {
    'invalid-url': 'not-a-url',
    'blocked-scheme': 'unsupported-scheme',
    'credentials-in-url': 'not-a-url',
    'dns-failure': 'fetch-failed',
    'connect-failure': 'fetch-failed',
    'tls-error': 'fetch-failed',
    'too-many-redirects': 'fetch-failed',
    'http-not-found': 'http-error',
    'http-gone': 'http-error',
    'http-client-error': 'http-error',
    'http-server-error': 'http-error',
    'rate-limited': 'http-error',
    timeout: 'timeout',
    'too-large': 'too-large',
    'login-required': 'login-required',
    paywall: 'paywall',
    'unsupported-type': 'unsupported-type',
    'empty-content': 'empty-content',
    'render-failed': 'render-failed',
    'blocked-private-address': 'blocked-private-address',
  };
  it.each(Object.entries(table) as Array<[FetchSkipCode, SkipCode]>)('%s -> %s', (from, to) => {
    expect(mapFetchSkipCode(from)).toBe(to);
  });
});

const urlInput = (url: string): Extract<SourceInput, { kind: 'url' }> => ({
  id: 'in-0000a001',
  kind: 'url',
  origin: 'url-field',
  url,
});

function article(over: Partial<Extract<FetchOutcome, { kind: 'article' }>['content']> = {}): FetchOutcome {
  return {
    kind: 'article',
    content: {
      requestedUrl: 'https://example.com/post',
      finalUrl: 'https://example.com/post',
      title: 'Example Widgets Inc. expands',
      byline: null,
      siteName: null,
      lang: 'en',
      publishedTime: null,
      excerpt: null,
      contentHtml: '<article><p>Example Widgets Inc. opened a plant.</p></article>',
      textLength: 34,
      via: 'http',
      imageUrls: [],
      ...over,
    },
  };
}

describe('UrlResolver (03 §7.2)', () => {
  const r = new UrlResolver();

  it('has the spec shape and claims url inputs only', () => {
    expect([r.id, r.lane, r.handles]).toEqual(['url', 'web', ['url']]);
    expect(r.canResolve(urlInput('https://example.com'), fakeCtx())).toBe(true);
    expect(r.canResolve({ id: 'in-1', kind: 'file', origin: 'drop', path: '/a' }, fakeCtx())).toBe(false);
  });

  it('article -> html payload with baseUrl, final URL location, title and sha256', async () => {
    const fetchUrl = vi.fn((_u: string, _c: FetchContext) =>
      Promise.resolve(article({ finalUrl: 'https://www.example.org/post' })),
    );
    const ctx = fakeCtx({ fetchUrl });
    const out = await r.resolve(urlInput('example.com/post#section-2'), ctx);
    expect(fetchUrl).toHaveBeenCalledWith('https://example.com/post', {
      jobId: 'job-1',
      signal: ctx.signal,
      stagingDir: ctx.stagingDir,
    });
    const html = '<article><p>Example Widgets Inc. opened a plant.</p></article>';
    expect(out).toEqual({
      resolved: [
        {
          id: '',
          inputId: 'in-0000a001',
          ref: 'https://example.com/post#section-2',
          location: 'https://www.example.org/post',
          lane: 'web',
          resolverId: 'url',
          format: 'html',
          mediaType: 'text/html',
          title: 'Example Widgets Inc. expands',
          payload: { kind: 'html', html, baseUrl: 'https://www.example.org/post' },
          sizeBytes: Buffer.byteLength(html),
          sha256: sha256Text(html),
          notes: ['redirected to www.example.org'],
        },
      ],
      skipped: [],
    });
  });

  it('article without a title leaves title unset and adds no redirect note on the same host', async () => {
    const out = await r.resolve(
      urlInput('https://example.com/post'),
      fakeCtx({ fetchUrl: () => Promise.resolve(article({ title: null })) }),
    );
    expect(out.resolved[0]).not.toHaveProperty('title');
    expect(out.resolved[0]?.notes).toEqual([]);
  });

  it('binary inside stagingDir is sniffed and returned as a path payload', async () => {
    const staging = await fx.tmpDir();
    const body = await fx.put(staging, 'downloads/0-report.pdf', fx.pdf());
    const ctx = fakeCtx({
      stagingDir: staging,
      fetchUrl: () =>
        Promise.resolve({
          kind: 'binary',
          content: {
            requestedUrl: 'https://example.com/report.pdf',
            finalUrl: 'https://example.com/report.pdf',
            mime: 'application/pdf',
            filename: 'report.pdf',
            path: body,
            sizeBytes: fx.pdf().length,
          },
        }),
    });
    const out = await r.resolve(urlInput('https://example.com/report.pdf'), ctx);
    expect(out.resolved[0]).toMatchObject({
      format: 'pdf',
      mediaType: 'application/pdf',
      payload: { kind: 'path', path: body },
      location: 'https://example.com/report.pdf',
      lane: 'web',
      sizeBytes: fx.pdf().length,
    });
  });

  it('binary text bodies use the declared media type as a text-family tie-breaker', async () => {
    const staging = await fx.tmpDir();
    const body = await fx.put(staging, 'downloads/0-notes', '# Title\n\n- a\n');
    const out = await r.resolve(
      urlInput('https://example.com/notes'),
      fakeCtx({
        stagingDir: staging,
        fetchUrl: () =>
          Promise.resolve({
            kind: 'binary',
            content: {
              requestedUrl: 'https://example.com/notes',
              finalUrl: 'https://example.com/notes',
              mime: 'text/markdown',
              filename: 'notes',
              path: body,
              sizeBytes: 13,
            },
          }),
      }),
    );
    expect(out.resolved[0]?.format).toBe('markdown');
  });

  it('unsupported binaries are skipped with the sniff code; bodies outside stagingDir are read-errors', async () => {
    const staging = await fx.tmpDir();
    const zip = await fx.put(staging, 'downloads/0-a.zip', await fx.genericZip());
    const mk = (p: string): FetchOutcome => ({
      kind: 'binary',
      content: {
        requestedUrl: 'https://e.test/a',
        finalUrl: 'https://e.test/a',
        mime: 'application/zip',
        filename: 'a.zip',
        path: p,
        sizeBytes: 1,
      },
    });
    const a = await r.resolve(
      urlInput('https://e.test/a'),
      fakeCtx({ stagingDir: staging, fetchUrl: () => Promise.resolve(mk(zip)) }),
    );
    expect(a.skipped[0]).toMatchObject({ code: 'unsupported-type', reason: 'Unsupported file type: ZIP archive.' });
    const outside = path.join(path.dirname(staging), 'elsewhere.pdf');
    const b = await r.resolve(
      urlInput('https://e.test/a'),
      fakeCtx({ stagingDir: staging, fetchUrl: () => Promise.resolve(mk(outside)) }),
    );
    expect(b.skipped[0]?.code).toBe('read-error');
  });

  it('skipped outcomes map the code and pass 05 reason text through unchanged; original code is logged', async () => {
    const log = vi.fn();
    const out = await r.resolve(
      urlInput('https://example.com/private'),
      fakeCtx({
        log,
        fetchUrl: () =>
          Promise.resolve({ kind: 'skipped', code: 'http-not-found', reason: 'site returned an error (404)' }),
      }),
    );
    expect(out.skipped).toEqual([
      { ref: 'https://example.com/private', code: 'http-error', reason: 'site returned an error (404)' },
    ]);
    expect(log).toHaveBeenCalledWith(
      'sources.url.skipped',
      expect.objectContaining({ kind: 'http-not-found', code: 'http-error' }),
    );
  });

  it('invalid and non-web inputs are skipped without calling fetch', async () => {
    const fetchUrl = vi.fn();
    const ctx = fakeCtx({ fetchUrl });
    expect((await r.resolve(urlInput('not a url'), ctx)).skipped[0]?.code).toBe('not-a-url');
    expect((await r.resolve(urlInput('mailto:a@example.com'), ctx)).skipped[0]?.code).toBe('unsupported-scheme');
    expect(fetchUrl).not.toHaveBeenCalled();
  });

  it('propagates AbortError from fetchUrl (the chain maps it to cancelled)', async () => {
    const err = new DOMException('Aborted', 'AbortError');
    await expect(
      r.resolve(urlInput('https://example.com'), fakeCtx({ fetchUrl: () => Promise.reject(err) })),
    ).rejects.toBe(err);
  });

  it('enforces maxImageBytes on downloaded images', async () => {
    const staging = await fx.tmpDir();
    const img = await fx.put(staging, 'downloads/0-a.png', fx.png());
    const out = await r.resolve(
      urlInput('https://e.test/a.png'),
      fakeCtx({
        stagingDir: staging,
        limits: { ...DEFAULT_RESOLVE_LIMITS, maxImageBytes: 4 },
        fetchUrl: () =>
          Promise.resolve({
            kind: 'binary',
            content: {
              requestedUrl: 'https://e.test/a.png',
              finalUrl: 'https://e.test/a.png',
              mime: 'image/png',
              filename: 'a.png',
              path: img,
              sizeBytes: 33,
            },
          }),
      }),
    );
    expect(out.skipped[0]?.code).toBe('too-large');
  });
});
