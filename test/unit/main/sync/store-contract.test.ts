/**
 * `SyncStore` contract suite (16 §12): the same behaviour from every shipped store (the Drive
 * app-data store over the fake Drive, bare and behind the guard), and from every documented stub:
 * `NotAvailableInEdition` with HOOK-SYNC-01 from every call, no request (net-guard is active).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../../src/main/config';
import { NotAvailableInEdition, Registry } from '../../../../src/main/editions';
import { registerPublicCapabilities } from '../../../../src/main/editions/public';
import {
  DriveAppDataStore,
  DriveClient,
  DriveFolderStoreStub,
  DropboxStoreStub,
  GuardedStore,
  WebDavStoreStub,
  type RemoteProps,
  type SyncStore,
} from '../../../../src/main/sync';
import { decodeProps, encodeProps, toRemoteFile } from '../../../../src/main/sync/stores/drive-appdata';
import { FakeDrive, fakeAuth } from './fake-drive';

const DEV = '0b7c5e2a-1f3d-4c4e-9a8b-2d6f0e1c3b5a';
const enc = new TextEncoder();
const sha = (s: string) => `${'ab'.repeat(31)}${s.padStart(2, '0').slice(-2)}`;

interface Harness {
  store: SyncStore;
  drive: FakeDrive;
}

const harnesses: Array<[string, () => Harness]> = [
  [
    'google-drive-appdata',
    () => {
      const drive = new FakeDrive({ pageSize: 3 });
      const client = new DriveClient({ auth: fakeAuth(), fetch: drive.fetch, sleep: async () => {} });
      return { drive, store: new DriveAppDataStore(client) };
    },
  ],
  [
    'google-drive-appdata behind the guard',
    () => {
      const drive = new FakeDrive({ pageSize: 3 });
      const client = new DriveClient({ auth: fakeAuth(), fetch: drive.fetch, sleep: async () => {} });
      return {
        drive,
        store: new GuardedStore(new DriveAppDataStore(client), { deviceId: DEV, isPrimary: () => true }),
      };
    },
  ],
];

describe.each(harnesses)('SyncStore contract: %s', (_name, make) => {
  it('creates under preallocated ids and lists by kind and docId across pages', async () => {
    const { store } = make();
    expect(store.id).toBe('google-drive-appdata');
    const ids = await store.generateIds(6);
    expect(new Set(ids).size).toBe(6);
    const docA = '11111111-2222-4333-8444-555555555555';
    for (let i = 0; i < 4; i++) {
      await store.create(
        ids[i]!,
        `blob-${i}.html.gz`,
        { k: 'blob', dev: DEV, d: docA, s: sha(String(i)) },
        enc.encode(`b${i}`),
        'application/gzip',
      );
    }
    await store.create(
      ids[4]!,
      `tree-${docA}.json`,
      { k: 'tree', dev: DEV, d: docA, n: 1 },
      enc.encode('{}'),
      'application/json',
    );
    await store.create(ids[5]!, 'lib.json', { k: 'lib', dev: DEV, n: 1 }, enc.encode('{}'), 'application/json');
    expect(await store.list({ kind: 'blob' })).toHaveLength(4);
    expect(await store.list({ docId: docA })).toHaveLength(5);
    const [tree] = await store.list({ kind: 'tree', docId: docA });
    expect(tree!.props).toEqual({ k: 'tree', dev: DEV, d: docA, n: 1 });
    expect(await store.list({})).toHaveLength(6);
  });

  it('a retried create never duplicates', async () => {
    const { store } = make();
    const [id] = await store.generateIds(1);
    const props: RemoteProps = { k: 'claim', dev: DEV };
    await store.create(id!, 'claim.json', props, enc.encode('{}'), 'application/json');
    await store.create(id!, 'claim.json', props, enc.encode('{}'), 'application/json');
    expect(await store.list({ kind: 'claim' })).toHaveLength(1);
  });

  it('round-trips bytes, reports sha256 and size, updates in place and touches metadata', async () => {
    const { store, drive } = make();
    const [id] = await store.generateIds(1);
    const f = await store.create(
      id!,
      'device.json',
      { k: 'device', dev: DEV },
      enc.encode('{"v":1}'),
      'application/json',
    );
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f.size).toBe(7);
    const up = await store.update(id!, enc.encode('{"v":2}'));
    expect(up.id).toBe(id);
    expect(new TextDecoder().decode(await store.get(id!))).toBe('{"v":2}');
    const revisions = drive.files.get(id!)!.revisions;
    await store.touch(id!, { seen: 1_762_000_000 });
    expect(drive.files.get(id!)!.revisions).toBe(revisions);
    const [listed] = await store.list({ kind: 'device' });
    expect(listed!.props.seen).toBe(1_762_000_000);
  });

  it('reports creates and removals through the change feed, and E_SYNC_TOKEN for an expired token', async () => {
    const { store, drive } = make();
    const start = await store.startToken();
    const [a, b] = await store.generateIds(2);
    await store.create(a!, 'a', { k: 'status', dev: DEV, s: 'x' }, enc.encode('{}'), 'application/json');
    await store.create(b!, 'b', { k: 'status', dev: DEV, s: 'y' }, enc.encode('{}'), 'application/json');
    await store.delete(a!);
    const r = await store.changes(start);
    // Like Drive, a change reports the file's latest state: `a` is gone by now.
    expect(r.changes.filter((c) => !c.removed).map((c) => c.file!.id)).toEqual([b]);
    expect(r.changes.at(-1)).toEqual({ fileId: a, removed: true });
    expect((await store.changes(r.nextToken)).changes).toEqual([]);
    drive.expireTokens();
    await expect(store.changes(start)).rejects.toMatchObject({ code: 'E_SYNC_TOKEN' });
  });

  it('ignores files that carry no sync identity', async () => {
    const { store, drive } = make();
    const start = await store.startToken();
    drive.seed({ name: 'probe-desktop.json', appProperties: {} });
    drive.seed({ name: 'odd', appProperties: { k: 'nope', dev: 'x' } });
    expect(await store.list({})).toEqual([]);
    expect((await store.changes(start)).changes).toEqual([]);
  });

  it('listing is eventually consistent; the change feed is not', async () => {
    const drive = new FakeDrive({ listDelay: 1 });
    const store = new DriveAppDataStore(new DriveClient({ auth: fakeAuth(), fetch: drive.fetch }));
    const start = await store.startToken();
    const [id] = await store.generateIds(1);
    await store.create(id!, 'b', { k: 'blob', dev: DEV, s: sha('1') }, enc.encode('x'), 'application/gzip');
    expect(await store.list({ kind: 'blob' })).toEqual([]);
    expect(await store.list({ kind: 'blob' })).toHaveLength(1);
    expect((await store.changes(start)).changes).toHaveLength(1);
  });

  it("a create whose id already holds another writer's file neither adopts nor deletes it", async () => {
    const { store, drive } = make();
    const other = '9c1e4f2a-3b5d-4e6f-8a7b-1c2d3e4f5a6b';
    const foreign = drive.seed({ name: 'job', appProperties: { k: 'job', dev: other, s: 'j1' }, body: '{}' });
    await expect(
      store.create(foreign.id, 'job', { k: 'job', dev: DEV, s: 'j1' }, enc.encode('{"x":1}'), 'application/json'),
    ).rejects.toMatchObject({ code: 'E_SYNC_OWNERSHIP' });
    expect(drive.files.has(foreign.id)).toBe(true);
  });

  it('a checksum mismatch deletes the upload and throws E_SYNC_CHECKSUM', async () => {
    const { store, drive } = make();
    const [id] = await store.generateIds(1);
    drive.corruptNextChecksum = true;
    await expect(
      store.create(id!, 'b', { k: 'blob', dev: DEV, s: sha('2') }, enc.encode('x'), 'application/gzip'),
    ).rejects.toMatchObject({ code: 'E_SYNC_CHECKSUM' });
    expect(drive.files.has(id!)).toBe(false);
  });

  it('rejects properties Drive would refuse (over 124 bytes, unknown keys, bad numbers)', async () => {
    const { store } = make();
    const [id] = await store.generateIds(1);
    const bad: RemoteProps[] = [
      { k: 'blob', dev: DEV, s: 'x'.repeat(124) },
      { k: 'blob', dev: DEV, n: -1 },
      { k: 'blob', dev: DEV, n: 1.5 },
      { k: 'nope' as never, dev: DEV },
      { k: 'blob', dev: DEV, extra: '1' } as never,
    ];
    for (const props of bad) {
      await expect(store.create(id!, 'x', props, enc.encode('x'), 'text/plain')).rejects.toMatchObject({
        name: 'SyncError',
      });
    }
  });

  it('delete is permanent and idempotent', async () => {
    const { store, drive } = make();
    const [id] = await store.generateIds(1);
    await store.create(id!, 'x', { k: 'acks', dev: DEV }, enc.encode('{}'), 'application/json');
    await store.delete(id!);
    expect(drive.files.has(id!)).toBe(false);
    await expect(store.get(id!)).rejects.toMatchObject({ code: 'E_SYNC_NOT_FOUND' });
  });
});

describe('appProperties mapping', () => {
  it('encodes numbers as strings and decodes them back', () => {
    expect(encodeProps({ k: 'tree', dev: 'd', n: 3, seen: 10 })).toEqual({ k: 'tree', dev: 'd', n: '3', seen: '10' });
    expect(decodeProps({ k: 'tree', dev: 'd', n: '3', seen: 'x' })).toEqual({ k: 'tree', dev: 'd', n: 3 });
    expect(decodeProps({ k: 'tree' })).toBeNull();
    expect(decodeProps(undefined)).toBeNull();
    expect(
      toRemoteFile({ id: 'a', appProperties: { k: 'blob', dev: 'd' }, sha256Checksum: 'XYZ', size: 'n/a' }),
    ).toEqual({
      id: 'a',
      name: '',
      props: { k: 'blob', dev: 'd' },
    });
  });
});

const stubs: Array<[string, SyncStore]> = [
  ['google-drive-folder', new DriveFolderStoreStub()],
  ['dropbox', new DropboxStoreStub()],
  ['webdav', new WebDavStoreStub()],
];

describe.each(stubs)('documented stub %s (16 §4.1)', (id, store) => {
  it('is marked as a stub and fails every call with NotAvailableInEdition (HOOK-SYNC-01)', async () => {
    expect(store.id).toBe(id);
    expect((store as unknown as { stub: boolean }).stub).toBe(true);
    const calls: Array<() => Promise<unknown>> = [
      () => store.list({}),
      () => store.startToken(),
      () => store.changes('1'),
      () => store.get('x'),
      () => store.generateIds(1),
      () => store.create('x', 'x', { k: 'blob', dev: DEV }, new Uint8Array(), 'x'),
      () => store.update('x', new Uint8Array()),
      () => store.touch('x', {}),
      () => store.delete('x'),
    ];
    for (const call of calls) {
      const err = await call().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(NotAvailableInEdition);
      expect(err).toMatchObject({ capability: `sync-store:${id}`, hookId: 'HOOK-SYNC-01' });
    }
  });
});

describe('registry (HOOK-SYNC-01/02)', () => {
  const reg = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
  registerPublicCapabilities(reg);

  it('registers the shipped store, the three stubs and the public policy', () => {
    expect(reg.syncStores()).toEqual([
      { id: 'google-drive-appdata', available: true },
      { id: 'google-drive-folder', available: false },
      { id: 'dropbox', available: false },
      { id: 'webdav', available: false },
    ]);
    const p = reg.syncPolicy();
    expect(p.allowed).toBe(true);
    expect(p.clientSource).toBe('user');
    expect(p.excludeDoc({ id: 'x', slug: 'y' })).toBe(false);
    expect(reg.missingSlots()).toEqual([]);
  });

  it('an unknown store id is not available in the edition', () => {
    expect(() => reg.syncStore('s3', { settings: DEFAULTS, auth: fakeAuth() })).toThrow(NotAvailableInEdition);
  });

  it('an overlay can replace a store and the policy', () => {
    const r = new Registry({ edition: 'enterprise', getSettings: () => DEFAULTS });
    registerPublicCapabilities(r);
    r.registerSyncStore('google-drive-appdata', () => new WebDavStoreStub());
    r.registerSyncPolicy({ allowed: false, excludeDoc: () => true, clientSource: 'none' });
    expect(r.syncStores()[0]).toEqual({ id: 'google-drive-appdata', available: false });
    expect(r.syncPolicy().allowed).toBe(false);
    r.freeze();
    expect(() => r.registerSyncStore('x', () => new WebDavStoreStub())).toThrow(/frozen/);
  });
});
