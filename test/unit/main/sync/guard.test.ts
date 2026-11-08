/** Single-writer guard (16 §4.1, §4.2, §4.7): every refused write throws E_SYNC_OWNERSHIP. */
import { describe, expect, it } from 'vitest';
import { DriveAppDataStore, DriveClient, GuardedStore, type RemoteProps } from '../../../../src/main/sync';
import { FakeDrive, fakeAuth } from './fake-drive';

const ME = '0b7c5e2a-1f3d-4c4e-9a8b-2d6f0e1c3b5a';
const OTHER_MAC = '9e1d2c3b-4a5f-4e6d-8c7b-0a1b2c3d4e5f';
const PHONE = '5f4e3d2c-1b0a-4f9e-8d7c-6b5a4f3e2d1c';
const enc = new TextEncoder();

function setup(primary = true) {
  const drive = new FakeDrive();
  const inner = new DriveAppDataStore(new DriveClient({ auth: fakeAuth(), fetch: drive.fetch }));
  let isPrimary = primary;
  const store = new GuardedStore(inner, { deviceId: ME, isPrimary: () => isPrimary });
  const seed = (k: RemoteProps['k'], dev: string) => drive.seed({ name: `${k}.json`, appProperties: { k, dev } });
  return { drive, store, seed, setPrimary: (v: boolean) => (isPrimary = v) };
}

const refused = { code: 'E_SYNC_OWNERSHIP' };

describe('GuardedStore', () => {
  it('lets this device write, rewrite, touch and delete its own files', async () => {
    const { store, drive } = setup();
    const [id] = await store.generateIds(1);
    await store.create(id!, 'tree.json', { k: 'tree', dev: ME, n: 1 }, enc.encode('{}'), 'application/json');
    await store.update(id!, enc.encode('{"n":2}'));
    await store.touch(id!, { n: 2 });
    await store.delete(id!);
    expect(drive.files.size).toBe(0);
  });

  it('refuses to create a file stamped with another device', async () => {
    const { store, drive } = setup();
    const [id] = await store.generateIds(1);
    await expect(
      store.create(id!, 'x', { k: 'job', dev: PHONE }, enc.encode('{}'), 'application/json'),
    ).rejects.toMatchObject(refused);
    expect(drive.files.size).toBe(0);
  });

  it('refuses update, touch and delete of files other devices wrote', async () => {
    const { store, seed, drive } = setup();
    const job = seed('job', PHONE);
    const claim = seed('claim', OTHER_MAC);
    await store.list({});
    await expect(store.update(job.id, enc.encode('{}'))).rejects.toMatchObject(refused);
    await expect(store.touch(claim.id, { seen: 1 })).rejects.toMatchObject(refused);
    await expect(store.delete(job.id)).rejects.toMatchObject(refused);
    expect(drive.files.size).toBe(2);
    expect(store.ownerOf(job.id)).toBe(PHONE);
  });

  it('treats a file it has never seen as foreign', async () => {
    const { store, seed } = setup();
    const mine = seed('device', ME); // exists remotely, but not yet listed through the guard
    await expect(store.touch(mine.id, { seen: 1 })).rejects.toMatchObject(refused);
    const start = '1';
    await store.changes(start);
    await expect(store.touch(mine.id, { seen: 1 })).resolves.toBeUndefined();
  });

  it('never lets touch change identity keys', async () => {
    const { store } = setup();
    const [id] = await store.generateIds(1);
    await store.create(id!, 'device.json', { k: 'device', dev: ME }, enc.encode('{}'), 'application/json');
    await expect(store.touch(id!, { dev: OTHER_MAC })).rejects.toMatchObject(refused);
    await expect(store.touch(id!, { k: 'job' })).rejects.toMatchObject(refused);
  });

  it('refuses to reuse a file id that belongs to someone else', async () => {
    const { store, seed } = setup();
    const job = seed('job', PHONE);
    await store.list({});
    await expect(
      store.create(job.id, 'x', { k: 'status', dev: ME }, enc.encode('{}'), 'application/json'),
    ).rejects.toMatchObject(refused);
  });

  it('garbage collection: the primary may delete foreign jobs, attachments, cancels, devices, acks and claims', async () => {
    const { store, seed, drive } = setup(true);
    const foreign = (['job', 'att', 'cancel', 'device', 'acks', 'claim'] as const).map((k) => seed(k, PHONE));
    const tree = seed('tree', OTHER_MAC);
    await store.list({});
    for (const f of foreign) await store.gcDelete(f.id);
    expect(drive.files.has(tree.id)).toBe(true);
    await expect(store.gcDelete(tree.id)).rejects.toMatchObject(refused); // another desktop's tree
    const [own] = await store.generateIds(1);
    await store.create(own!, 'blob', { k: 'blob', dev: ME, s: 'a'.repeat(64) }, enc.encode('x'), 'application/gzip');
    await store.gcDelete(own!);
    expect([...drive.files.keys()]).toEqual([tree.id]);
  });

  it('garbage collection is refused while this device is not the primary, and for unknown files', async () => {
    const { store, seed, setPrimary } = setup(false);
    const job = seed('job', PHONE);
    await store.list({});
    await expect(store.gcDelete(job.id)).rejects.toMatchObject(refused);
    setPrimary(true);
    await expect(store.gcDelete('never-seen')).rejects.toMatchObject(refused);
    await expect(store.gcDelete(job.id)).resolves.toBeUndefined();
  });

  it('wipe ("Delete cloud copy") deletes every file, whoever wrote it', async () => {
    const { store, seed, drive } = setup(false);
    seed('job', PHONE);
    seed('claim', OTHER_MAC);
    seed('device', ME);
    expect(await store.wipe()).toBe(3);
    expect(drive.files.size).toBe(0);
  });
});
