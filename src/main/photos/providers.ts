// Public stock photo providers (07 §7.4): Openverse (anonymous API over openly licensed works) with
// Wikimedia Commons as the fallback. Neither needs an API key. Every request goes through the fetch
// module (05 §4.8): fetch session and proxy, politeness, private-address guard, timeouts, byte caps.
import { abortError } from './abort';
import {
  ALLOWED_LICENSES,
  type StockCandidate,
  type StockHttp,
  type StockImageProvider,
  type StockLicense,
  type StockSearchOptions,
} from './types';

export const OPENVERSE_API = 'https://api.openverse.org/v1/images/';
export const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
/** Sent as the User-Agent purpose: Openverse and Wikimedia ask API clients to identify themselves. */
export const STOCK_PURPOSE = 'open-licensed stock photo search';
/** Search results asked for before filtering (anonymous Openverse allows up to 20 per page). */
export const SEARCH_PAGE_SIZE = 12;
export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_THUMB_BYTES = 3 * 1024 * 1024;
export const MAX_FULL_BYTES = 15 * 1024 * 1024;
/** Wikimedia serves these thumbnail widths from cache. */
const COMMONS_THUMB_WIDTH = 500;
const COMMONS_FULL_WIDTH = 1280;
/** Titles that suggest a logo, a screenshot or a document rather than a photo. */
const UNWANTED_TITLE = /\b(logo|logos|trademark|screenshot|screen shot|diagram|map|chart|poster|flyer|meme)\b/i;

