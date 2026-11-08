/**
 * Desktop OAuth (16 §3.2) against a fake token endpoint: loopback + PKCE S256 + state, consent only
 * without a stored refresh token, state mismatch, cancel, timeout, abort, invalid_grant, refresh
 * margin, the client JSON, and the HOOK-SYNC-02 client sources. Client values are assembled at
 * runtime so the repository never contains secret-shaped strings.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryKeyStore } from '../../../../src/main/config';
import { isSyncConsentUrl, SYNC_CONSENT_URL } from '../../../../src/main/security';
import {
  DRIVE_APPDATA_SCOPE,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  GoogleOAuth,
  buildConsentUrl,
  parseClientJson,
  pkcePair,
  type GoogleOAuthDeps,
} from '../../../../src/main/sync';
import { allowLocalPort } from '../../../helpers/net-guard';

const CLIENT_ID = ['123456789012', 'a1b2c3d4'.repeat(4)].join('-') + '.apps.' + 'googleusercontent.com';
const CLIENT_SECRET = ['GOC', 'SPX-', 'k'.repeat(28)].join('');
const OTHER_ID = ['987654321098', 'f0e1d2c3'.repeat(4)].join('-') + '.apps.' + 'googleusercontent.com';
const REFRESH = ['1//', 'r'.repeat(40)].join('');
const SCOPE = `openid ${DRIVE_APPDATA_SCOPE} https://www.googleapis.com/auth/userinfo.email`;

const installedJson = (id = CLIENT_ID, secret = CLIENT_SECRET) =>
  JSON.stringify({ installed: { client_id: id, client_secret: secret, redirect_uris: ['http://localhost'] } });

interface TokenCall {
  form: URLSearchParams;
}

/** Fake Google endpoints: token, userinfo, revoke. */
function fakeGoogle() {
  const calls: TokenCall[] = [];
  const all: string[] = [];
  let nextAccess = 0;
  const g = {
    calls,
    all,
    revoked: [] as string[],
    /** What the token endpoint answers next; default success. */
    respond: undefined as undefined | ((form: URLSearchParams) => Response),
    scope: SCOPE,
    issueRefresh: true,
    fetch: (async (input, init) => {
      const url = String(input);
      all.push(url);
      if (url === GOOGLE_TOKEN_URL) {
        const form = new URLSearchParams(String(init?.body));
        calls.push({ form });
        if (g.respond) return g.respond(form);
        nextAccess++;
        const body: Record<string, unknown> = {
          access_token: `at-${nextAccess}`,
          expires_in: 3600,
          scope: g.scope,
          token_type: 'Bearer',
        };
        if (form.get('grant_type') === 'authorization_code' && g.issueRefresh) body.refresh_token = REFRESH;
        return Response.json(body);
      }
      if (url === GOOGLE_USERINFO_URL) return Response.json({ email: 'reader@example.com', sub: '1' });
      if (url === GOOGLE_REVOKE_URL) {
        g.revoked.push(new URLSearchParams(String(init?.body)).get('token') ?? '');
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch,
  };
  return g;
}

/** Plays the browser: checks the consent URL, then calls the loopback redirect. */
function browser(
  behave: (u: URL, redirect: URL) => Promise<void> | void = async (u, redirect) => {
    redirect.searchParams.set('state', u.searchParams.get('state')!);
    redirect.searchParams.set('code', 'auth-code-1');
    await hit(redirect);
  },
) {
  const opened: URL[] = [];
  const openExternal = async (raw: string): Promise<boolean> => {
    const u = new URL(raw);
    opened.push(u);
    const redirect = new URL(u.searchParams.get('redirect_uri')!);
    allowLocalPort(Number(redirect.port));
    // Let signIn's promise wiring finish before the browser comes back.
    setTimeout(() => void behave(u, redirect), 0);
    return true;
  };
  return { opened, openExternal };
}

/** A browser request to the loopback listener (node:http: the net guard allows registered ports). */
function hit(url: URL, method = 'GET'): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    req.end();
  });
}

let now = 1_800_000_000_000;
afterEach(() => {
  now = 1_800_000_000_000;
});

function make(over: Partial<GoogleOAuthDeps> = {}, seedClient = true) {
  const keys = new MemoryKeyStore(
    seedClient ? { 'sync.google.client': JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }) } : {},
  );
  const google = fakeGoogle();
  const b = browser();
  const signedOut: string[] = [];
  let enabled = true;
  const oauth = new GoogleOAuth({
    keys,
    enabled: () => enabled,
    openExternal: b.openExternal,
    isPackaged: true,
    fetch: google.fetch,
    now: () => now,
    onSignedOut: (m) => signedOut.push(m),
    ...over,
  });
  return { oauth, keys, google, browser: b, signedOut, setEnabled: (v: boolean) => (enabled = v) };
}

