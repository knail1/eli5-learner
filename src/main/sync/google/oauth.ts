/**
 * Desktop Google sign-in for personal sync (16 §3.2): the installed-app flow of RFC 8252 with a
 * loopback redirect on 127.0.0.1, PKCE S256 and a random `state`, in the system browser.
 *
 * - The client (`{clientId, clientSecret}`) comes from the Keychain (`sync.google.client`), pasted in
 *   Settings > Sync, or in development from `ELI5_GOOGLE_CLIENT_ID`/`ELI5_GOOGLE_CLIENT_SECRET`
 *   (HOOK-SYNC-02). Google treats a desktop secret as non-confidential, but it is never committed,
 *   compiled in, logged or sent over IPC.
 * - The refresh token lives in the Keychain (`sync.google.refreshToken`); the access token only in
 *   memory, refreshed 5 minutes before it expires.
 * - `invalid_grant` deletes the refresh token and reports "Sign in again to keep syncing".
 * - While sync is off (or not allowed) nothing here makes a request (16 acceptance criterion 1).
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { KeyStore } from '../../config';
import { SYNC_CONSENT_URL, isSyncConsentUrl, log } from '../../security';
import type { AccessTokenSource, GoogleClient, SyncClientSource } from '../types';
import { SyncError } from '../types';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
/** All three are non-sensitive (16 §3.1). Never `drive`, `drive.readonly` or `drive.metadata*`. */
export const SYNC_SCOPES = ['openid', 'email', DRIVE_APPDATA_SCOPE] as const;
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
export const REFRESH_MARGIN_MS = 5 * 60_000;
export const CALLBACK_PATH = '/callback';
/** Time limit for one token, userinfo or revoke request. */
export const AUTH_REQUEST_TIMEOUT_MS = 30_000;

export const CLIENT_ACCOUNT = 'sync.google.client' as const;
export const REFRESH_ACCOUNT = 'sync.google.refreshToken' as const;

/** `<digits>-<id>.apps.googleusercontent.com`. */
const CLIENT_ID_RE = /^\d{1,32}-[a-z0-9]{1,64}\.apps\.googleusercontent\.com$/;
const MAX_CLIENT_JSON = 16 * 1024;

const notConfigured = (msg?: string): SyncError => new SyncError('E_SYNC_NOT_CONFIGURED', msg);

function validClient(clientId: unknown, clientSecret: unknown): GoogleClient | null {
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string') return null;
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (!CLIENT_ID_RE.test(id) || secret.length < 8 || secret.length > 256 || /\s/.test(secret)) return null;
  return { clientId: id, clientSecret: secret };
}

/**
 * Accepts the JSON Google downloads for a Desktop client (`{"installed": {client_id, client_secret,
 * ...}}`) or the stored shape `{clientId, clientSecret}`. A Web client is refused: the loopback
 * flow needs a Desktop client.
 */
export function parseClientJson(text: string): GoogleClient {
  if (text.length > MAX_CLIENT_JSON) throw notConfigured('That file is too large to be a Google client');
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw notConfigured('That is not a Google client JSON file');
  }
  if (typeof j !== 'object' || j === null) throw notConfigured('That is not a Google client JSON file');
  const o = j as Record<string, unknown>;
  if (o.web !== undefined && o.installed === undefined) {
    throw notConfigured('Use an OAuth client of type "Desktop app", not "Web application"');
  }
  const inner = (typeof o.installed === 'object' && o.installed !== null ? o.installed : o) as Record<string, unknown>;
  const c = validClient(inner.client_id ?? inner.clientId, inner.client_secret ?? inner.clientSecret);
  if (!c) throw notConfigured('That file has no valid Desktop client id and secret');
  return c;
}

const b64url = (b: Buffer): string => b.toString('base64url');

