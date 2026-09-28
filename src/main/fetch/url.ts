import { isIP } from 'node:net';
import type { FetchSkipCode } from './types';

/** URL validation, normalization (05 §4.1) and the private-address guard (§4.4 rule 4, §8.2). */

export type UrlCheck =
  | { ok: true; url: URL; href: string } // href: normalized, fragment stripped (used for fetching and dedupe)
  | { ok: false; code: FetchSkipCode };

export function validateUrl(raw: string, base?: string): UrlCheck {
  let u: URL;
  try {
    u = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return { ok: false, code: 'invalid-url' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, code: 'blocked-scheme' };
  if (u.username || u.password) return { ok: false, code: 'credentials-in-url' };
  if (!u.hostname) return { ok: false, code: 'invalid-url' };
  // WHATWG URL already lowercases and IDNA-encodes the host; drop a trailing dot.
  if (u.hostname.endsWith('.') && u.hostname.length > 1) u.hostname = u.hostname.slice(0, -1);
  u.hash = '';
  return { ok: true, url: u, href: u.href };
}

/** Host without IPv6 brackets. */
export function bareHost(u: URL): string {
  const h = u.hostname;
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/** True for localhost, *.local, *.internal and literal loopback/private/link-local/unique-local IPs. */
export function isPrivateHostName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  return isIP(h) !== 0 && isPrivateIp(h);
}

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    const [a = 0, b = 0] = p;
    return (
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped?.[1]) return isPrivateIp(mapped[1]);
    return /^f[cd][0-9a-f]{2}:/.test(s) || /^fe[89ab][0-9a-f]:/.test(s);
  }
  return false;
}

/** Resolves a host name to addresses; injected so tests can fake DNS (05 §13). */
export type HostLookup = (host: string) => Promise<string[]>;

export const systemLookup: HostLookup = async (host) => {
  const { lookup } = await import('node:dns/promises');
  const res = await lookup(host, { all: true });
  return res.map((r) => r.address);
};

/**
 * 05 §4.4 rule 4: name checks first, then dns.lookup. Resolution failures fall through as
 * "not private" so the real request fails normally. `cache` is per render / per fetch.
 */
export async function isPrivateTarget(
  url: string | URL,
  lookup: HostLookup,
  cache: Map<string, boolean> = new Map(),
): Promise<boolean> {
  let u: URL;
  try {
    u = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return false;
  }
  const host = bareHost(u);
  const hit = cache.get(host);
  if (hit !== undefined) return hit;
  let priv = isPrivateHostName(host);
  if (!priv && isIP(host) === 0) {
    try {
      priv = (await lookup(host)).some(isPrivateIp);
    } catch {
      priv = false;
    }
  }
  cache.set(host, priv);
  return priv;
}

/** 05 §10: URLs are logged without query strings. */
export function logUrl(u: string): string {
  try {
    const p = new URL(u);
    return p.origin + p.pathname;
  } catch {
    return 'url:invalid';
  }
}
