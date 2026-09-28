import type { Session } from 'electron';
import type { NetworkConfigurator } from './types';

/**
 * Public network configuration (05 §4.2, HOOK-FETCH-01): system proxy and Chromium's default
 * certificate verification. No custom CA, no proxy credentials, no certificate-verify override.
 */
export const configureSession: NetworkConfigurator = async (ses) => {
  await ses.setProxy({ mode: 'system' });
};

/** Clears the fetch session's cookies when a job ends, so no state carries across jobs (05 §4.2). */
export async function clearJobCookies(ses: Pick<Session, 'clearStorageData'>): Promise<void> {
  await ses.clearStorageData({ storages: ['cookies'] });
}

/** `Accept-Language` from the system languages with q-values, `en;q=0.5` as fallback (05 §4.3). */
export function acceptLanguage(langs: readonly string[]): string {
  const uniq = [...new Set(langs.filter((l) => /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(l)))].slice(0, 6);
  const parts = uniq.map((l, i) => (i === 0 ? l : `${l};q=${Math.max(0.6, 1 - i * 0.1).toFixed(1)}`));
  if (!uniq.some((l) => l.toLowerCase() === 'en' || l.toLowerCase().startsWith('en-'))) parts.push('en;q=0.5');
  return parts.join(',') || 'en;q=0.5';
}

/** `<Chromium UA> ELI5Learner/<appVersion>` (05 §4.3); the render window uses the same string. */
export function fetchUserAgent(chromiumUa: string, appVersion: string): string {
  return `${chromiumUa} ELI5Learner/${appVersion}`;
}

/** §4.3 request headers. Never Authorization, Cookie or Referer. */
export function requestHeaders(userAgent: string, langs: readonly string[]): Record<string, string> {
  return {
    'User-Agent': userAgent,
    Accept: 'text/html,application/xhtml+xml;q=0.9,application/pdf;q=0.8,image/*;q=0.7,*/*;q=0.5',
    'Accept-Language': acceptLanguage(langs),
    DNT: '1',
    'Sec-GPC': '1',
  };
}