describe('client JSON (HOOK-SYNC-02)', () => {
  it('accepts the downloaded Desktop client file and the stored shape', () => {
    expect(parseClientJson(installedJson())).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(parseClientJson(JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }))).toEqual({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
  });

  it('refuses web clients, junk and invalid values with E_SYNC_NOT_CONFIGURED', () => {
    const web = JSON.stringify({ web: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } });
    expect(() => parseClientJson(web)).toThrow(/Desktop app/);
    for (const bad of [
      'nope',
      '[]',
      'null',
      installedJson('not-a-client-id'),
      installedJson(CLIENT_ID, 'short'),
      'x'.repeat(20_000),
    ]) {
      expect(() => parseClientJson(bad)).toThrow(expect.objectContaining({ code: 'E_SYNC_NOT_CONFIGURED' }));
    }
  });

  it('setClient stores the normalized client; changing the client drops the grant', async () => {
    const { oauth, keys } = make({}, false);
    expect(await oauth.configured()).toBe(false);
    await oauth.setClient(installedJson());
    expect(JSON.parse((await keys.get('sync.google.client'))!)).toEqual({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    expect(await oauth.configured()).toBe(true);
    await keys.set('sync.google.refreshToken', REFRESH);
    await oauth.setClient(installedJson()); // same client keeps the grant
    expect(await oauth.signedIn()).toBe(true);
    await oauth.setClient(installedJson(OTHER_ID));
    expect(await oauth.signedIn()).toBe(false);
    await keys.set('sync.google.refreshToken', REFRESH);
    await oauth.clearClient();
    expect(await oauth.configured()).toBe(false);
    expect(await oauth.signedIn()).toBe(false);
  });

  it('the env seed works only in unpackaged builds; policy sources none and managed', async () => {
    const env = { ELI5_GOOGLE_CLIENT_ID: CLIENT_ID, ELI5_GOOGLE_CLIENT_SECRET: CLIENT_SECRET };
    expect(await make({ env, isPackaged: true }, false).oauth.configured()).toBe(false);
    expect(await make({ env, isPackaged: false }, false).oauth.configured()).toBe(true);
    expect(await make({ clientSource: () => 'none' }).oauth.configured()).toBe(false);
    const managed = make(
      {
        clientSource: () => ({
          kind: 'managed',
          load: async () => ({ clientId: OTHER_ID, clientSecret: CLIENT_SECRET }),
        }),
      },
      false,
    );
    expect(await managed.oauth.configured()).toBe(true);
  });
});

describe('consent URL (12 §7.5)', () => {
  it('is the fixed endpoint with PKCE S256, state, offline access and the three scopes', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    const url = buildConsentUrl({
      clientId: CLIENT_ID,
      redirectUri: 'http://127.0.0.1:5555/callback',
      challenge,
      state: 's1',
      forceConsent: false,
    });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(SYNC_CONSENT_URL);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: 'http://127.0.0.1:5555/callback',
      response_type: 'code',
      scope: `openid email ${DRIVE_APPDATA_SCOPE}`,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's1',
      access_type: 'offline',
      include_granted_scopes: 'true',
    });
    expect(isSyncConsentUrl(url)).toBe(true);
  });

  it('the allow-list accepts only that endpoint', () => {
    expect(isSyncConsentUrl('https://accounts.google.com/o/oauth2/v2/auth?x=1')).toBe(true);
    for (const bad of [
      'http://accounts.google.com/o/oauth2/v2/auth',
      'https://accounts.google.com.evil.test/o/oauth2/v2/auth',
      'https://accounts.google.com/o/oauth2/v2/auth/x',
      'https://user:pw@accounts.google.com/o/oauth2/v2/auth',
      'https://accounts.google.com/o/oauth2/v2/auth#frag',
      'not a url',
    ]) {
      expect(isSyncConsentUrl(bad)).toBe(false);
    }
  });
});

