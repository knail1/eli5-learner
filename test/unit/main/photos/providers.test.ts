import { describe, expect, it } from 'vitest';
import {
  ApprovedLibraryStub,
  CommonsProvider,
  FallbackStockImages,
  OpenverseProvider,
  type StockCandidate,
  type StockHttp,
  type StockImageProvider,
} from '../../../../src/main/photos';

const enc = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));
const signal = new AbortController().signal;

interface Call {
  url: string;
  accept: string;
  maxBytes: number;
}

/** Fake StockHttp: answers from a URL-prefix table and records every call. */
function fakeHttp(table: Record<string, Uint8Array | number>): { http: StockHttp; calls: Call[] } {
  const calls: Call[] = [];
  const http: StockHttp = async (url, o) => {
    calls.push({ url, accept: o.accept, maxBytes: o.maxBytes });
    const key = Object.keys(table).find((k) => url.startsWith(k));
    const v = key === undefined ? 404 : table[key];
    if (typeof v === 'number' || v === undefined)
      return { kind: 'skipped', code: 'http-client-error', status: v ?? 404 };
    const mime = o.accept.startsWith('image/') ? 'image/jpeg' : 'application/json';
    return { kind: 'ok', status: 200, mime, bytes: v, finalUrl: url };
  };
  return { http, calls };
}

const ov = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 'id-1',
  title: 'Courthouse exterior',
  foreign_landing_url: 'https://www.flickr.com/photos/someone/1',
  url: 'https://live.staticflickr.com/65535/1_abc_b.jpg',
  creator: 'someone',
  license: 'by',
  license_version: '2.0',
  license_url: 'https://creativecommons.org/licenses/by/2.0/',
  provider: 'flickr',
  source: 'flickr',
  mature: false,
  width: 1024,
  height: 683,
  thumbnail: 'https://api.openverse.org/v1/images/id-1/thumb/',
  unstable__sensitivity: [],
  ...over,
});

describe('OpenverseProvider (anonymous, open licenses only)', () => {
  it('asks for reusable licenses and non-mature results, and maps results to candidates', async () => {
    const { http, calls } = fakeHttp({
      'https://api.openverse.org/v1/images/': enc({
        results: [
          ov({}),
          ov({ id: 'id-2', license: 'by-nc', title: 'Non-commercial' }),
          ov({ id: 'id-3', mature: true, title: 'Mature' }),
          ov({ id: 'id-4', unstable__sensitivity: ['sensitive_text'], title: 'Sensitive' }),
          ov({ id: 'id-5', title: 'Company logo on wall' }),
          ov({
            id: 'id-6',
            license: 'cc0',
            license_version: '1.0',
            title: 'Court steps',
            provider: 'wikimedia',
            source: 'wikimedia',
            url: 'https://upload.wikimedia.org/wikipedia/commons/f/f9/Court_steps.jpg',
            foreign_landing_url: 'https://commons.wikimedia.org/w/index.php?curid=1',
            width: 4000,
            height: 3000,
          }),
          ov({ id: 'id-7', url: 'http://insecure.example/x.jpg', title: 'Insecure' }),
        ],
      }),
    });
    const p = new OpenverseProvider(http);
    const out = await p.search('courthouse exterior', { signal, limit: 8 });
    const u = new URL(calls[0]?.url ?? '');
    expect(u.origin + u.pathname).toBe('https://api.openverse.org/v1/images/');
    expect(u.searchParams.get('q')).toBe('courthouse exterior');
    expect(u.searchParams.get('license')).toBe('cc0,pdm,by,by-sa');
    expect(u.searchParams.get('mature')).toBe('false');
    expect(calls[0]?.accept).toContain('application/json');
    expect(out.map((c) => c.id)).toEqual(['openverse:id-1', 'openverse:id-6']);
    const [a, b] = out as [StockCandidate, StockCandidate];
    expect(a).toMatchObject({
      title: 'Courthouse exterior',
      creator: 'someone',
      license: 'by',
      licenseVersion: '2.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/2.0/',
      landingUrl: 'https://www.flickr.com/photos/someone/1',
      sourceName: 'Flickr',
      via: 'Openverse',
    });
    // Flickr sizes by suffix; Wikimedia by its thumbnail path, so no Openverse rate-limit is spent.
    expect(a.thumbUrl).toBe('https://live.staticflickr.com/65535/1_abc_n.jpg');
    expect(a.imageUrl).toBe('https://live.staticflickr.com/65535/1_abc_b.jpg');
    expect(b.sourceName).toBe('Wikimedia Commons');
    expect(b.thumbUrl).toBe(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f9/Court_steps.jpg/500px-Court_steps.jpg',
    );
    expect(b.imageUrl).toBe(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f9/Court_steps.jpg/1280px-Court_steps.jpg',
    );
  });

  it('returns [] on HTTP errors and malformed JSON', async () => {
    expect(await new OpenverseProvider(fakeHttp({}).http).search('desk', { signal, limit: 4 })).toEqual([]);
    const bad = fakeHttp({ 'https://api.openverse.org/': new TextEncoder().encode('<html>') }).http;
    expect(await new OpenverseProvider(bad).search('desk', { signal, limit: 4 })).toEqual([]);
  });

  it('downloads thumbnails and full images with byte caps', async () => {
    const img = new Uint8Array([1, 2, 3]);
    const { http, calls } = fakeHttp({ 'https://live.staticflickr.com/': img });
    const p = new OpenverseProvider(http);
    const c = { thumbUrl: 'https://live.staticflickr.com/t.jpg', imageUrl: 'https://live.staticflickr.com/f.jpg' };
    expect(await p.download(c as StockCandidate, 'thumb', { signal })).toEqual(img);
    expect(await p.download(c as StockCandidate, 'full', { signal })).toEqual(img);
    expect(calls.map((x) => x.url)).toEqual([
      'https://live.staticflickr.com/t.jpg',
      'https://live.staticflickr.com/f.jpg',
    ]);
    expect(calls.every((x) => x.accept.startsWith('image/'))).toBe(true);
    expect(calls[0]!.maxBytes).toBeLessThan(calls[1]!.maxBytes);
  });
});

