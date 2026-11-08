import { describe, expect, it, vi } from 'vitest';
import type { SyncService } from '../../../../src/main/sync';
import type { SyncStatus } from '../../../../src/preload/contract';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: {}, session: {} }));

const { IPC } = await import('../../../../src/preload/contract');
const { SyncError } = await import('../../../../src/main/sync');
const { NotAvailableInEdition } = await import('../../../../src/main/editions');
const { setup } = await import('./harness');

/** `eli5:sync:*` (16 §8, 01 §5.2): app window only, validated, SyncError mapped at the boundary. */

const forbidden = { ok: false, error: { code: 'E_FORBIDDEN', message: 'Forbidden' } };
const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  state: 'idle',
  configured: true,
  signedIn: true,
  account: 'reader@example.com',
  pendingUploads: 0,
  inboxPending: 0,
  devices: [],
  ...over,
});
// Assembled at runtime (13 §3): never a literal client in the repository.
const CLIENT_JSON = JSON.stringify({
  installed: {
    client_id: ['123456789012', 'abcd'.repeat(8)].join('-') + '.apps.' + 'googleusercontent.com',
    client_secret: ['GOC', 'SPX-', 'z'.repeat(28)].join(''),
  },
});

function fakeSync() {
  const listeners = new Set<(s: SyncStatus) => void>();
  const svc = {
    status: vi.fn(async () => status()),
    setClient: vi.fn(async (_json: string) => status({ state: 'signed-out', signedIn: false })),
    clearClient: vi.fn(async () => status({ configured: false, signedIn: false, state: 'not-configured' })),
    signIn: vi.fn(async () => status()),
    signOut: vi.fn(async () => status({ signedIn: false, state: 'signed-out' })),
    now: vi.fn(async () => {}),
    makePrimary: vi.fn(async () => status()),
    deleteRemote: vi.fn(async () => {}),
    onChanged: (cb: (s: SyncStatus) => void) => (listeners.add(cb), () => listeners.delete(cb)),
  } satisfies SyncService;
  return { svc, emit: (s: SyncStatus) => listeners.forEach((cb) => cb(s)) };
}

const NO_PAYLOAD = [
  IPC.sync.status,
  IPC.sync.clearClient,
  IPC.sync.signIn,
  IPC.sync.signOut,
  IPC.sync.now,
  IPC.sync.makePrimary,
  IPC.sync.deleteRemote,
] as const;

