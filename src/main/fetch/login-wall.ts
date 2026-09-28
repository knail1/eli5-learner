import { DETECT } from './constants';
import type { LoginSignature, PageSignals } from './types';

/** Login-wall and paywall classification (05 §7). */

export type SignalWeight = 'conclusive' | 'strong' | 'paywall';
export interface LoginSignal {
  weight: SignalWeight;
  source: 'http' | 'url' | 'dom' | 'signature';
  proxy?: boolean; // 407
}

const LOGIN_PATH =
  /(^|\/)(login|log-in|signin|sign-in|sso|saml2?|oauth2?|openid|authorize|auth|account\/login|session\/new)(\/|\?|$)/i;
const LOGIN_QUERY_KEYS = ['returnurl', 'return_to', 'redirect_uri', 'continue', 'relaystate', 'samlrequest'];
const LOGIN_HOST_LABELS = new Set(['login', 'signin', 'sso', 'auth', 'id', 'accounts', 'idp']);
export const LOGIN_HEADING = /sign in|log in|login|single sign-on/i;

/** Facts the worker extracts from a DOM for §7.1 (beyond PageSignals). */
export interface DomLoginFacts {
  signals: PageSignals;
  loginHeading: boolean; // title or h1 matches LOGIN_HEADING
  paywallMarkers: boolean; // §7.1 paywall row
  selectorHits: string[]; // LoginSignature.domSelector values present in the DOM
}

/** §7.1 HTTP rows. */
export function httpSignals(status: number, headers: Record<string, string>): LoginSignal[] {
  if (status === 407) return [{ weight: 'conclusive', source: 'http', proxy: true }];
  if (status === 401 || headers['www-authenticate'] !== undefined) return [{ weight: 'conclusive', source: 'http' }];
  return [];
}

/** LoginSignature match; a signature with a domSelector matches only when the DOM was inspected. */
function signatureMatches(sig: LoginSignature, u: URL, selectorHits: readonly string[] | null): boolean {
  if (sig.hostPattern && !sig.hostPattern.test(u.hostname)) return false;
  if (sig.urlPattern && !sig.urlPattern.test(u.href)) return false;
  if (sig.domSelector) return selectorHits !== null && selectorHits.includes(sig.domSelector);
  return !!(sig.hostPattern || sig.urlPattern);
}

/** Login URL check for a redirect hop or a final URL (§7.1 URL rows, §4.4 rule 5). */
export function urlSignals(
  target: string,
  requested: string,
  sigs: readonly LoginSignature[],
  selectorHits: readonly string[] | null = null,
): LoginSignal[] {
  let u: URL;
  let req: URL | null = null;
  try {
    u = new URL(target);
  } catch {
    return [];
  }
  try {
    req = new URL(requested);
  } catch {
    req = null;
  }
  const out: LoginSignal[] = [];
  const keys = [...u.searchParams.keys()].map((k) => k.toLowerCase());
  if (LOGIN_PATH.test(u.pathname) || keys.some((k) => LOGIN_QUERY_KEYS.includes(k))) {
    out.push({ weight: 'strong', source: 'url' });
  }
  const label = u.hostname.split('.')[0]?.toLowerCase() ?? '';
  if (req && req.hostname !== u.hostname && LOGIN_HOST_LABELS.has(label)) out.push({ weight: 'strong', source: 'url' });
  for (const sig of sigs) {
    if (signatureMatches(sig, u, selectorHits)) out.push({ weight: sig.kind, source: 'signature' });
  }
  return out;
}

/** §7.1 DOM rows; `status` adds the "403 with a strong DOM login signal" row. */
export function domSignals(f: DomLoginFacts, status = 200): LoginSignal[] {
  const out: LoginSignal[] = [];
  if (f.signals.hasPasswordField && f.signals.articleTextLength < DETECT.LOGIN_ARTICLE_MAX) {
    out.push({ weight: 'strong', source: 'dom' });
  }
  if (f.signals.formCount >= 1 && f.loginHeading) out.push({ weight: 'strong', source: 'dom' });
  if (status === 403 && out.length > 0) out.push({ weight: 'strong', source: 'http' });
  if (f.paywallMarkers) out.push({ weight: 'paywall', source: 'dom' });
  return out;
}

export type LoginVerdict =
  | { verdict: 'login-required'; proxy: boolean }
  | { verdict: 'paywall' }
  | { verdict: 'one-strong' } // §7.2 rule 3: decide after the render fallback
  | { verdict: 'none' };

/** §7.2 classification. */
export function classifyLogin(signals: readonly LoginSignal[], articleTextLength: number): LoginVerdict {
  const conclusive = signals.find((s) => s.weight === 'conclusive');
  if (conclusive) return { verdict: 'login-required', proxy: !!conclusive.proxy };
  const strong = signals.filter((s) => s.weight === 'strong').length;
  if (strong >= 2) return { verdict: 'login-required', proxy: false };
  if (signals.some((s) => s.weight === 'paywall') && articleTextLength < DETECT.LOGIN_ARTICLE_MAX) {
    return { verdict: 'paywall' };
  }
  if (strong === 1) return { verdict: 'one-strong' };
  return { verdict: 'none' };
}

/** True when a redirect hop must stop immediately (§4.4 rule 5): any login URL pattern or signature. */
export function isLoginHop(target: string, requested: string, sigs: readonly LoginSignature[]): boolean {
  return urlSignals(target, requested, sigs).length > 0;
}
