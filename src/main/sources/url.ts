/**
 * URL normalization (03 §7.1) and the `url` resolver (03 §7.2). Owns no network code: all fetching
 * goes through ctx.fetchUrl (05 §2), which returns a FetchOutcome.
 */
import { stat } from 'node:fs/promises';
import type { FetchOutcome, FetchSkipCode } from '../fetch';
import { skip } from './reasons';
import { isImageFormat, sniff } from './sniff';
import { containerReaders, errnoOf, isInside, logSkip, readHead, sha256File, sha256Text } from './io';
import type { ResolveContext, ResolveOutcome, ResolvedSource, SkipCode, SourceInput, SourceResolver } from './types';

export type NormalizedUrl =
  | {
      ok: true;
      /** Parsed URL with the host lowercased; the fragment is kept (used for `ref`). */
      url: URL;
      /** href without the fragment: the dedupe key and what gets fetched. */
      key: string;
    }
  | { ok: false; code: 'not-a-url' | 'unsupported-scheme' };

/** `label.tld` with an optional port and path; no whitespace (03 §7.1 step 2). */
const HOST_LIKE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}(?::\d{1,5})?(?:[/?#]\S*)?$/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** 03 §7.1. `file:` URLs are returned as ok; the chain rewrites them to file inputs. */
export function normalizeUrl(raw: string): NormalizedUrl {
  let s = raw.trim();
  // Step 1: strip one layer of surrounding <> or quotes.
  const pairs: Array<[string, string]> = [
    ['<', '>'],
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
  ];
  for (const [open, close] of pairs) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
      s = s.slice(1, -1).trim();
      break;
    }
  }
  if (s === '') return { ok: false, code: 'not-a-url' };
  // Step 2: bare host -> https. "host:port/..." looks like a scheme to the regex, so test host first.
  if (HOST_LIKE.test(s)) s = `https://${s}`;
  else if (!HAS_SCHEME.test(s)) return { ok: false, code: 'not-a-url' };
  // Step 3.
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return { ok: false, code: 'not-a-url' };
  }
  // Step 4.
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') {
    return { ok: false, code: 'unsupported-scheme' };
  }
  if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname === '') {
    return { ok: false, code: 'not-a-url' };
  }
  // Step 5: WHATWG URL already lowercases the host; the query string is left untouched.
  const noFrag = new URL(url.href);
  noFrag.hash = '';
  return { ok: true, url, key: noFrag.href };
}

/** `scheme://user:pass@` at the start of text that did not parse as a URL. */
const RAW_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]*@/i;

/**
 * The `ref` for a URL input: the normalized URL with its fragment (03 §7.1 step 5), or the trimmed
 * text when it does not parse. Userinfo is always removed so credentials never reach a skip record,
 * the references list, or the saved job (05: no credentials are stored).
 */
export function refForUrl(raw: string): string {
  const norm = normalizeUrl(raw);
  if (!norm.ok) return raw.trim().replace(RAW_USERINFO, '$1');
  if (norm.url.username === '' && norm.url.password === '') return norm.url.href;
  const clean = new URL(norm.url.href);
  clean.username = '';
  clean.password = '';
  return clean.href;
}

/** 03 §7.2 FetchSkipCode -> SkipCode table. */
export function mapFetchSkipCode(code: FetchSkipCode): SkipCode {
  switch (code) {
    case 'invalid-url':
    case 'credentials-in-url':
      return 'not-a-url';
    case 'blocked-scheme':
      return 'unsupported-scheme';
    case 'dns-failure':
    case 'connect-failure':
    case 'tls-error':
    case 'too-many-redirects':
      return 'fetch-failed';
    case 'http-not-found':
    case 'http-gone':
    case 'http-client-error':
    case 'http-server-error':
    case 'rate-limited':
      return 'http-error';
    case 'timeout':
    case 'too-large':
    case 'login-required':
    case 'paywall':
    case 'unsupported-type':
    case 'empty-content':
    case 'render-failed':
    case 'blocked-private-address':
      return code;
  }
}

function hostOf(href: string): string | null {
  try {
    return new URL(href).hostname;
  } catch {
    return null;
  }
}

function redirectNotes(requested: string, finalUrl: string): string[] {
  const a = hostOf(requested);
  const b = hostOf(finalUrl);
  return a !== null && b !== null && a !== b ? [`redirected to ${b}`] : [];
}

type Mapped = Promise<ResolveOutcome>;

