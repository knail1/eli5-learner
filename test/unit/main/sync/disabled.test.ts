/**
 * 16 §1 principle 1 and acceptance criterion 1, 12 §11: with `sync.enabled=false` (the default),
 * or a policy that does not allow sync, no request reaches any Google endpoint. Every fetch the
 * module could make goes through the spy below, and net-guard fails any real socket.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULTS, MemoryKeyStore, type Settings } from '../../../../src/main/config';
import { Registry } from '../../../../src/main/editions';
import { registerPublicCapabilities } from '../../../../src/main/editions/public';
import { DEFAULT_SYNC_POLICY, GoogleOAuth, openSyncStore, syncActive } from '../../../../src/main/sync';

const DEV = '0b7c5e2a-1f3d-4c4e-9a8b-2d6f0e1c3b5a';
const REFRESH = ['1//', 'r'.repeat(40)].join('');
const withSync = (enabled: boolean): Settings => ({ ...DEFAULTS, sync: { ...DEFAULTS.sync, enabled } });

function harness(settings: Settings, allowed = true) {
  const requests: string[] = [];
  const spy: typeof fetch = async (input) => {
    requests.push(String(input));
    throw new Error('no request expected');
  };
  const reg = new Registry({ edition: 'public', getSettings: () => settings });
  registerPublicCapabilities(reg);
  if (!allowed) reg.registerSyncPolicy({ ...DEFAULT_SYNC_POLICY, allowed: false });
  const keys = new MemoryKeyStore({ 'sync.google.refreshToken': REFRESH });
  const opened: string[] = [];
  const oauth = new GoogleOAuth({
    keys,
    enabled: () => syncActive(reg, settings),
    openExternal: async (u) => {
      opened.push(u);
      return true;
    },
    isPackaged: true,
    fetch: spy,
  });
  return { reg, oauth, requests, opened, spy, keys };
}

describe('sync off makes no Google request (16 §1)', () => {
  it('is off by default', () => {
    expect(DEFAULTS.sync.enabled).toBe(false);
    expect(DEFAULTS.sync.inbox.enabled).toBe(false);
  });

  it.each([
    ['sync.enabled=false', withSync(false), true],
    ['policy disallows sync', withSync(true), false],
  ])('%s: no store, no token, no sign-in, no request', async (_name, settings, allowed) => {
    const h = harness(settings, allowed);
    expect(syncActive(h.reg, settings)).toBe(false);
    const store = openSyncStore(
      h.reg,
      settings,
      { auth: h.oauth, fetch: h.spy },
      { deviceId: DEV, isPrimary: () => true },
    );
    expect(store).toBeNull();
    await expect(h.oauth.accessToken()).rejects.toMatchObject({ code: 'E_SYNC_DISABLED' });
    await expect(h.oauth.signIn()).rejects.toMatchObject({ code: 'E_SYNC_DISABLED' });
    await h.oauth.signOut(); // local only
    expect(h.reg.syncStores().length).toBeGreaterThan(0); // building stores is inert too
    expect(h.requests).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(await h.keys.has('sync.google.refreshToken')).toBe(false);
  });

  it('turned on, the store is built behind the guard but still makes no request until used', () => {
    const settings = withSync(true);
    const h = harness(settings);
    const store = openSyncStore(
      h.reg,
      settings,
      { auth: h.oauth, fetch: h.spy },
      { deviceId: DEV, isPrimary: () => true },
    );
    expect(store?.id).toBe('google-drive-appdata');
    expect(h.requests).toEqual([]);
  });
});
