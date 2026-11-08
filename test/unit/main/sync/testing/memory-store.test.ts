/**
 * The e2e in-memory store (src/main/sync/testing, 13 §6.1) keeps the `SyncStore` contract (16 §4.1)
 * the engine relies on: preallocated ids, idempotent creates, a change feed, permanent deletes.
 */
import { describe, expect, it } from 'vitest';
import { GuardedStore, SyncError, sha256Hex } from '../../../../../src/main/sync';
import { MemorySyncStore } from '../../../../../src/main/sync/testing';

const DEV = '0b7c5e2a-1f3d-4c4e-9a8b-2d6f0e1c3b5a';
const OTHER = '1c8d6f3b-2a4e-4d5f-8b9c-3e7a1f2d4c6b';
const enc = new TextEncoder();

describe('MemorySyncStore', () => {
  it('creates under generated ids only, and a retried create returns the same file', async () => {
    const store = new MemorySyncStore();
    expect(store.id).toBe('google-drive-appdata');
    const [a, b] = await store.generateIds(2);
    expect(a).not.toBe(b);
    const f = await store.create(
      a!,
      'device.json',
      { k: 'device', dev: DEV },
      enc.encode('{"x":1}'),
      'application/json',
    );
    expect(f).toMatchObject({ id: a, sha256: sha256Hex(enc.encode('{"x":1}')), size: 7 });
    expect(await store.create(a!, 'device.json', { k: 'device', dev: DEV }, enc.encode('{}'), 'x')).toMatchObject({
      sha256: f.sha256,
    });
    await expect(store.create(a!, 'x', { k: 'claim', dev: OTHER }, enc.encode('{}'), 'x')).rejects.toBeInstanceOf(
      SyncError,
    );
    await expect(store.create('never-issued', 'x', { k: 'info', dev: DEV }, enc.encode('{}'), 'x')).rejects.toThrow();
    expect(await store.list({ kind: 'device' })).toHaveLength(1);
    expect(await store.list({ kind: 'lib' })).toHaveLength(0);
  });

  it('reports updates, touches and deletes through the change feed; old tokens stay valid', async () => {
    const store = new MemorySyncStore();
    const t0 = await store.startToken();
    const [id] = await store.generateIds(1);
    await store.create(id!, 'lib.json', { k: 'lib', dev: DEV, n: 1 }, enc.encode('a'), 'application/json');
    await store.update(id!, enc.encode('bb'));
    await store.touch(id!, { n: 2 });
    const r1 = await store.changes(t0);
    expect(r1.changes).toEqual([{ fileId: id, removed: false, file: expect.objectContaining({ size: 2 }) }]);
    expect(r1.changes[0]?.file?.props.n).toBe(2);
    expect(new TextDecoder().decode(await store.get(id!))).toBe('bb');
    await store.delete(id!);
    await store.delete(id!); // idempotent
    const r2 = await store.changes(r1.nextToken);
    expect(r2.changes).toEqual([{ fileId: id, removed: true }]);
    await expect(store.get(id!)).rejects.toMatchObject({ code: 'E_SYNC_NOT_FOUND' });
    await expect(store.changes('0')).rejects.toMatchObject({ code: 'E_SYNC_TOKEN' });
  });

  it('works behind the guard, which can wipe it', async () => {
    const store = new MemorySyncStore();
    const guarded = new GuardedStore(store, { deviceId: DEV, isPrimary: () => true });
    const [id] = await guarded.generateIds(1);
    await guarded.create(id!, 'claim.json', { k: 'claim', dev: DEV }, enc.encode('{}'), 'application/json');
    expect(await guarded.wipe()).toBe(1);
    expect(store.snapshot()).toEqual([]);
  });
});