describe('sign-in (loopback, 16 §3.2)', () => {
  it('opens the consent page, accepts the callback, exchanges the code with the verifier and stores the refresh token', async () => {
    const { oauth, keys, google, browser: b } = make();
    const r = await oauth.signIn();
    expect(r).toEqual({ account: 'reader@example.com' });
    const consent = b.opened[0]!;
    expect(consent.searchParams.get('prompt')).toBe('consent'); // no refresh token yet
    const redirect = new URL(consent.searchParams.get('redirect_uri')!);
    expect(redirect.hostname).toBe('127.0.0.1');
    expect(redirect.pathname).toBe('/callback');
    const form = google.calls[0]!.form;
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('auth-code-1');
    expect(form.get('redirect_uri')).toBe(redirect.href);
    expect(form.get('client_secret')).toBe(CLIENT_SECRET);
    const challenge = createHash('sha256').update(form.get('code_verifier')!).digest('base64url');
    expect(consent.searchParams.get('code_challenge')).toBe(challenge);
    expect(await keys.get('sync.google.refreshToken')).toBe(REFRESH);
    expect(await oauth.accessToken()).toBe('at-1');
    // The listener is closed after the one callback.
    await expect(hit(redirect)).rejects.toThrow();
  });

  it('skips prompt=consent when a refresh token is stored', async () => {
    const { oauth, keys, google, browser: b } = make();
    await keys.set('sync.google.refreshToken', REFRESH);
    google.issueRefresh = false;
    await oauth.signIn();
    expect(b.opened[0]!.searchParams.has('prompt')).toBe(false);
    expect(await keys.get('sync.google.refreshToken')).toBe(REFRESH);
  });

  it('ignores a callback with the wrong state, wrong path or wrong method, then accepts the right one', async () => {
    const statuses: number[] = [];
    let browserDone!: () => void;
    const finished = new Promise<void>((r) => (browserDone = r));
    const b = browser(async (u, redirect) => {
      const wrong = new URL(redirect);
      wrong.searchParams.set('state', 'forged');
      wrong.searchParams.set('code', 'evil');
      statuses.push((await hit(wrong)).status);
      const other = new URL(redirect);
      other.pathname = '/other';
      statuses.push((await hit(other)).status);
      statuses.push((await hit(redirect, 'POST')).status);
      redirect.searchParams.set('state', u.searchParams.get('state')!);
      redirect.searchParams.set('code', 'good');
      statuses.push((await hit(redirect)).status);
      browserDone();
    });
    const { oauth, google } = make({ openExternal: b.openExternal });
    await oauth.signIn();
    await finished;
    expect(statuses).toEqual([400, 404, 404, 200]);
    expect(google.calls.map((c) => c.form.get('code'))).toEqual(['good']);
  });

  it('fails with E_SYNC_AUTH when the user cancels at Google', async () => {
    const b = browser(async (u, redirect) => {
      redirect.searchParams.set('state', u.searchParams.get('state')!);
      redirect.searchParams.set('error', 'access_denied');
      await hit(redirect);
    });
    const { oauth, google } = make({ openExternal: b.openExternal });
    await expect(oauth.signIn()).rejects.toMatchObject({ code: 'E_SYNC_AUTH', message: 'Sign-in was cancelled' });
    expect(google.calls).toEqual([]);
  });

  it('times out, and stops on abort', async () => {
    const idle = browser(() => {});
    const t = make({ openExternal: idle.openExternal, timeoutMs: 30 });
    await expect(t.oauth.signIn()).rejects.toMatchObject({ code: 'E_SYNC_AUTH', message: 'Sign-in timed out' });

    const ac = new AbortController();
    const a = make({ openExternal: browser(() => ac.abort()).openExternal });
    await expect(a.oauth.signIn(ac.signal)).rejects.toMatchObject({ code: 'E_SYNC_AUTH' });
    // A second sign-in can start once the first has ended.
    await expect(a.oauth.signIn(AbortSignal.abort())).rejects.toMatchObject({ code: 'E_SYNC_AUTH' });
  });

  it('fails when the browser cannot be opened', async () => {
    const { oauth } = make({ openExternal: async () => false });
    await expect(oauth.signIn()).rejects.toMatchObject({ message: 'Could not open the browser' });
  });

  it('refuses a grant without drive.appdata (granular consent unticked)', async () => {
    const { oauth, google, keys } = make();
    google.scope = 'openid email';
    await expect(oauth.signIn()).rejects.toMatchObject({ code: 'E_SYNC_AUTH' });
    expect(await keys.get('sync.google.refreshToken')).toBeNull();
  });

  it('needs a client first', async () => {
    const { oauth } = make({}, false);
    await expect(oauth.signIn()).rejects.toMatchObject({ code: 'E_SYNC_NOT_CONFIGURED' });
  });
});