const commonsPage = (over: Record<string, unknown>, meta: Record<string, string> = {}): Record<string, unknown> => ({
  title: 'File:Gavel.jpg',
  imageinfo: [
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Gavel.jpg',
      thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Gavel.jpg/500px-Gavel.jpg',
      descriptionurl: 'https://commons.wikimedia.org/wiki/File:Gavel.jpg',
      width: 3000,
      height: 2000,
      mime: 'image/jpeg',
      extmetadata: Object.fromEntries(
        Object.entries({
          License: 'cc-by-sa-4.0',
          LicenseShortName: 'CC BY-SA 4.0',
          LicenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
          Artist: '<a href="//commons.wikimedia.org/wiki/User:X">Some <b>Author</b></a>',
          ObjectName: 'Wooden gavel',
          ...meta,
        }).map(([k, v]) => [k, { value: v }]),
      ),
      ...over,
    },
  ],
});

describe('CommonsProvider (fallback)', () => {
  it('searches bitmap files and keeps only reusable licenses', async () => {
    const { http, calls } = fakeHttp({
      'https://commons.wikimedia.org/w/api.php': enc({
        query: {
          pages: [
            commonsPage({}),
            commonsPage({}, { License: 'cc-by-nc-2.0', LicenseShortName: 'CC BY-NC 2.0' }),
            commonsPage({}, { License: 'pd', LicenseShortName: 'Public domain', Artist: '' }),
            commonsPage({ mime: 'image/svg+xml' }),
          ],
        },
      }),
    });
    const out = await new CommonsProvider(http).search('wooden gavel', { signal, limit: 8 });
    const u = new URL(calls[0]?.url ?? '');
    expect(u.searchParams.get('gsrsearch')).toBe('wooden gavel filetype:bitmap');
    expect(u.searchParams.get('gsrnamespace')).toBe('6');
    expect(out.map((c) => c.license)).toEqual(['by-sa', 'pdm']);
    expect(out[0]).toMatchObject({
      title: 'Wooden gavel',
      creator: 'Some Author',
      licenseVersion: '4.0',
      landingUrl: 'https://commons.wikimedia.org/wiki/File:Gavel.jpg',
      sourceName: 'Wikimedia Commons',
      via: 'Wikimedia Commons',
      thumbUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Gavel.jpg/500px-Gavel.jpg',
      imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Gavel.jpg/1280px-Gavel.jpg',
    });
    expect(out[1]?.creator).toBeUndefined();
  });
});

describe('FallbackStockImages', () => {
  const cand = (id: string): StockCandidate => ({
    id,
    title: id,
    license: 'cc0',
    sourceName: 'X',
    via: 'X',
    thumbUrl: 'https://x.example/t.jpg',
    imageUrl: 'https://x.example/f.jpg',
  });
  const fixed = (id: string, r: StockCandidate[] | Error): StockImageProvider => ({
    id,
    search: async () => {
      if (r instanceof Error) throw r;
      return r;
    },
    download: async () => new Uint8Array([id.length]),
  });

  it('uses the primary provider, and the fallback when the primary has too few results or fails', async () => {
    const both = new FallbackStockImages([fixed('a', [cand('a1'), cand('a2')]), fixed('b', [cand('b1')])]);
    expect((await both.search('q', { signal, limit: 4 })).map((c) => c.id)).toEqual(['a1', 'a2']);
    const thin = new FallbackStockImages([fixed('a', [cand('a1')]), fixed('b', [cand('b1')])]);
    expect((await thin.search('q', { signal, limit: 4 })).map((c) => c.id)).toEqual(['a1', 'b1']);
    const failing = new FallbackStockImages([fixed('a', new Error('down')), fixed('b', [cand('b1')])]);
    expect((await failing.search('q', { signal, limit: 4 })).map((c) => c.id)).toEqual(['b1']);
  });

  it('downloads through the provider that found the candidate', async () => {
    const f = new FallbackStockImages([fixed('a', []), fixed('bb', [cand('b1')])]);
    const [c] = await f.search('q', { signal, limit: 4 });
    expect(await f.download(c!, 'thumb', { signal })).toEqual(new Uint8Array([2]));
  });

  it('rethrows cancellation', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const f = new FallbackStockImages([fixed('a', [cand('a1')])]);
    await expect(f.search('q', { signal: ctl.signal, limit: 4 })).rejects.toThrow();
  });
});

describe('ApprovedLibraryStub (HOOK-DOC-03)', () => {
  it('is a stub that never searches', async () => {
    const s = new ApprovedLibraryStub();
    expect(s.stub).toBe(true);
    await expect(s.search('q', { signal, limit: 4 })).rejects.toMatchObject({ hookId: 'HOOK-DOC-03' });
    expect(await s.download({} as StockCandidate, 'thumb', { signal })).toBeNull();
  });
});
