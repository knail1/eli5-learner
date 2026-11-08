/**
 * The sync service behind `eli5:sync:*` (16 §8) with the real engine, the real Google sign-in and
 * the in-memory store: the policy gate (HOOK-SYNC-01), the write-only client, sign-in only with
 * Sync on, Sync now, Delete cloud copy (then Sync off) and sign-out. No answer may carry a client
 * value or a token. Client values are assembled at runtime (13 §3).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryKeyStore } from '../../../../src/main/config';
import { NotAvailableInEdition } from '../../../../src/main/editions';
import {
  GoogleOAuth,
  GuardedStore,
  SyncEngine,
  SyncError,
  SyncStateStore,
  createSyncService,
  syncErrorMessage,
  type EngineTimers,
} from '../../../../src/main/sync';
import { FAKE_ACCOUNT, MemorySyncStore, fakeGoogle } from '../../../../src/main/sync/testing';
import type { SyncStatus } from '../../../../src/preload/contract';
import { allowLocalPort } from '../../../helpers/net-guard';
import { MemLibrary } from './mem-library';

const CLIENT_ID = ['123456789012', 'a1b2c3d4'.repeat(4)].join('-') + '.apps.' + 'googleusercontent.com';
const CLIENT_SECRET = ['GOC', 'SPX-', 'q'.repeat(28)].join('');
const CLIENT_JSON = JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } });
const DEV = '0b7c5e2a-1f3d-4c4e-9a8b-2d6f0e1c3b5a';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const inertTimers: EngineTimers = {
  setTimeout: () => ({}),
  clearTimeout: () => {},
  setInterval: () => ({}),
  clearInterval: () => {},
};

async function harness(o: { allowed?: boolean; locked?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'eli5-sync-service-'));
  dirs.push(dir);
  const ctl = { enabled: false, allowed: o.allowed ?? true };
  const active = () => ctl.enabled && ctl.allowed;
  const keys = new MemoryKeyStore();
  const google = fakeGoogle();
  const oauth = new GoogleOAuth({
    keys,
    enabled: active,
    openExternal: async (u) => {
      allowLocalPort(Number(new URL(new URL(u).searchParams.get('redirect_uri')!).port));
      return google.openExternal(u);
    },
    isPackaged: true,
    fetch: google.fetch,
  });
  const store = new MemorySyncStore();
  const lib = new MemLibrary();
  lib.add('solar-power', 2);
  const state = new SyncStateStore({ dir: path.join(dir, 'sync'), mintDeviceId: () => DEV });
  const engine = new SyncEngine({
    library: lib,
    state,
    active,
    openStore: (guard) => (active() ? new GuardedStore(store, guard) : null),
    auth: { configured: () => oauth.configured(), signedIn: () => oauth.signedIn() },
    history: () => 'recent',
    pollSeconds: () => 60,
    policy: () => ({ excludeDoc: () => false }),
    outline: () => ['Overview'],
    isBusy: () => false,
    device: { name: 'Example Mac', appVersion: '0.2.0' },
    timers: inertTimers,
  });
  const disable = vi.fn(async () => {
    ctl.enabled = false;
    engine.refresh();
  });
  const service = createSyncService({
    engine,
    oauth,
    state,
    policy: () => ({ allowed: ctl.allowed }),
    active,
    edition: 'public',
    disable,
    canDisable: () => !o.locked,
  });
  const enable = () => {
    ctl.enabled = true;
    engine.refresh();
  };
  return { service, engine, store, keys, ctl, enable, disable, state, dir };
}

/** Nothing secret-shaped in anything the service hands to IPC. */
function assertNoSecrets(v: unknown): void {
  const json = JSON.stringify(v ?? null);
  expect(json).not.toContain(CLIENT_ID);
  expect(json).not.toContain(CLIENT_SECRET);
  expect(json).not.toMatch(/fake-grant|fake-access|GOCSPX|googleusercontent/);
}

/** Waits for the engine's in-flight pass. */
async function settle(engine: SyncEngine): Promise<void> {
  await vi.waitFor(() => expect(engine.status().state).not.toBe('syncing'));
}