describe('eli5:sync:* (16 §8)', () => {
  it('delegates every invoke and answers with the status or nothing', async () => {
    const { svc } = fakeSync();
    const h = await setup({ services: { sync: svc } });
    expect(await h.call(IPC.sync.status)).toEqual({ ok: true, value: status() });
    expect(await h.call(IPC.sync.setClient, { json: CLIENT_JSON })).toMatchObject({
      ok: true,
      value: { configured: true, signedIn: false },
    });
    expect(svc.setClient).toHaveBeenCalledWith(CLIENT_JSON);
    expect(await h.call(IPC.sync.clearClient)).toMatchObject({ ok: true, value: { configured: false } });
    expect(await h.call(IPC.sync.signIn)).toMatchObject({ ok: true, value: { signedIn: true } });
    expect(await h.call(IPC.sync.signOut)).toMatchObject({ ok: true, value: { signedIn: false } });
    expect(await h.call(IPC.sync.now)).toEqual({ ok: true, value: undefined });
    expect(await h.call(IPC.sync.makePrimary)).toMatchObject({ ok: true });
    expect(await h.call(IPC.sync.deleteRemote)).toEqual({ ok: true, value: undefined });
    for (const fn of Object.values(svc)) if (vi.isMockFunction(fn)) expect(fn).toHaveBeenCalledOnce();
  });

  it('the viewer gets E_FORBIDDEN on every sync channel and nothing runs', async () => {
    const { svc } = fakeSync();
    const h = await setup({ services: { sync: svc } });
    for (const ch of NO_PAYLOAD) expect(await h.call(ch, undefined, 'viewer'), ch).toEqual(forbidden);
    expect(await h.call(IPC.sync.setClient, { json: CLIENT_JSON }, 'viewer')).toEqual(forbidden);
    for (const fn of Object.values(svc)) if (vi.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled();
  });

  it('rejects malformed payloads with E_BAD_REQUEST', async () => {
    const { svc } = fakeSync();
    const h = await setup({ services: { sync: svc } });
    for (const bad of [
      undefined,
      {},
      { json: 42 },
      { json: '' },
      { json: 'x'.repeat(16 * 1024 + 1) },
      { json: '{}', x: 1 },
    ]) {
      expect(await h.call(IPC.sync.setClient, bad)).toMatchObject({ ok: false, error: { code: 'E_BAD_REQUEST' } });
    }
    expect(await h.call(IPC.sync.now, { force: true })).toMatchObject({ ok: false, error: { code: 'E_BAD_REQUEST' } });
    expect(svc.setClient).not.toHaveBeenCalled();
    expect(svc.now).not.toHaveBeenCalled();
  });

  it('maps SyncError to E_SYNC_FAILED with the code in detailCode and only user text', async () => {
    const { svc } = fakeSync();
    svc.setClient.mockRejectedValueOnce(
      new SyncError('E_SYNC_NOT_CONFIGURED', 'Use an OAuth client of type "Desktop app", not "Web application"'),
    );
    svc.signIn.mockRejectedValueOnce(new SyncError('E_SYNC_DISABLED', 'Sync is off'));
    svc.makePrimary.mockRejectedValueOnce(new SyncError('E_SYNC_HTTP', 'Drive request failed (503)', 503));
    svc.deleteRemote.mockRejectedValueOnce(new SyncError('E_SYNC_QUOTA', undefined, 403));
    const h = await setup({ services: { sync: svc } });
    expect(await h.call(IPC.sync.setClient, { json: '{"web":{}}' })).toEqual({
      ok: false,
      error: {
        code: 'E_SYNC_FAILED',
        message: 'Use an OAuth client of type "Desktop app", not "Web application"',
        detailCode: 'E_SYNC_NOT_CONFIGURED',
      },
    });
    expect(await h.call(IPC.sync.signIn)).toEqual({
      ok: false,
      error: { code: 'E_SYNC_FAILED', message: 'Turn on Sync first', detailCode: 'E_SYNC_DISABLED' },
    });
    expect(await h.call(IPC.sync.makePrimary)).toEqual({
      ok: false,
      error: {
        code: 'E_SYNC_FAILED',
        message: 'Sync could not finish. Try again in a moment',
        detailCode: 'E_SYNC_HTTP',
      },
    });
    expect(await h.call(IPC.sync.deleteRemote)).toEqual({
      ok: false,
      error: { code: 'E_SYNC_FAILED', message: 'Your Google Drive is full', detailCode: 'E_SYNC_QUOTA' },
    });
  });

  it('a policy that does not allow sync answers E_NOT_AVAILABLE_IN_EDITION with HOOK-SYNC-01', async () => {
    const { svc } = fakeSync();
    svc.status.mockRejectedValueOnce(new NotAvailableInEdition('sync', 'HOOK-SYNC-01', 'enterprise'));
    const h = await setup({ services: { sync: svc } });
    expect(await h.call(IPC.sync.status)).toEqual({
      ok: false,
      error: {
        code: 'E_NOT_AVAILABLE_IN_EDITION',
        message: 'Not available in this edition',
        capability: 'sync',
        hookId: 'HOOK-SYNC-01',
      },
    });
  });

  it('pushes status changes to the app only, and stops after dispose', async () => {
    const { svc, emit } = fakeSync();
    const h = await setup({ services: { sync: svc } });
    emit(status({ state: 'syncing' }));
    expect(h.sent).toContainEqual({ channel: IPC.sync.changed, payload: status({ state: 'syncing' }) });
    expect(h.viewerSent.some((m) => m.channel === IPC.sync.changed)).toBe(false);
    h.dispose();
    const before = h.sent.length;
    emit(status());
    expect(h.sent.length).toBe(before);
  });

  it('without a sync service every channel answers "Not implemented yet"', async () => {
    const h = await setup();
    for (const ch of NO_PAYLOAD) {
      expect(await h.call(ch), ch).toEqual({
        ok: false,
        error: { code: 'E_INTERNAL', message: 'Not implemented yet' },
      });
    }
  });
});