async function fromOutcome(
  input: Extract<SourceInput, { kind: 'url' }>,
  ref: string,
  requested: string,
  outcome: FetchOutcome,
  ctx: ResolveContext,
): Mapped {
  if (outcome.kind === 'skipped') {
    const code = mapFetchSkipCode(outcome.code);
    logSkip(ctx, 'sources.url.skipped', { code, kind: outcome.code, sourceKind: 'url' });
    // 05 §10 owns the reason text for fetch skips; passed through unchanged (03 §7.2).
    return { resolved: [], skipped: [{ ref, code, reason: outcome.reason }] };
  }
  if (outcome.kind === 'article') {
    const c = outcome.content;
    const src: ResolvedSource = {
      id: '',
      inputId: input.id,
      ref,
      location: c.finalUrl,
      lane: 'web',
      resolverId: 'url',
      format: 'html',
      mediaType: 'text/html',
      payload: { kind: 'html', html: c.contentHtml, baseUrl: c.finalUrl },
      sizeBytes: Buffer.byteLength(c.contentHtml, 'utf8'),
      sha256: sha256Text(c.contentHtml),
      notes: redirectNotes(requested, c.finalUrl),
    };
    if (c.title) src.title = c.title;
    return { resolved: [src], skipped: [] };
  }
  // Binary: 05 has already written the body under ctx.stagingDir; classify it like a file.
  const b = outcome.content;
  if (!isInside(ctx.stagingDir, b.path)) {
    logSkip(ctx, 'sources.url.outside-staging', { code: 'read-error', sourceKind: 'url' });
    return { resolved: [], skipped: [skip(ref, 'read-error')] };
  }
  try {
    const size = (await stat(b.path)).size;
    if (size === 0) return { resolved: [], skipped: [skip(ref, 'empty-content')] };
    if (size > ctx.limits.maxFileBytes) return { resolved: [], skipped: [skip(ref, 'too-large')] };
    const head = await readHead(b.path);
    const sniffed = await sniff(head, b.filename, { declaredMediaType: b.mime, ...containerReaders(b.path) });
    if (!sniffed.ok) return { resolved: [], skipped: [skip(ref, sniffed.code, sniffed.detail)] };
    if (isImageFormat(sniffed.format) && size > ctx.limits.maxImageBytes) {
      return { resolved: [], skipped: [skip(ref, 'too-large')] };
    }
    const src: ResolvedSource = {
      id: '',
      inputId: input.id,
      ref,
      location: b.finalUrl,
      lane: 'web',
      resolverId: 'url',
      format: sniffed.format,
      mediaType: sniffed.mediaType,
      payload: { kind: 'path', path: b.path },
      sizeBytes: size,
      sha256: await sha256File(b.path, ctx.signal),
      notes: [...redirectNotes(requested, b.finalUrl), ...sniffed.notes],
    };
    return { resolved: [src], skipped: [] };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    const errno = errnoOf(err);
    logSkip(ctx, 'sources.url.read-error', { code: 'read-error', sourceKind: 'url', ...(errno ? { errno } : {}) });
    return { resolved: [], skipped: [skip(ref, 'read-error')] };
  }
}

/** The `url` resolver (03 §3 order 3, lane web). */
export class UrlResolver implements SourceResolver {
  readonly id = 'url';
  readonly handles = ['url'] as const;
  readonly lane = 'web' as const;

  canResolve(input: SourceInput, _ctx: ResolveContext): boolean {
    return input.kind === 'url';
  }

  async resolve(input: SourceInput, ctx: ResolveContext): Promise<ResolveOutcome> {
    if (input.kind !== 'url') return { resolved: [], skipped: [skip(input.id, 'unsupported-type')] };
    const norm = normalizeUrl(input.url);
    const ref = refForUrl(input.url);
    if (!norm.ok) return { resolved: [], skipped: [skip(ref, norm.code)] };
    if (norm.url.protocol === 'file:') return { resolved: [], skipped: [skip(ref, 'unsupported-scheme')] };
    // fetchUrl throws only AbortError; the chain maps it to `cancelled` (03 §7.2).
    const outcome = await ctx.fetchUrl(norm.key, { jobId: ctx.jobId, signal: ctx.signal, stagingDir: ctx.stagingDir });
    return fromOutcome(input, ref, norm.key, outcome, ctx);
  }
}

export const urlResolver: SourceResolver = new UrlResolver();