describe('sync service (16 §8)', () => {
  it('reports off with no client and no grant, and never creates local sync state while off', async () => {
    const { service, dir } = await harness();
    const s = await service.status();
    expect(s).toMatchObject({ state: 'off', configured: false, signedIn: false, devices: [], pendingUploads: 0 });
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(dir, 'sync'))).toBe(false);
  });

  it('every call fails with NotAvailableInEdition (HOOK-SYNC-01) when the policy does not allow sync', async () => {
    const { service } = await harness({ allowed: false });
    for (const call of [
      () => service.status(),
      () => service.setClient(CLIENT_JSON),
      () => service.clearClient(),
      () => service.signIn(),
      () => service.signOut(),
      () => service.now(),
      () => service.makePrimary(),
      () => service.deleteRemote(),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotAvailableInEdition);
      expect((err as NotAvailableInEdition).hookId).toBe('HOOK-SYNC-01');
    }
  });

  it('stores the client write-only, refuses a malformed one, and removes it', async () => {
    const { service, keys } = await harness();
    await expect(service.setClient('{"web":{}}')).rejects.toMatchObject({ code: 'E_SYNC_NOT_CONFIGURED' });
    await expect(service.setClient('not json')).rejects.toBeInstanceOf(SyncError);
    const saved = await service.setClient(CLIENT_JSON);
    expect(saved).toMatchObject({ configured: true, signedIn: false });
    assertNoSecrets(saved);
    expect(await keys.has('sync.google.client')).toBe(true);
    const cleared = await service.clearClient();
    expect(cleared.configured).toBe(false);
    expect(await keys.has('sync.google.client')).toBe(false);
  });

  it('signs in only with Sync on; then Sync now uploads, and no answer carries a token', async () => {
    const { service, engine, store, enable } = await harness();
    await service.setClient(CLIENT_JSON);
    await expect(service.signIn()).rejects.toMatchObject({ code: 'E_SYNC_DISABLED' });

    enable();
    await settle(engine);
    expect((await service.status()).state).toBe('signed-out');
    const signedIn = await service.signIn();
    expect(signedIn).toMatchObject({ signedIn: true, account: FAKE_ACCOUNT });
    assertNoSecrets(signedIn);
    await settle(engine);

    const seen: SyncStatus[] = [];
    const off = service.onChanged((s) => seen.push(s));
    await service.now();
    await vi.waitFor(() => expect(store.snapshot().some((f) => f.props.k === 'lib')).toBe(true));
    await settle(engine);
    off();
    const kinds = new Set(store.snapshot().map((f) => f.props.k));
    for (const k of ['info', 'claim', 'device', 'lib', 'tree', 'blob']) expect(kinds.has(k as never), k).toBe(true);
    const after = await service.status();
    expect(after).toMatchObject({ state: 'idle', signedIn: true });
    expect(after.lastSyncAt).toBeDefined();
    expect(after.devices).toEqual([expect.objectContaining({ name: 'Example Mac', platform: 'macos' })]);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of [...seen, after]) assertNoSecrets(s);
  });

  it('Delete cloud copy empties the store and turns Sync off; the library is untouched', async () => {
    const { service, engine, store, enable, disable } = await harness();
    await service.setClient(CLIENT_JSON);
    enable();
    await service.signIn();
    await engine.syncNow();
    expect(store.snapshot().length).toBeGreaterThan(0);
    await service.deleteRemote();
    expect(store.snapshot()).toEqual([]);
    expect(disable).toHaveBeenCalledOnce();
    expect((await service.status()).state).toBe('off');
    // Off: no pass runs, so nothing comes back.
    await engine.syncNow();
    expect(store.snapshot()).toEqual([]);
    await expect(service.deleteRemote()).rejects.toMatchObject({ code: 'E_SYNC_DISABLED' });
    await expect(service.now()).rejects.toMatchObject({ code: 'E_SYNC_DISABLED' });
  });

  it('a failed wipe leaves Sync on and running', async () => {
    const { service, engine, store, enable, disable } = await harness();
    await service.setClient(CLIENT_JSON);
    enable();
    await service.signIn();
    await engine.syncNow();
    vi.spyOn(store, 'delete').mockRejectedValueOnce(new SyncError('E_SYNC_HTTP', 'Drive request failed (500)', 500));
    await expect(service.deleteRemote()).rejects.toMatchObject({ code: 'E_SYNC_HTTP' });
    expect(disable).not.toHaveBeenCalled();
    expect((await service.status()).state).not.toBe('off');
  });

  it('refuses Delete cloud copy while sync.enabled is managed, before touching the store', async () => {
    const { service, engine, store, enable, disable } = await harness({ locked: true });
    await service.setClient(CLIENT_JSON);
    enable();
    await service.signIn();
    await engine.syncNow();
    const before = store.snapshot().length;
    expect(before).toBeGreaterThan(0);
    await expect(service.deleteRemote()).rejects.toMatchObject({ code: 'E_SETTINGS_LOCKED' });
    expect(store.snapshot()).toHaveLength(before);
    expect(disable).not.toHaveBeenCalled();
  });

  it('Sync now during Delete cloud copy is a no-op, and a second delete joins the first', async () => {
    const { service, engine, store, enable, disable } = await harness();
    await service.setClient(CLIENT_JSON);
    enable();
    await service.signIn();
    await engine.syncNow();
    const sync = vi.spyOn(engine, 'syncNow');
    const first = service.deleteRemote();
    const second = service.deleteRemote();
    await service.now();
    expect(sync).not.toHaveBeenCalled();
    await Promise.all([first, second]);
    expect(store.snapshot()).toEqual([]);
    expect(disable).toHaveBeenCalledOnce();
  });

  it('sign-out drops the grant and the account label', async () => {
    const { service, keys, enable } = await harness();
    await service.setClient(CLIENT_JSON);
    enable();
    await service.signIn();
    const out = await service.signOut();
    expect(out.signedIn).toBe(false);
    expect(out.account).toBeUndefined();
    expect(await keys.has('sync.google.refreshToken')).toBe(false);
    expect(await keys.has('sync.google.client')).toBe(true);
  });
});

describe('syncErrorMessage (16 §10)', () => {
  it('uses the spec texts and never passes internal detail through', () => {
    expect(syncErrorMessage('E_SYNC_QUOTA', 'x')).toBe('Your Google Drive is full');
    expect(syncErrorMessage('E_SYNC_FORMAT', 'x')).toBe('Update ELI5 Learner to keep syncing');
    expect(syncErrorMessage('E_SYNC_DISABLED', 'Sync is off')).toBe('Turn on Sync first');
    expect(syncErrorMessage('E_SYNC_AUTH', 'Sign-in was cancelled')).toBe('Sign-in was cancelled');
    expect(syncErrorMessage('E_SYNC_HTTP', 'Drive request failed (500)')).toBe(
      'Sync could not finish. Try again in a moment',
    );
    expect(syncErrorMessage('E_SYNC_OWNERSHIP', 'Refused update of a file')).toBe(
      'Sync could not finish. Try again in a moment',
    );
  });
});