const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp;q=0.9,image/*;q=0.5';

function https(u: unknown): string | undefined {
  if (typeof u !== 'string') return undefined;
  try {
    const p = new URL(u.startsWith('//') ? `https:${u}` : u);
    return p.protocol === 'https:' ? p.href : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const stripTags = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

async function getJson(http: StockHttp, url: string, signal: AbortSignal): Promise<unknown> {
  const r = await http(url, { signal, accept: 'application/json', maxBytes: MAX_JSON_BYTES, purpose: STOCK_PURPOSE });
  if (r.kind !== 'ok') return null;
  try {
    return JSON.parse(new TextDecoder().decode(r.bytes)) as unknown;
  } catch {
    return null;
  }
}

async function getImage(
  http: StockHttp,
  url: string,
  size: 'thumb' | 'full',
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const r = await http(url, {
    signal,
    accept: IMAGE_ACCEPT,
    maxBytes: size === 'thumb' ? MAX_THUMB_BYTES : MAX_FULL_BYTES,
    purpose: STOCK_PURPOSE,
  });
  return r.kind === 'ok' && r.mime.startsWith('image/') && r.mime !== 'image/svg+xml' ? r.bytes : null;
}

/** upload.wikimedia.org original -> its `<width>px-` thumbnail path; undefined for other hosts. */
export function commonsThumb(original: string, width: number): string | undefined {
  const m =
    /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/(?!thumb\/)([0-9a-f]\/[0-9a-f]{2})\/([^/?#]+)$/.exec(
      original,
    );
  if (!m) return undefined;
  return `https://upload.wikimedia.org/wikipedia/commons/thumb/${m[1]}/${m[2]}/${width}px-${m[2]}`;
}

/** live.staticflickr.com `<id>_<secret>[_x].jpg` -> the given size suffix (n: 320 px, b: 1024 px). */
export function flickrSized(url: string, suffix: 'n' | 'b'): string | undefined {
  const m = /^(https:\/\/live\.staticflickr\.com\/\d+\/\d+_[0-9a-f]+)(?:_[a-z0-9])?\.jpg$/.exec(url);
  return m ? `${m[1]}_${suffix}.jpg` : undefined;
}

function licenseOf(v: unknown): StockLicense | undefined {
  const l = typeof v === 'string' ? v.toLowerCase() : '';
  return (ALLOWED_LICENSES as readonly string[]).includes(l) ? (l as StockLicense) : undefined;
}

const SOURCE_NAMES: Record<string, string> = {
  flickr: 'Flickr',
  wikimedia: 'Wikimedia Commons',
  stocksnap: 'StockSnap',
  rawpixel: 'rawpixel',
  nappy: 'nappy',
  smithsonian: 'Smithsonian',
};

// ---- Openverse ----

export class OpenverseProvider implements StockImageProvider {
  readonly id = 'openverse';
  constructor(private readonly http: StockHttp) {}

  async search(query: string, o: StockSearchOptions): Promise<StockCandidate[]> {
    if (o.signal.aborted) throw abortError();
    const u = new URL(OPENVERSE_API);
    u.searchParams.set('q', query);
    u.searchParams.set('license', ALLOWED_LICENSES.join(','));
    u.searchParams.set('mature', 'false');
    u.searchParams.set('page_size', String(SEARCH_PAGE_SIZE));
    const body = (await getJson(this.http, u.href, o.signal)) as { results?: unknown } | null;
    const results = Array.isArray(body?.results) ? (body.results as Record<string, unknown>[]) : [];
    const out: StockCandidate[] = [];
    for (const r of results) {
      const c = this.candidate(r);
      if (c) out.push(c);
      if (out.length >= o.limit) break;
    }
    return out;
  }

  private candidate(r: Record<string, unknown>): StockCandidate | undefined {
    const license = licenseOf(r.license);
    const id = str(r.id);
    const url = https(r.url);
    const title = str(r.title);
    if (!license || !id || !url || !title || r.mature === true) return undefined;
    if (Array.isArray(r.unstable__sensitivity) && r.unstable__sensitivity.length > 0) return undefined;
    if (UNWANTED_TITLE.test(title)) return undefined;
    const source = str(r.source) ?? str(r.provider) ?? '';
    const width = num(r.width);
    const wideOriginal = width === undefined || width > COMMONS_FULL_WIDTH;
    const thumbUrl = commonsThumb(url, COMMONS_THUMB_WIDTH) ?? flickrSized(url, 'n') ?? https(r.thumbnail) ?? url;
    const imageUrl = (wideOriginal ? commonsThumb(url, COMMONS_FULL_WIDTH) : undefined) ?? flickrSized(url, 'b') ?? url;
    const creator = str(r.creator);
    const version = str(r.license_version);
    const licenseUrl = https(r.license_url);
    const landingUrl = https(r.foreign_landing_url);
    const height = num(r.height);
    return {
      id: `openverse:${id}`,
      title,
      ...(creator ? { creator } : {}),
      license,
      ...(version ? { licenseVersion: version } : {}),
      ...(licenseUrl ? { licenseUrl } : {}),
      ...(landingUrl ? { landingUrl } : {}),
      sourceName: SOURCE_NAMES[source.toLowerCase()] ?? (source || 'Openverse'),
      via: 'Openverse',
      thumbUrl,
      imageUrl,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    };
  }

  download(c: StockCandidate, size: 'thumb' | 'full', o: { signal: AbortSignal }): Promise<Uint8Array | null> {
    return getImage(this.http, size === 'thumb' ? c.thumbUrl : c.imageUrl, size, o.signal);
  }
}

// ---- Wikimedia Commons ----

/** Commons `License` codes -> allowed licenses; anything else (NC, ND, GFDL-only, fair use) is dropped. */
function commonsLicense(code: string | undefined): { license: StockLicense; version?: string } | undefined {
  const c = (code ?? '').toLowerCase();
  if (c === 'cc0') return { license: 'cc0', version: '1.0' };
  if (c === 'pd' || c.startsWith('pd-') || c === 'public domain') return { license: 'pdm', version: '1.0' };
  const m = /^cc-(by|by-sa)-(\d(?:\.\d)?)/.exec(c);
  if (m) return { license: m[1] as 'by' | 'by-sa', version: m[2] ?? '' };
  return undefined;
}

export class CommonsProvider implements StockImageProvider {
  readonly id = 'commons';
  constructor(private readonly http: StockHttp) {}

  async search(query: string, o: StockSearchOptions): Promise<StockCandidate[]> {
    if (o.signal.aborted) throw abortError();
    const u = new URL(COMMONS_API);
    const params: Record<string, string> = {
      action: 'query',
      format: 'json',
      formatversion: '2',
      generator: 'search',
      gsrsearch: `${query} filetype:bitmap`,
      gsrnamespace: '6',
      gsrlimit: String(SEARCH_PAGE_SIZE),
      prop: 'imageinfo',
      iiprop: 'url|size|mime|extmetadata',
      iiurlwidth: String(COMMONS_THUMB_WIDTH),
      iiextmetadatafilter: 'License|LicenseShortName|LicenseUrl|Artist|ObjectName',
      origin: '*',
    };
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const body = (await getJson(this.http, u.href, o.signal)) as { query?: { pages?: unknown } } | null;
    const pages = Array.isArray(body?.query?.pages) ? (body.query.pages as Record<string, unknown>[]) : [];
    const out: StockCandidate[] = [];
    for (const p of pages) {
      const c = this.candidate(p);
      if (c) out.push(c);
      if (out.length >= o.limit) break;
    }
    return out;
  }

  private candidate(p: Record<string, unknown>): StockCandidate | undefined {
    const info = (Array.isArray(p.imageinfo) ? p.imageinfo[0] : undefined) as Record<string, unknown> | undefined;
    if (!info) return undefined;
    const mime = str(info.mime);
    if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp') return undefined;
    const meta = (info.extmetadata ?? {}) as Record<string, { value?: unknown } | undefined>;
    const val = (k: string): string | undefined => {
      const v = meta[k]?.value;
      return typeof v === 'string' ? stripTags(v) || undefined : undefined;
    };
    const lic = commonsLicense(val('License'));
    const url = https(info.url);
    const thumb = https(info.thumburl);
    const fileTitle = str(p.title)
      ?.replace(/^File:/, '')
      .replace(/\.[a-z0-9]+$/i, '');
    const title = val('ObjectName') ?? fileTitle;
    if (!lic || !url || !title || UNWANTED_TITLE.test(title)) return undefined;
    const width = num(info.width);
    const height = num(info.height);
    const full =
      width !== undefined && width > COMMONS_FULL_WIDTH ? (commonsThumb(url, COMMONS_FULL_WIDTH) ?? url) : url;
    const creator = val('Artist');
    const licenseUrl = https(val('LicenseUrl'));
    const landingUrl = https(info.descriptionurl);
    return {
      id: `commons:${str(p.title) ?? url}`,
      title,
      ...(creator ? { creator: creator.slice(0, 200) } : {}),
      license: lic.license,
      ...(lic.version ? { licenseVersion: lic.version } : {}),
      ...(licenseUrl ? { licenseUrl } : {}),
      ...(landingUrl ? { landingUrl } : {}),
      sourceName: 'Wikimedia Commons',
      via: 'Wikimedia Commons',
      thumbUrl: thumb ?? commonsThumb(url, COMMONS_THUMB_WIDTH) ?? url,
      imageUrl: full,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    };
  }

  download(c: StockCandidate, size: 'thumb' | 'full', o: { signal: AbortSignal }): Promise<Uint8Array | null> {
    return getImage(this.http, size === 'thumb' ? c.thumbUrl : c.imageUrl, size, o.signal);
  }
}

// ---- primary + fallback ----

/**
 * Searches the providers in order and tops up from the next while fewer than 2 results (or the
 * previous failed). Downloads go to the provider that found the candidate. Cancellation rethrows.
 */
export class FallbackStockImages implements StockImageProvider {
  readonly id: string;
  private readonly owner = new Map<string, StockImageProvider>();

  constructor(private readonly providers: readonly StockImageProvider[]) {
    this.id = providers.map((p) => p.id).join('+');
  }

  async search(query: string, o: StockSearchOptions): Promise<StockCandidate[]> {
    const out: StockCandidate[] = [];
    for (const p of this.providers) {
      if (o.signal.aborted) throw abortError();
      if (out.length >= Math.min(2, o.limit)) break;
      let found: StockCandidate[] = [];
      try {
        found = await p.search(query, { ...o, limit: o.limit - out.length });
      } catch (e) {
        if (o.signal.aborted) throw e;
        found = [];
      }
      for (const c of found) {
        if (out.some((x) => x.id === c.id)) continue;
        this.owner.set(c.id, p);
        out.push(c);
      }
    }
    return out;
  }

  download(c: StockCandidate, size: 'thumb' | 'full', o: { signal: AbortSignal }): Promise<Uint8Array | null> {
    const p = this.owner.get(c.id) ?? this.providers[0];
    return p ? p.download(c, size, o) : Promise.resolve(null);
  }
}
