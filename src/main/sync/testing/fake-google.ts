/**
 * Test builds only (13 §6.1): stands in for the browser and Google's token endpoints so the real
 * loopback sign-in (16 §3.2) runs end to end in e2e with ELI5_SYNC_FAKE=1. `openExternal` "consents"
 * by calling the app's own 127.0.0.1 callback with the state it was given; `fetch` answers the token,
 * userinfo and revoke endpoints. Any other host is refused. Nothing in a packaged build imports it.
 */
import http from 'node:http';
import { DRIVE_APPDATA_SCOPE, GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL } from '../google/oauth';
import { isSyncConsentUrl } from '../../security';

export const FAKE_ACCOUNT = 'tester@example.com';

export interface FakeGoogle {
  openExternal(url: string): Promise<boolean>;
  fetch: typeof fetch;
  /** Consent pages opened so far. */
  readonly opened: number;
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

export function fakeGoogle(): FakeGoogle {
  let opened = 0;
  let issued = 0;
  return {
    get opened() {
      return opened;
    },
    async openExternal(url) {
      if (!isSyncConsentUrl(url)) return false;
      const u = new URL(url);
      const redirect = new URL(u.searchParams.get('redirect_uri') ?? '');
      if (redirect.hostname !== '127.0.0.1' || redirect.protocol !== 'http:') return false;
      opened++;
      redirect.searchParams.set('code', `fake-code-${opened}`);
      redirect.searchParams.set('state', u.searchParams.get('state') ?? '');
      setTimeout(() => {
        http.get(redirect, { agent: false }, (res) => res.resume()).on('error', () => {});
      }, 10);
      return true;
    },
    fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
      const bare = `${url.origin}${url.pathname}`;
      if (bare === GOOGLE_TOKEN_URL) {
        issued++;
        const grant = new URLSearchParams(String(init?.body ?? '')).get('grant_type');
        return json({
          access_token: `fake-access-${issued}`,
          expires_in: 3600,
          scope: `openid email ${DRIVE_APPDATA_SCOPE}`,
          ...(grant === 'authorization_code' ? { refresh_token: `fake-grant-${issued}` } : {}),
        });
      }
      if (bare === GOOGLE_USERINFO_URL) return json({ email: FAKE_ACCOUNT });
      if (bare === GOOGLE_REVOKE_URL) return new Response('', { status: 200 });
      throw new Error(`fake-google: unexpected request to ${url.origin}`);
    },
  };
}