describe('access tokens (16 §3.2 steps 5–6)', () => {
  it('refreshes 5 minutes before expiry, one refresh at a time', async () => {
    const { oauth, keys, google } = make();
    await keys.set('sync.google.refreshToken', REFRESH);
    const [a, b] = await Promise.all([oauth.accessToken(), oauth.accessToken()]);
    expect(a).toBe('at-1');
    expect(b).toBe('at-1');
    expect(google.calls).toHaveLength(1);
    expect(google.calls[0]!.form.get('grant_type')).toBe('refresh_token');
    now += 54 * 60_000;
    expect(await oauth.accessToken()).toBe('at-1');
    now += 2 * 60_000; // inside the 5-minute margin
    expect(await oauth.accessToken()).toBe('at-2');
    oauth.invalidate();
    expect(await oauth.accessToken()).toBe('at-3');
  });

  it('invalid_grant deletes the refresh token and reports "Sign in again to keep syncing"', async () => {
    const { oauth, keys, google, signedOut } = make();
    await keys.set('sync.google.refreshToken', REFRESH);
    google.respond = () => Response.json({ error: 'invalid_grant' }, { status: 400 });
    await expect(oauth.accessToken()).rejects.toMatchObject({
      code: 'E_SYNC_AUTH',
      message: 'Sign in again to keep syncing',
    });
    expect(await keys.get('sync.google.refreshToken')).toBeNull();
    expect(signedOut).toEqual(['Sign in again to keep syncing']);
    await expect(oauth.accessToken()).rejects.toMatchObject({ code: 'E_SYNC_AUTH' });
  });

  it('maps invalid_client to E_SYNC_NOT_CONFIGURED and 5xx to E_SYNC_HTTP', async () => {
    const { oauth, keys, google } = make();
    await keys.set('sync.google.refreshToken', REFRESH);
    google.respond = () => Response.json({ error: 'invalid_client' }, { status: 401 });
    await expect(oauth.accessToken()).rejects.toMatchObject({ code: 'E_SYNC_NOT_CONFIGURED' });
    google.respond = () => new Response('oops', { status: 503 });
    await expect(oauth.accessToken()).rejects.toMatchObject({ code: 'E_SYNC_HTTP' });
    expect(await keys.get('sync.google.refreshToken')).toBe(REFRESH);
  });

  it('a sign-out during an in-flight refresh keeps neither the access token nor a rotated refresh token', async () => {
    const { oauth, keys, google } = make();
    await keys.set('sync.google.refreshToken', REFRESH);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rotated = REFRESH.replace(/r/g, 's');
    google.respond = () => {
      // Answer only after the sign-out below has run.
      return new Response(
        new ReadableStream({
          async start(c) {
            await gate;
            c.enqueue(new TextEncoder().encode(JSON.stringify({ access_token: 'at-late', refresh_token: rotated })));
            c.close();
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    };
    const pending = oauth.accessToken();
    await new Promise((r) => setTimeout(r, 0));
    await oauth.signOut();
    release();
    await expect(pending).rejects.toMatchObject({ code: 'E_SYNC_AUTH' });
    expect(await keys.get('sync.google.refreshToken')).toBeNull();
    google.respond = undefined;
    await expect(oauth.accessToken()).rejects.toMatchObject({ code: 'E_SYNC_AUTH' }); // nothing cached
  });

  it('a failed code exchange (invalid_grant) keeps the grant that still works', async () => {
    const { oauth, keys, google, signedOut } = make();
    await keys.set('sync.google.refreshToken', REFRESH);
    google.respond = (form) =>
      form.get('grant_type') === 'authorization_code'
        ? Response.json({ error: 'invalid_grant' }, { status: 400 })
        : Response.json({ access_token: 'at-ok', expires_in: 3600 });
    await expect(oauth.signIn()).rejects.toMatchObject({ code: 'E_SYNC_AUTH' });
    expect(await keys.get('sync.google.refreshToken')).toBe(REFRESH);
    expect(signedOut).toEqual([]);
    expect(await oauth.accessToken()).toBe('at-ok');
  });

  it('stores a rotated refresh token', async () => {
    const { oauth, keys, google } = make();
    await keys.set('sync.google.refreshToken', REFRESH);
    const rotated = REFRESH.replace(/r/g, 's');
    google.respond = () => Response.json({ access_token: 'at-x', expires_in: 3600, refresh_token: rotated });
    await oauth.accessToken();
    expect(await keys.get('sync.google.refreshToken')).toBe(rotated);
  });
});

describe('sign-out', () => {
  it('revokes at Google while sync is on and deletes the grant', async () => {
    const { oauth, keys, google } = make();
    await keys.set('sync.google.refreshToken', REFRESH);
    await oauth.signOut();
    expect(google.revoked).toEqual([REFRESH]);
    expect(await oauth.signedIn()).toBe(false);
  });

  it('with sync off deletes the grant locally without any request', async () => {
    const { oauth, keys, google, setEnabled } = make();
    await keys.set('sync.google.refreshToken', REFRESH);
    setEnabled(false);
    await oauth.signOut();
    expect(google.all).toEqual([]);
    expect(await oauth.signedIn()).toBe(false);
  });
});