/** PKCE (RFC 7636): a 43-char verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function buildConsentUrl(p: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  /** Adds `prompt=consent`, only when no refresh token is stored (16 §3.2 step 1). */
  forceConsent: boolean;
}): string {
  const u = new URL(SYNC_CONSENT_URL);
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SYNC_SCOPES.join(' '));
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', p.state);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('include_granted_scopes', 'true');
  if (p.forceConsent) u.searchParams.set('prompt', 'consent');
  return u.href;
}

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'",
  'referrer-policy': 'no-referrer',
};
const page = (msg: string): string =>
  `<!doctype html><meta charset="utf-8"><title>ELI5 Learner</title><p style="font:16px system-ui;margin:3em">${msg}</p>`;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
}

export interface GoogleOAuthDeps {
  keys: KeyStore;
  /** `sync.enabled` and the sync policy's `allowed`; false means no request of any kind. */
  enabled: () => boolean;
  clientSource?: () => SyncClientSource;
  /** `safeOpenExternal` bound to the app (12 §7.5); returns false when refused. */
  openExternal: (url: string) => Promise<boolean>;
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Called when the grant is lost (`invalid_grant`), with the user text. */
  onSignedOut?: (message: string) => void;
}

export class GoogleOAuth implements AccessTokenSource {
  private access: { token: string; expiresAt: number } | undefined;
  private refreshing: Promise<string> | undefined;
  private signingIn = false;
  /** Bumped whenever the grant is dropped, so an in-flight refresh cannot bring it back. */
  private generation = 0;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: GoogleOAuthDeps) {
    this.fetchFn = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = deps.now ?? Date.now;
  }

  // ------------------------------------------------------------------------------- the client

  /** Validates and stores the pasted client JSON (write-only: it is never read back over IPC). */
  async setClient(json: string): Promise<void> {
    const c = parseClientJson(json);
    const prev = await this.storedClient();
    await this.deps.keys.set(CLIENT_ACCOUNT, JSON.stringify(c));
    // A refresh token belongs to the client that issued it.
    if (prev && prev.clientId !== c.clientId) await this.forget();
  }

  /** Removes the client and, with it, the grant. Local only. */
  async clearClient(): Promise<void> {
    await this.deps.keys.delete(CLIENT_ACCOUNT);
    await this.forget();
  }

  /** True when a client is available from the policy's source (no network). */
  async configured(): Promise<boolean> {
    try {
      return (await this.client()) !== null;
    } catch {
      return false;
    }
  }

  async signedIn(): Promise<boolean> {
    return this.deps.keys.has(REFRESH_ACCOUNT);
  }

  private async storedClient(): Promise<GoogleClient | null> {
    const raw = await this.deps.keys.get(CLIENT_ACCOUNT);
    if (!raw) return null;
    try {
      return parseClientJson(raw);
    } catch {
      return null;
    }
  }

  /** The client per HOOK-SYNC-02: managed, none, or the user's (Keychain, then the dev env seed). */
  private async client(): Promise<GoogleClient | null> {
    const source = this.deps.clientSource?.() ?? 'user';
    if (source === 'none') return null;
    if (typeof source === 'object') return source.load();
    const stored = await this.storedClient();
    if (stored) return stored;
    if (this.deps.isPackaged) return null; // the packaged app has no .env (16 §3.2)
    const env = this.deps.env ?? {};
    return validClient(env.ELI5_GOOGLE_CLIENT_ID, env.ELI5_GOOGLE_CLIENT_SECRET);
  }

  private async requireClient(): Promise<GoogleClient> {
    const c = await this.client();
    if (!c) throw notConfigured();
    return c;
  }

  private assertEnabled(): void {
    if (!this.deps.enabled()) throw new SyncError('E_SYNC_DISABLED', 'Sync is off');
  }

  // -------------------------------------------------------------------------------- sign-in

  /**
   * The loopback flow (16 §3.2 steps 1–5). Resolves with the account email when Google reports one.
   * Rejects with `E_SYNC_AUTH` on cancel, timeout, abort or a grant without `drive.appdata`.
   */
  async signIn(signal?: AbortSignal): Promise<{ account?: string }> {
    this.assertEnabled();
    if (this.signingIn) throw new SyncError('E_SYNC_AUTH', 'A sign-in is already in progress');
    this.signingIn = true;
    try {
      const client = await this.requireClient();
      const forceConsent = !(await this.signedIn());
      const gen = this.generation;
      const { verifier, challenge } = pkcePair();
      const state = b64url(randomBytes(24));
      const { code, redirectUri } = await this.awaitCallback(
        (redirectUri) => buildConsentUrl({ clientId: client.clientId, redirectUri, challenge, state, forceConsent }),
        state,
        signal,
      );
      const tok = await this.tokenRequest({
        grant_type: 'authorization_code',
        code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      });
      if (!tok.access_token) throw new SyncError('E_SYNC_AUTH', 'Google did not return an access token');
      const granted = new Set((tok.scope ?? '').split(/\s+/));
      if (!granted.has(DRIVE_APPDATA_SCOPE)) {
        throw new SyncError('E_SYNC_AUTH', 'Allow ELI5 Learner to use its own app data in Google Drive to sync');
      }
      if (gen !== this.generation) throw new SyncError('E_SYNC_AUTH', 'Sign-in was cancelled');
      if (tok.refresh_token) await this.deps.keys.set(REFRESH_ACCOUNT, tok.refresh_token);
      else if (!(await this.signedIn())) throw new SyncError('E_SYNC_AUTH', 'Google did not return a refresh token');
      this.access = { token: tok.access_token, expiresAt: this.now() + (tok.expires_in ?? 3600) * 1000 };
      log.info('sync.auth.signed-in', { step: 'exchange' });
      const account = await this.userEmail(tok.access_token).catch(() => undefined);
      return account ? { account } : {};
    } finally {
      this.signingIn = false;
    }
  }

  /**
   * Starts the loopback listener, opens the consent page and waits for exactly one
   * `GET /callback` with the matching `state`. Other requests get 404 or 400 and are ignored.
   */
  private awaitCallback(
    consentUrl: (redirectUri: string) => string,
    state: string,
    signal?: AbortSignal,
  ): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (settled || req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
          res.writeHead(404, PAGE_HEADERS).end(page('Not found.'));
          return;
        }
        if (url.searchParams.get('state') !== state) {
          log.warn('sync.auth.callback-rejected', { code: 'state' });
          res.writeHead(400, PAGE_HEADERS).end(page('This sign-in link is not valid.'));
          return;
        }
        const code = url.searchParams.get('code');
        if (url.searchParams.get('error') || !code) {
          res.writeHead(200, PAGE_HEADERS).end(page('Sign-in was cancelled. You can close this tab.'));
          finish(new SyncError('E_SYNC_AUTH', 'Sign-in was cancelled'));
          return;
        }
        res.writeHead(200, PAGE_HEADERS).end(page('You are signed in. You can close this tab.'));
        finish(null, code);
      });
      let redirectUri = '';
      const onAbort = (): void => finish(new SyncError('E_SYNC_AUTH', 'Sign-in was cancelled'));
      const finish = (err: Error | null, code?: string): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        server.close();
        server.closeAllConnections();
        if (err) reject(err);
        else resolve({ code: code!, redirectUri });
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      server.on('error', () => finish(new SyncError('E_SYNC_AUTH', 'Could not start the sign-in listener')));
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
        timer = setTimeout(
          () => finish(new SyncError('E_SYNC_AUTH', 'Sign-in timed out')),
          this.deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
        );
        timer.unref?.();
        const url = consentUrl(redirectUri);
        if (!isSyncConsentUrl(url)) return finish(new SyncError('E_SYNC_AUTH', 'Refused to open the sign-in page'));
        this.deps.openExternal(url).then(
          (ok) => {
            if (!ok) finish(new SyncError('E_SYNC_AUTH', 'Could not open the browser'));
          },
          () => finish(new SyncError('E_SYNC_AUTH', 'Could not open the browser')),
        );
      });
    });
  }

  // --------------------------------------------------------------------------- access tokens

  /** AccessTokenSource: a cached token, refreshed 5 minutes before expiry; one refresh at a time. */
  async accessToken(signal?: AbortSignal): Promise<string> {
    this.assertEnabled();
    if (signal?.aborted) throw new SyncError('E_SYNC_ABORTED', 'Aborted');
    if (this.access && this.access.expiresAt - REFRESH_MARGIN_MS > this.now()) return this.access.token;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  invalidate(): void {
    this.access = undefined;
  }

  private async refresh(): Promise<string> {
    const gen = this.generation;
    const refreshToken = await this.deps.keys.get(REFRESH_ACCOUNT);
    if (!refreshToken) throw new SyncError('E_SYNC_AUTH');
    const client = await this.requireClient();
    const tok = await this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    if (!tok.access_token) throw new SyncError('E_SYNC_AUTH', 'Google did not return an access token');
    // Signed out (or the client changed) while this refresh was in flight: keep nothing.
    if (gen !== this.generation) throw new SyncError('E_SYNC_AUTH');
    if (tok.refresh_token && tok.refresh_token !== refreshToken) {
      await this.deps.keys.set(REFRESH_ACCOUNT, tok.refresh_token);
    }
    this.access = { token: tok.access_token, expiresAt: this.now() + (tok.expires_in ?? 3600) * 1000 };
    return tok.access_token;
  }

  /** POSTs to the token endpoint. `invalid_grant` drops the grant (16 §3.2 step 6). */
  private async tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
    let res: Response;
    try {
      res = await this.fetchFn(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new SyncError('E_SYNC_HTTP', 'Could not reach Google');
    }
    let body: TokenResponse = {};
    try {
      body = (await res.json()) as TokenResponse;
    } catch {
      body = {};
    }
    if (res.ok) return body;
    log.warn('sync.auth.token-failed', { status: res.status, code: body.error ?? 'unknown' });
    // Only a refresh proves the stored grant is gone; a bad authorization code (reused, expired)
    // must not delete a grant that still works.
    if (body.error === 'invalid_grant' && form.grant_type === 'refresh_token') {
      await this.forget();
      const err = new SyncError('E_SYNC_AUTH', undefined, res.status);
      this.deps.onSignedOut?.(err.message);
      throw err;
    }
    if (body.error === 'invalid_client' || body.error === 'unauthorized_client') {
      throw notConfigured('Google refused the client. Add your Desktop client again in Settings > Sync');
    }
    throw new SyncError(res.status >= 500 ? 'E_SYNC_HTTP' : 'E_SYNC_AUTH', undefined, res.status);
  }

  private async userEmail(token: string): Promise<string | undefined> {
    const res = await this.fetchFn(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { email?: unknown };
    return typeof j.email === 'string' && j.email.length <= 320 ? j.email : undefined;
  }

  // ------------------------------------------------------------------------------- sign-out

  /**
   * Revokes the grant at Google (best effort, only while sync is on) and deletes it locally. With
   * sync off, only the local copy is deleted: no request is made.
   */
  async signOut(): Promise<void> {
    const token = await this.deps.keys.get(REFRESH_ACCOUNT);
    if (token && this.deps.enabled()) {
      try {
        await this.fetchFn(GOOGLE_REVOKE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }).toString(),
          signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
        });
      } catch {
        log.warn('sync.auth.revoke-failed', { step: 'revoke' });
      }
    }
    await this.forget();
  }

  private async forget(): Promise<void> {
    this.generation++;
    this.access = undefined;
    await this.deps.keys.delete(REFRESH_ACCOUNT);
  }
}
