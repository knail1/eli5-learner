import { describe, expect, it, vi } from 'vitest';
import { classifyNetError, netKindToSkip, reasonFor } from '../../../../src/main/fetch/errors';
import { acceptLanguage, clearJobCookies, fetchUserAgent, requestHeaders } from '../../../../src/main/fetch/network';
import type { FetchSkipCode } from '../../../../src/main/fetch/types';

describe('request headers (05 §4.3)', () => {
  it('appends the app token to the Chromium UA', () => {
    expect(fetchUserAgent('Mozilla/5.0 Chrome/140', '1.2.3')).toBe('Mozilla/5.0 Chrome/140 ELI5Learner/1.2.3');
  });

  it('builds Accept-Language with q-values and an en fallback', () => {
    expect(acceptLanguage(['fr-FR', 'de'])).toBe('fr-FR,de;q=0.9,en;q=0.5');
    expect(acceptLanguage(['en-US', 'es'])).toBe('en-US,es;q=0.9');
    expect(acceptLanguage([])).toBe('en;q=0.5');
    expect(acceptLanguage(['bad value\r\n'])).toBe('en;q=0.5');
  });

  it('never sets Authorization, Cookie or Referer; sends DNT and Sec-GPC', () => {
    const h = requestHeaders('UA', ['en-US']);
    const names = Object.keys(h).map((k) => k.toLowerCase());
    expect(names).not.toContain('authorization');
    expect(names).not.toContain('cookie');
    expect(names).not.toContain('referer');
    expect(h.DNT).toBe('1');
    expect(h['Sec-GPC']).toBe('1');
    expect(h.Accept).toBe('text/html,application/xhtml+xml;q=0.9,application/pdf;q=0.8,image/*;q=0.7,*/*;q=0.5');
  });

  it('clears only cookies on the fetch session at job end (05 §4.2)', async () => {
    const clearStorageData = vi.fn(async () => {});
    await clearJobCookies({ clearStorageData });
    expect(clearStorageData).toHaveBeenCalledWith({ storages: ['cookies'] });
  });
});

describe('skip reasons (05 §10)', () => {
  it('has a short plain reason for every code', () => {
    const codes: FetchSkipCode[] = [
      'invalid-url',
      'blocked-scheme',
      'credentials-in-url',
      'dns-failure',
      'connect-failure',
      'tls-error',
      'timeout',
      'too-large',
      'too-many-redirects',
      'http-not-found',
      'http-gone',
      'http-client-error',
      'http-server-error',
      'rate-limited',
      'login-required',
      'paywall',
      'unsupported-type',
      'empty-content',
      'render-failed',
      'blocked-private-address',
    ];
    for (const c of codes) {
      const r = reasonFor(c);
      expect(r.length).toBeGreaterThan(0);
      expect(r).not.toMatch(/ERR_|undefined|net::/);
    }
    expect(reasonFor('too-large', { limitBytes: 20 * 1024 * 1024 })).toBe('file was too large (limit 20 MB)');
    expect(reasonFor('http-client-error', { status: 451 })).toBe('site refused the request (HTTP 451)');
    expect(reasonFor('render-failed', { challenge: true })).toBe('site blocked automated access');
  });

  it('maps Chromium and Node network errors', () => {
    expect(netKindToSkip(classifyNetError('net::ERR_NAME_NOT_RESOLVED'))).toBe('dns-failure');
    expect(netKindToSkip(classifyNetError('ENOTFOUND'))).toBe('dns-failure');
    expect(netKindToSkip(classifyNetError('net::ERR_CERT_DATE_INVALID'))).toBe('tls-error');
    expect(netKindToSkip(classifyNetError('ECONNREFUSED'))).toBe('connect-failure');
    expect(classifyNetError('ECONNRESET')).toBe('reset');
    expect(classifyNetError('EAI_AGAIN')).toBe('dns-temporary');
    expect(netKindToSkip(classifyNetError('net::ERR_TIMED_OUT'))).toBe('timeout');
  });
});
