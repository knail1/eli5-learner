import { mkdtemp, readFile, rm, stat, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyncStateStore, freshState } from '../../../../src/main/sync';
import { DEVICE_ID_RE } from '../../../../src/main/sync/protocol';

let dir: string;
beforeEach(async () => {
  dir = path.join(await mkdtemp(path.join(tmpdir(), 'eli5-sync-')), 'sync');
});
afterEach(async () => {
  await rm(path.dirname(dir), { recursive: true, force: true });
});

describe('sync state (16 §4.5 step 1)', () => {
  it('mints a UUIDv4 device id on first use and persists it with mode 0600 in a 0700 folder', async () => {
    const s = new SyncStateStore({ dir });
    const st = await s.load();
    expect(st.deviceId).toMatch(DEVICE_ID_RE);
    expect(st).toMatchObject({ v: 1, primary: false, manifestSeq: 0, docs: {}, pendingCreates: {}, resumable: {} });
    expect((await stat(s.file)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const again = await new SyncStateStore({ dir }).load();
    expect(again.deviceId).toBe(st.deviceId);
  });

  it('concurrent first loads mint one id', async () => {
    let minted = 0;
    const s = new SyncStateStore({
      dir,
      mintDeviceId: () => {
        minted++;
        return '0b7c5e2a-1f3d-4c4e-9a8b-2d6f0e1c3b5a';
      },
    });
    await Promise.all([s.load(), s.load(), s.load()]);
    expect(minted).toBe(1);
  });

  it('serializes updates and only caches what was written', async () => {
    const s = new SyncStateStore({ dir });
    await s.load();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        s.update((st) => {
          st.manifestSeq += 1;
        }),
      ),
    );
    expect(s.current().manifestSeq).toBe(5);
    await expect(
      s.update((st) => {
        (st as { manifestSeq: number }).manifestSeq = -1;
      }),
    ).rejects.toBeTruthy();
    expect(s.current().manifestSeq).toBe(5);
    const onDisk = JSON.parse(await readFile(s.file, 'utf8')) as { manifestSeq: number };
    expect(onDisk.manifestSeq).toBe(5);
  });

  it('keeps resumable sessions by file id', async () => {
    const s = new SyncStateStore({ dir });
    await s.load();
    await s.set('fid1', {
      uri: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=x',
      startedAt: 5,
      size: 10,
      sha256: 'ab'.repeat(32),
    });
    expect(new SyncStateStore({ dir }).get('fid1')).toBeUndefined(); // not loaded yet
    const other = new SyncStateStore({ dir });
    await other.load();
    expect(other.get('fid1')?.startedAt).toBe(5);
    await other.delete('fid1');
    await other.delete('fid1');
    expect(other.get('fid1')).toBeUndefined();
  });

  it('sets a corrupt file aside and keeps the device id when it can', async () => {
    await mkdir(dir, { recursive: true });
    const id = '9e1d2c3b-4a5f-4e6d-8c7b-0a1b2c3d4e5f';
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ deviceId: id, manifestSeq: 'x' }));
    const st = await new SyncStateStore({ dir }).load();
    expect(st.deviceId).toBe(id);
    expect(st.manifestSeq).toBe(0);
    expect((await readdir(dir)).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);

    await writeFile(path.join(dir, 'state.json'), '{not json');
    const fresh = await new SyncStateStore({ dir }).load();
    expect(fresh.deviceId).toMatch(DEVICE_ID_RE);
    expect(fresh.deviceId).not.toBe(id);
  });

  it('never holds tokens or client values', async () => {
    expect(Object.keys(freshState()).sort()).toEqual(
      ['deviceId', 'docs', 'inbox', 'manifestSeq', 'pendingCreates', 'primary', 'resumable', 'v'].sort(),
    );
    await expect(new SyncStateStore({ dir, mintDeviceId: () => 'NOT-A-UUID' }).load()).rejects.toThrow();
  });
});
