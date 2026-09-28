import type { FetchSkipCode } from './types';

/** Extra facts some reason strings need (05 §10). */
export interface ReasonDetail {
  status?: number;
  mime?: string;
  limitBytes?: number;
  proxy?: boolean; // 407: "network proxy requires sign-in"
  challenge?: boolean; // render-failed on a bot challenge
}

/** FetchSkipCode → the short, plain reason stored in SkippedSource.reason (05 §10). */
export function reasonFor(code: FetchSkipCode, d: ReasonDetail = {}): string {
  switch (code) {
    case 'invalid-url':
      return 'not a valid web address';
    case 'blocked-scheme':
      return 'only http and https links are supported';
    case 'credentials-in-url':
      return 'links with embedded credentials are not supported';
    case 'dns-failure':
      return 'site could not be found';
    case 'connect-failure':
      return 'could not connect to the site';
    case 'tls-error':
      return "site's security certificate was not trusted";
    case 'timeout':
      return 'fetch timed out';
    case 'too-large':
      return `file was too large (limit ${Math.round((d.limitBytes ?? 0) / (1024 * 1024))} MB)`;
    case 'too-many-redirects':
      return 'too many redirects';
    case 'http-not-found':
      return 'page not found (404)';
    case 'http-gone':
      return 'page no longer exists (410)';
    case 'http-client-error':
      return `site refused the request (HTTP ${d.status ?? 400})`;
    case 'http-server-error':
      return `site returned an error (HTTP ${d.status ?? 500})`;
    case 'rate-limited':
      return 'site is rate limiting requests';
    case 'login-required':
      return d.proxy ? 'network proxy requires sign-in' : 'page required login';
    case 'paywall':
      return 'page required a subscription';
    case 'unsupported-type':
      return `unsupported content type (${d.mime ?? 'unknown'})`;
    case 'empty-content':
      return 'page had no readable content';
    case 'render-failed':
      return d.challenge ? 'site blocked automated access' : 'page could not be rendered';
    case 'blocked-private-address':
      return 'link redirected to a private network address';
  }
}

/** Thrown (never returned) when ctx.signal aborts; the pipeline treats it as cancellation (05 §2). */
export function abortError(): DOMException {
  return new DOMException('The fetch was aborted', 'AbortError');
}

export function isAbortError(e: unknown): boolean {
  return (e instanceof Error || e instanceof DOMException) && e.name === 'AbortError';
}

/** Network failure classes a transport reports; mapped to skip codes per 05 §10. */
export type NetErrorKind = 'dns' | 'dns-temporary' | 'connect' | 'reset' | 'tls' | 'timeout' | 'other';

export class TransportError extends Error {
  constructor(
    readonly kind: NetErrorKind,
    readonly netCode: string,
  ) {
    super(`transport error ${netCode}`);
    this.name = 'TransportError';
  }
}

/** Chromium `net::ERR_*` names and Node errno codes → NetErrorKind. */
export function classifyNetError(codeOrMessage: string): NetErrorKind {
  const s = codeOrMessage.toUpperCase();
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(s)) return 'dns';
  if (/ERR_NAME_RESOLUTION_FAILED|EAI_AGAIN|ERR_DNS_TIMED_OUT/.test(s)) return 'dns-temporary';
  if (/ERR_CERT_|ERR_SSL_|CERT_|SSL|TLS|UNABLE_TO_VERIFY|SELF_SIGNED/.test(s)) return 'tls';
  if (/ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|ETIMEDOUT/.test(s)) return 'timeout';
  if (/ERR_CONNECTION_RESET|ECONNRESET|ERR_EMPTY_RESPONSE|EPIPE|ERR_CONNECTION_CLOSED|UND_ERR_SOCKET/.test(s)) {
    return 'reset';
  }
  return /REFUSED|UNREACH|DISCONNECTED/.test(s) ? 'connect' : 'other';
}

export function netKindToSkip(kind: NetErrorKind): FetchSkipCode {
  switch (kind) {
    case 'dns':
    case 'dns-temporary':
      return 'dns-failure';
    case 'tls':
      return 'tls-error';
    case 'timeout':
      return 'timeout';
    default:
      return 'connect-failure';
  }
}

/** Non-2xx status → skip code (05 §10). */
export function httpErrorCode(status: number): FetchSkipCode {
  if (status === 404) return 'http-not-found';
  if (status === 410) return 'http-gone';
  if (status === 429) return 'rate-limited';
  return status >= 500 ? 'http-server-error' : 'http-client-error';
}

/** Retried once after 1 s (05 §9 "Network errors (reset, DNS temp failure)"). */
export function isRetryableNet(kind: NetErrorKind): boolean {
  return kind === 'reset' || kind === 'dns-temporary';
}
