/**
 * The desktop sync engine (16 §4.5–§4.7, §12 "engine tests") over the in-memory fake Drive and the
 * real store and guard: upload order, seq, history selection, re-minted ids, Trash, purge and GC
 * ages, GC off when read-only, on an unknown format or as a mirror, claims and takeover, a crash
 * between steps, a resumed resumable upload and a checksum mismatch.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DriveAppDataStore,
  DriveClient,
  GuardedStore,
  SyncEngine,
  SyncStateStore,
  TAKEOVER_SILENCE_MS,
  type EngineTimers,
  type HistoryMode,
  type SyncLibrary,
} from '../../../../src/main/sync';
import {
  DeviceRecordSchema,
  LibraryManifestSchema,
  VersionTreeSchema,
  type LibraryManifest,
  type VersionTree,
} from '../../../../src/main/sync/protocol';
import { HTML, createDoc, testLibrary } from '../library/fixtures';
import { FakeDrive, fakeAuth, type FakeFile } from './fake-drive';
import { MemLibrary, sha256 } from './mem-library';

const DEV_A = '0b7c5e2a-1f3d-4c4e-9a8b-2d6f0e1c3b5a';
const DEV_B = '1c8d6f3b-2a4e-4d5f-8b9c-3e7a1f2d4c6b';
const DAY = 86_400_000;
const dec = new TextDecoder();

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Timers that never fire on their own; tests run passes with `syncNow()` / `cycle()`. */
function inertTimers(): EngineTimers & { intervals: Array<() => void> } {
  const intervals: Array<() => void> = [];
  return {
    intervals,
    setTimeout: () => ({}),
    clearTimeout: () => {},
    setInterval: (fn) => {
      intervals.push(fn);
      return intervals.length;
    },
    clearInterval: () => {},
  };
}

interface Opts {
  drive?: FakeDrive;
  lib?: SyncLibrary;
  deviceId?: string;
  clock?: { t: number };
  fetch?: typeof fetch;
  dir?: string;
  maxAttempts?: number;
}

async function harness(o: Opts = {}) {
  const drive = o.drive ?? new FakeDrive();
  const lib = o.lib ?? new MemLibrary();
  const clock = o.clock ?? { t: Date.parse('2026-11-01T12:00:00Z') };
  const dir = o.dir ?? (await mkdtemp(path.join(tmpdir(), 'eli5-sync-engine-')));
  if (!o.dir) dirs.push(dir);
  const state = new SyncStateStore({ dir: path.join(dir, 'sync'), mintDeviceId: () => o.deviceId ?? DEV_A });
  const ctl = { active: true, history: 'recent' as HistoryMode, busy: new Set<string>(), excluded: new Set<string>() };
  const timers = inertTimers();
  const engine = new SyncEngine({
    library: lib,
    state,
    active: () => ctl.active,
    openStore: (guard) =>
      new GuardedStore(
        new DriveAppDataStore(
          new DriveClient({
            auth: fakeAuth(),
            fetch: o.fetch ?? drive.fetch,
            sessions: state,
            sleep: async () => {},
            ...(o.maxAttempts ? { maxAttempts: o.maxAttempts } : {}),
          }),
        ),
        guard,
      ),
    auth: { configured: async () => true, signedIn: async () => true },
    history: () => ctl.history,
    pollSeconds: () => 60,
    policy: () => ({ excludeDoc: (d) => ctl.excluded.has(d.id) }),
    outline: () => ['Overview', 'How pricing works'],
    isBusy: (slug) => ctl.busy.has(slug),
    device: { name: 'Example Mac', appVersion: '0.2.0' },
    now: () => clock.t,
    timers,
  });
  return { engine, drive, lib, state, clock, ctl, dir, timers };
}

const kind = (drive: FakeDrive, k: string, dev?: string): FakeFile[] =>
  [...drive.files.values()].filter((f) => f.appProperties.k === k && (!dev || f.appProperties.dev === dev));
const json = <T>(f: FakeFile): T => JSON.parse(dec.decode(f.body)) as T;
const manifestOf = (drive: FakeDrive, dev = DEV_A): LibraryManifest =>
  LibraryManifestSchema.parse(json(kind(drive, 'lib', dev)[0]!));
const writes = (drive: FakeDrive, from = 0) => drive.requests.slice(from).filter((r) => r.method !== 'GET');

describe('push (16 §4.5)', () => {
  it('uploads blobs, then the tree, then the manifest, with sanitized content', async () => {
    const { engine, drive, lib } = await harness();
    const mem = lib as MemLibrary;
    const doc = mem.add('Widget pricing', 3);
    await engine.syncNow();

    const names = [...drive.files.values()].map((f) => f.name);
    expect(names.slice(0, 3)).toEqual(['sync-info.json', expect.stringMatching(/^claim-\d+-/), `device-${DEV_A}.json`]);
    const blobAt = names.flatMap((n, i) => (n.startsWith('blob-') ? [i] : []));
    const treeAt = names.indexOf(`tree-${doc.entry.id}.json`);
    const libAt = names.indexOf(`lib-${DEV_A}.json`);
    expect(blobAt).toHaveLength(3);
    expect(Math.max(...blobAt)).toBeLessThan(treeAt);
    expect(treeAt).toBeLessThan(libAt);

    for (const b of kind(drive, 'blob')) {
      const html = gunzipSync(b.body);
      expect(sha256(html)).toBe(b.appProperties.s);
      expect(b.appProperties).toMatchObject({ dev: DEV_A, d: doc.entry.id });
      expect(b.name).toBe(`blob-${b.appProperties.s}.html.gz`);
    }
    const tree = VersionTreeSchema.parse(json(kind(drive, 'tree')[0]!));
    expect(tree).toMatchObject({ docId: doc.entry.id, seq: 1, currentId: doc.tree.currentId });
    expect(tree.nodes.every((n) => n.uploaded)).toBe(true);
    const m = manifestOf(drive);
    expect(m.seq).toBe(1);
    expect(m.docs).toEqual([
      expect.objectContaining({
        docId: doc.entry.id,
        title: 'Widget pricing',
        headings: ['Overview', 'How pricing works'],
        currentVersionId: doc.tree.currentId,
        currentSha: doc.tree.nodes.at(-1)!.sha256,
        placement: { kind: 'unfiled' },
        busy: false,
      }),
    ]);
    const device = DeviceRecordSchema.parse(json(kind(drive, 'device')[0]!));
    expect(device).toMatchObject({
      role: 'primary',
      platform: 'macos',
      accepts: [],
      inbox: 'off',
      name: 'Example Mac',
    });
    // Every snapshot was copied under the document lock; nothing private left the desktop.
    expect(mem.lockedReads).toHaveLength(3);
    const wire = [...drive.files.values()]
      .filter((f) => f.mimeType === 'application/json')
      .map((f) => dec.decode(f.body));
    expect(wire.join('\n')).not.toMatch(/PRIVATE|private\.example\.com|test-model/);
    expect(engine.status()).toMatchObject({ state: 'idle', pendingUploads: 0 });
  });

  it('raises seq only when something changed, and pushes a changed document after a library event', async () => {
    const { engine, drive, lib } = await harness();
    const mem = lib as MemLibrary;
    const doc = mem.add('Widget pricing', 1);
    await engine.syncNow();
    const mark = drive.requests.length;
    await engine.syncNow();
    expect(writes(drive, mark)).toEqual([]); // nothing changed: nothing written

    mem.addVersion(doc.entry.topicSlug);
    engine.schedulePush([doc.entry.topicSlug]);
    expect(engine.status().pendingUploads).toBe(1);
    await engine.cycle();
    const libFile = kind(drive, 'lib')[0]!;
    expect(libFile.appProperties.n).toBe('2');
    expect(manifestOf(drive).seq).toBe(2);
    const treeFile = kind(drive, 'tree')[0]!;
    expect(treeFile.appProperties.n).toBe('2');
    expect(json<VersionTree>(treeFile).seq).toBe(2);
    expect(kind(drive, 'blob')).toHaveLength(2);
    expect(kind(drive, 'lib')).toHaveLength(1); // rewritten in place
  });

  it('selects snapshots by sync.history and collects deselected blobs after 7 days', async () => {
    const { engine, drive, lib, ctl, clock } = await harness();
    const mem = lib as MemLibrary;
    const doc = mem.add('Widget pricing', 12);
    await engine.syncNow();
    expect(kind(drive, 'blob')).toHaveLength(10);

    ctl.history = 'current';
    await engine.syncNow();
    expect(kind(drive, 'blob')).toHaveLength(10); // not yet: deselected blobs wait 7 days
    const tree = json<VersionTree>(kind(drive, 'tree')[0]!);
    expect(tree.nodes.filter((n) => n.uploaded).map((n) => n.id)).toEqual([doc.tree.currentId]);

    clock.t += 8 * DAY;
    await engine.syncNow();
    expect(kind(drive, 'blob').map((b) => b.appProperties.s)).toEqual([doc.tree.nodes.at(-1)!.sha256]);

    ctl.history = 'all';
    await engine.syncNow();
    expect(kind(drive, 'blob')).toHaveLength(12);
  });

  it('lists a re-minted id as a new entry with replaces and drops the old one', async () => {
    const { engine, drive, lib, state } = await harness();
    const mem = lib as MemLibrary;
    const doc = mem.add('Widget pricing', 2);
    const oldId = doc.entry.id;
    await engine.syncNow();
    const newId = '00000000-0000-4000-8000-0000000000ff';
    mem.remint(doc.entry.topicSlug, newId);
    await engine.syncNow();
    const m = manifestOf(drive);
    expect(m.docs.map((d) => [d.docId, d.replaces])).toEqual([[newId, oldId]]);
    expect(state.current().docs[oldId]!.absentSince).toBeDefined();
    // A brand-new document whose old id is still live is not a replacement.
    mem.add('Gadget costs', 1);
    await engine.syncNow();
    expect(manifestOf(drive).docs.filter((d) => d.replaces)).toHaveLength(1);
  });

  it('keeps a trashed document with placement trash, collects it once purged, and an absent one after 30 days', async () => {
    const { engine, drive, lib, clock } = await harness();
    const mem = lib as MemLibrary;
    const trashed = mem.add('Widget pricing', 2);
    const gone = mem.add('Gadget costs', 1);
    const kept = mem.add('Sprocket supply', 1);
    await engine.syncNow();
    expect(kind(drive, 'blob')).toHaveLength(4);

    mem.moveToTrash(trashed.entry.topicSlug);
    mem.remove(gone.entry.topicSlug);
    clock.t += DAY;
    await engine.syncNow();
    const m = manifestOf(drive);
    expect(m.docs.find((d) => d.docId === trashed.entry.id)?.placement).toEqual({ kind: 'trash' });
    expect(m.docs.find((d) => d.docId === gone.entry.id)).toBeUndefined();
    expect(kind(drive, 'blob')).toHaveLength(4); // nothing collected yet

    mem.purge(trashed.entry.id);
    await engine.syncNow(); // purged: collected at once
    const docsLeft = () => new Set([...drive.files.values()].map((f) => f.appProperties.d).filter(Boolean));
    expect(docsLeft()).toEqual(new Set([gone.entry.id, kept.entry.id]));

    clock.t += 29 * DAY; // 29 days absent
    await engine.syncNow();
    expect(docsLeft().has(gone.entry.id)).toBe(true);
    clock.t += 2 * DAY; // 31 days absent
    await engine.syncNow();
    expect(docsLeft()).toEqual(new Set([kept.entry.id]));
  });

  it('keeps a document trashed this session in the manifest across later pushes, without collecting it', async () => {
    const { engine, drive, lib, clock } = await harness();
    const mem = lib as MemLibrary;
    const doc = mem.add('Widget pricing', 2);
    mem.add('Sprocket supply', 1);
    await engine.syncNow();
    mem.moveToTrash(doc.entry.topicSlug);
    await engine.syncNow();
    // Two more passes (one past the GC interval): the entry stays and its blobs are kept.
    clock.t += DAY;
    await engine.syncNow();
    clock.t += DAY;
    await engine.syncNow();
    expect(manifestOf(drive).docs.find((d) => d.docId === doc.entry.id)?.placement).toEqual({ kind: 'trash' });
    expect(kind(drive, 'blob').filter((f) => f.appProperties.d === doc.entry.id)).toHaveLength(2);
  });

  it('mirrors busy documents and pushes their change once the job is done', async () => {
    const { engine, drive, lib, ctl } = await harness();
    const mem = lib as MemLibrary;
    const doc = mem.add('Widget pricing', 1);
    await engine.syncNow();
    ctl.busy.add(doc.entry.topicSlug);
    mem.addVersion(doc.entry.topicSlug);
    await engine.syncNow();
    expect(manifestOf(drive).docs[0]!.busy).toBe(true);
    expect(kind(drive, 'blob')).toHaveLength(1);
    ctl.busy.clear();
    await engine.syncNow();
    expect(manifestOf(drive).docs[0]).toMatchObject({ busy: false, currentVersionId: doc.tree.currentId });
    expect(kind(drive, 'blob')).toHaveLength(2);
  });

  it('leaves out documents the policy excludes (HOOK-SYNC-01)', async () => {
    const { engine, drive, lib, ctl } = await harness();
    const mem = lib as MemLibrary;
    const a = mem.add('Widget pricing', 1);
    mem.add('Gadget costs', 1);
    ctl.excluded.add(a.entry.id);
    await engine.syncNow();
    expect(manifestOf(drive).docs.map((d) => d.title)).toEqual(['Gadget costs']);
    expect(kind(drive, 'blob').some((b) => b.appProperties.d === a.entry.id)).toBe(false);
  });

  it('works on the real library facade', async () => {
    const { lib: real } = await testLibrary();
    const entry = await createDoc(real, 'Widget pricing');
    await real.withDocLock(entry.topicSlug, () =>
      real.updateDocument(entry.topicSlug, {
        html: HTML.replace('</h1>', '</h1><p>more</p>'),
        meta: (m) => m,
        label: "expanded 'Pricing'",
      }),
    );
    const { engine, drive } = await harness({ lib: real });
    await engine.syncNow();
    const m = manifestOf(drive);
    expect(m.docs).toHaveLength(1);
    expect(m.docs[0]!.docId).toBe(entry.id);
    const tree = VersionTreeSchema.parse(json(kind(drive, 'tree')[0]!));
    expect(tree.nodes).toHaveLength(2);
    expect(kind(drive, 'blob')).toHaveLength(2);
    for (const b of kind(drive, 'blob')) expect(sha256(gunzipSync(b.body))).toBe(b.appProperties.s);
    await real.close();
  });
});

describe('GC is off outside a normal primary state (16 §4.5 step 6, §4.7)', () => {
  it('read-only library: no push and no delete', async () => {
    const { engine, drive, lib } = await harness();
    const mem = lib as MemLibrary;
    const doc = mem.add('Widget pricing', 1);
    await engine.syncNow();
    mem.moveToTrash(doc.entry.topicSlug);
    await engine.syncNow();
    mem.purge(doc.entry.id);
    mem.readOnly = true;
    const mark = drive.requests.length;
    await engine.syncNow();
    expect(writes(drive, mark).filter((r) => r.method === 'DELETE')).toEqual([]);
    expect(kind(drive, 'blob')).toHaveLength(1);
    expect(manifestOf(drive).docs[0]!.placement).toEqual({ kind: 'trash' });
    expect(json<{ inbox: string }>(kind(drive, 'device')[0]!).inbox).toBe('paused-read-only');
    expect(engine.status().state).toBe('paused-read-only');
  });

  it('unknown remote format: nothing is written or deleted', async () => {
    const drive = new FakeDrive();
    drive.seed({
      name: 'sync-info.json',
      appProperties: { k: 'info', dev: DEV_B },
      body: JSON.stringify({
        formatVersion: 2,
        minReaderVersion: 2,
        minWriterVersion: 2,
        createdAt: '2026-10-01T00:00:00.000Z',
      }),
    });
    drive.seed({ name: 'claim', appProperties: { k: 'claim', dev: DEV_B, n: '1' }, body: '{}' });
    drive.seed({ name: 'claim', appProperties: { k: 'claim', dev: DEV_B, n: '2' }, body: '{}' });
    const { engine, lib } = await harness({ drive });
    (lib as MemLibrary).add('Widget pricing', 1);
    await engine.syncNow();
    expect(writes(drive)).toEqual([]);
    expect(engine.status()).toMatchObject({ state: 'error', message: 'Update ELI5 Learner to keep syncing' });
  });

  it('an info file this app cannot read (a newer shape) also blocks every write', async () => {
    const drive = new FakeDrive();
    drive.seed({
      name: 'sync-info.json',
      appProperties: { k: 'info', dev: DEV_B },
      body: JSON.stringify({
        formatVersion: 1,
        minReaderVersion: 1,
        minWriterVersion: 1,
        createdAt: '2026-10-01T00:00:00.000Z',
        addedLater: true,
      }),
    });
    drive.seed({ name: 'other', appProperties: { k: 'info', dev: DEV_A }, body: 'not json' });
    const { engine, lib } = await harness({ drive });
    (lib as MemLibrary).add('Widget pricing', 1);
    await engine.syncNow();
    expect(writes(drive)).toEqual([]);
    await expect(engine.makePrimary()).rejects.toMatchObject({ code: 'E_SYNC_FORMAT' });
    expect(writes(drive)).toEqual([]);
    expect(engine.status().state).toBe('error');
  });

  it('mirror: no manifest and no delete, even with stale claims around', async () => {
    const drive = new FakeDrive();
    const clock = { t: Date.parse('2026-11-01T12:00:00Z') };
    drive.seed({ name: 'old claim', appProperties: { k: 'claim', dev: DEV_B, n: String(clock.t - 5000) }, body: '{}' });
    drive.seed({ name: 'claim', appProperties: { k: 'claim', dev: DEV_B, n: String(clock.t - 1000) }, body: '{}' });
    const { engine, lib } = await harness({ drive, clock });
    (lib as MemLibrary).add('Widget pricing', 1);
    await engine.syncNow();
    expect(kind(drive, 'lib')).toEqual([]);
    expect(kind(drive, 'blob')).toEqual([]);
    expect(kind(drive, 'claim')).toHaveLength(2);
    expect(writes(drive).filter((r) => r.method === 'DELETE')).toEqual([]);
    expect(json<{ role: string }>(kind(drive, 'device', DEV_A)[0]!).role).toBe('mirror');
    expect(engine.status()).toMatchObject({ state: 'mirror', message: 'Another Mac is the primary' });
  });
});

describe('claims and takeover (16 §4.6)', () => {
  it('a second desktop mirrors; "Make this Mac the primary" waits for the old primary to acknowledge', async () => {
    const drive = new FakeDrive();
    const clock = { t: Date.parse('2026-11-01T12:00:00Z') };
    const a = await harness({ drive, clock, deviceId: DEV_A });
    const b = await harness({ drive, clock, deviceId: DEV_B });
    (a.lib as MemLibrary).add('Widget pricing', 1);
    (b.lib as MemLibrary).add('Gadget costs', 1);
    await a.engine.syncNow();
    clock.t += 1000;
    await b.engine.syncNow();
    expect(b.engine.status().state).toBe('mirror');
    expect(kind(drive, 'lib', DEV_B)).toEqual([]);

    clock.t += 1000;
    await b.engine.makePrimary();
    expect(b.engine.status()).toMatchObject({ state: 'mirror', message: 'Waiting for your other Mac to hand over' });
    expect(kind(drive, 'lib', DEV_B)).toEqual([]);

    clock.t += 1000;
    await a.engine.syncNow(); // sees the newer claim: stops writing and says so
    expect(a.engine.status().state).toBe('mirror');
    expect(json<{ role: string }>(kind(drive, 'device', DEV_A)[0]!).role).toBe('mirror');
    const aLib = kind(drive, 'lib', DEV_A)[0]!;
    const aLibBody = dec.decode(aLib.body);

    clock.t += 1000;
    await b.engine.syncNow();
    expect(b.engine.status().state).toBe('idle');
    const bm = manifestOf(drive, DEV_B);
    expect(bm.seq).toBe(2); // continues above the old primary's seq
    expect(bm.docs.map((d) => d.title)).toEqual(['Gadget costs']);
    expect(json<{ role: string }>(kind(drive, 'device', DEV_B)[0]!).role).toBe('primary');
    // The old primary's claim is garbage now; its own files are untouched.
    expect(kind(drive, 'claim').map((c) => c.appProperties.dev)).toEqual([DEV_B]);
    expect(dec.decode(kind(drive, 'lib', DEV_A)[0]!.body)).toBe(aLibBody);

    await a.engine.syncNow();
    expect(a.engine.status().state).toBe('mirror');
  });

  it('takes over from a primary that stays silent for 15 minutes', async () => {
    const drive = new FakeDrive();
    const clock = { t: Date.parse('2026-11-01T12:00:00Z') };
    const a = await harness({ drive, clock, deviceId: DEV_A });
    const b = await harness({ drive, clock, deviceId: DEV_B });
    await a.engine.syncNow();
    clock.t += 1000;
    await b.engine.makePrimary();
    expect(b.engine.status().message).toMatch(/Waiting/);
    clock.t += TAKEOVER_SILENCE_MS;
    await b.engine.syncNow();
    expect(b.engine.status().state).toBe('idle');
    expect(kind(drive, 'lib', DEV_B)).toHaveLength(1);
  });
});

describe('failures (16 §4.5 steps 4–5)', () => {
  it('a crash between steps never duplicates a file: preallocated ids are reused', async () => {
    const drive = new FakeDrive();
    const dir = await mkdtemp(path.join(tmpdir(), 'eli5-sync-engine-'));
    dirs.push(dir);
    let dead = false;
    let creates = 0;
    const crashing: typeof fetch = async (input, init) => {
      if (dead) throw new TypeError('fetch failed');
      const res = await drive.fetch(input, init);
      const url = String(input);
      if (init?.method === 'POST' && url.includes('/upload/drive/v3/files') && ++creates === 5) {
        dead = true; // the server stored the file; the response never arrived
        throw new TypeError('fetch failed');
      }
      return res;
    };
    const lib = new MemLibrary();
    lib.add('Widget pricing', 3);
    const first = await harness({ drive, lib, dir, fetch: crashing, maxAttempts: 1 });
    await first.engine.syncNow();
    expect(first.engine.status().state).toBe('error');
    expect(Object.keys(first.state.current().pendingCreates)).toHaveLength(1);
    const blobsBefore = kind(drive, 'blob').length;
    expect(blobsBefore).toBe(2);

    const second = await harness({ drive, lib, dir });
    await second.engine.syncNow();
    expect(second.engine.status().state).toBe('idle');
    const blobs = kind(drive, 'blob');
    expect(blobs).toHaveLength(3);
    expect(new Set(blobs.map((b) => b.appProperties.s)).size).toBe(3);
    expect(kind(drive, 'info')).toHaveLength(1);
    expect(kind(drive, 'claim')).toHaveLength(1);
    expect(kind(drive, 'device')).toHaveLength(1);
    expect(second.state.current().pendingCreates).toEqual({});
  });

  it('resumes an interrupted resumable upload in a later pass', async () => {
    const drive = new FakeDrive();
    const dir = await mkdtemp(path.join(tmpdir(), 'eli5-sync-engine-'));
    dirs.push(dir);
    // Random base64 compresses poorly: about 10 MiB gzipped, two 8 MiB chunks.
    const big = `<!doctype html><html><body><pre>${randomBytes(10 * 1024 * 1024).toString('base64')}</pre></body></html>`;
    const lib = new MemLibrary();
    lib.add('Widget pricing', 1, { html: () => big });
    let dead = false;
    let puts = 0;
    const crashing: typeof fetch = async (input, init) => {
      if (dead) throw new TypeError('fetch failed');
      const res = await drive.fetch(input, init);
      if (init?.method === 'PUT' && ++puts === 1) dead = true; // first chunk stored, then the network drops
      return res;
    };
    const first = await harness({ drive, lib, dir, fetch: crashing, maxAttempts: 1 });
    await first.engine.syncNow();
    expect(first.engine.status().state).toBe('error');
    expect(Object.keys(first.state.current().resumable)).toHaveLength(1);

    const mark = drive.requests.length;
    const second = await harness({ drive, lib, dir });
    await second.engine.syncNow();
    expect(second.engine.status().state).toBe('idle');
    const blob = kind(drive, 'blob')[0]!;
    expect(sha256(gunzipSync(blob.body))).toBe(sha256(big));
    const later = drive.requests.slice(mark);
    const sent = later.filter((r) => r.method === 'PUT').reduce((n, r) => n + r.bodyBytes, 0);
    expect(sent).toBeLessThan(blob.body.byteLength); // only the rest went up
    expect(later.filter((r) => r.method === 'POST' && r.url.includes('uploadType=resumable'))).toEqual([]);
    expect(second.state.current().resumable).toEqual({});
  });

  it('a checksum mismatch deletes the upload and retries with a new id', async () => {
    const { engine, drive, lib, state } = await harness();
    await engine.syncNow();
    (lib as MemLibrary).add('Widget pricing', 1);
    drive.corruptNextChecksum = true;
    const mark = drive.requests.length;
    await engine.syncNow();
    expect(engine.status().state).toBe('idle');
    expect(kind(drive, 'blob')).toHaveLength(1);
    expect(drive.requests.slice(mark).filter((r) => r.method === 'DELETE')).toHaveLength(1);
    expect(state.current().pendingCreates).toEqual({});
  });

  it('recovers from an expired change token with a full listing', async () => {
    const { engine, drive, lib } = await harness();
    (lib as MemLibrary).add('Widget pricing', 1);
    await engine.syncNow();
    drive.expireTokens();
    await engine.syncNow(); // E_SYNC_TOKEN: the pass fails and the next one lists again
    await engine.syncNow();
    expect(engine.status().state).toBe('idle');
    expect(kind(drive, 'lib')).toHaveLength(1);
  });

  it('re-uploads after the store was emptied elsewhere ("Delete hidden app data")', async () => {
    const { engine, drive, lib, dir } = await harness();
    (lib as MemLibrary).add('Widget pricing', 1);
    await engine.syncNow();
    for (const id of [...drive.files.keys()]) drive.files.delete(id);
    drive.expireTokens();
    // A new session (app restart) lists again and finds its files gone.
    const again = await harness({ drive, lib, dir });
    await again.engine.syncNow();
    expect(kind(drive, 'blob')).toHaveLength(1);
    expect(kind(drive, 'lib')).toHaveLength(1);
    expect(manifestOf(drive).docs).toHaveLength(1);
  });
});

describe('lifecycle', () => {
  it('makes no request while sync is off', async () => {
    const { engine, drive, ctl, dir } = await harness();
    ctl.active = false;
    engine.start();
    await engine.syncNow();
    expect(drive.requests).toEqual([]);
    expect(engine.status().state).toBe('off');
    // Nothing is written locally either: no device id is minted while sync is off.
    expect(existsSync(path.join(dir, 'sync'))).toBe(false);
  });

  it('reports not configured and signed out without a request', async () => {
    const drive = new FakeDrive();
    const { engine } = await harness({ drive });
    const auth = (
      engine as unknown as { d: { auth: { configured(): Promise<boolean>; signedIn(): Promise<boolean> } } }
    ).d.auth;
    auth.configured = async () => false;
    await engine.syncNow();
    expect(engine.status()).toMatchObject({ state: 'not-configured', configured: false });
    auth.configured = async () => true;
    auth.signedIn = async () => false;
    await engine.syncNow();
    expect(engine.status().state).toBe('signed-out');
    expect(drive.requests).toEqual([]);
  });

  it('forgets the store on sign-out, so the next sign-in starts from a fresh listing', async () => {
    const { engine, drive, lib } = await harness();
    (lib as MemLibrary).add('Widget pricing', 1);
    await engine.syncNow();
    const auth = (engine as unknown as { d: { auth: { signedIn(): Promise<boolean> } } }).d.auth;
    auth.signedIn = async () => false;
    const before = drive.requests.length;
    await engine.syncNow();
    expect(engine.status().state).toBe('signed-out');
    expect(drive.requests.length).toBe(before);
    expect((engine as unknown as { store: unknown }).store).toBeNull();
    auth.signedIn = async () => true;
    await engine.syncNow();
    expect(engine.status().state).toBe('idle');
    // A full listing, not a change feed from the old token.
    expect(drive.requests.slice(before).some((r) => r.path.endsWith('/changes/startPageToken'))).toBe(true);
  });

  it('throttles polls from window focus but not from resume', async () => {
    const { engine, clock } = await harness();
    const scheduled: number[] = [];
    const t = (engine as unknown as { timers: EngineTimers }).timers;
    t.setTimeout = (_fn, ms) => {
      scheduled.push(ms);
      return {};
    };
    engine.start();
    await engine.syncNow();
    scheduled.length = 0;
    engine.pollSoon(30_000);
    expect(scheduled).toEqual([]);
    engine.pollSoon();
    expect(scheduled).toEqual([0]);
    clock.t += 31_000;
    engine.pollSoon(30_000);
    expect(scheduled).toEqual([0, 0]);
  });

  it('beats every 5 minutes with a metadata-only touch of its device file', async () => {
    const { engine, drive, clock, timers } = await harness();
    await engine.syncNow();
    expect(timers.intervals).toHaveLength(1);
    const device = kind(drive, 'device')[0]!;
    const revisions = device.revisions;
    clock.t += 5 * 60_000;
    const mark = drive.requests.length;
    timers.intervals[0]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(drive.requests.slice(mark).map((r) => `${r.method} ${r.path}`)).toEqual([
      `PATCH /drive/v3/files/${device.id}`,
    ]);
    expect(device.appProperties.seen).toBe(String(Math.floor(clock.t / 1000)));
    expect(device.revisions).toBe(revisions);
  });

  it('notifies status listeners and lists the devices it knows', async () => {
    const { engine } = await harness();
    const seen: string[] = [];
    engine.onStatus((s) => seen.push(s.state));
    await engine.syncNow();
    expect(seen).toContain('syncing');
    expect(seen.at(-1)).toBe('idle');
    expect(engine.status().devices).toEqual([
      expect.objectContaining({ name: 'Example Mac', platform: 'macos', role: 'primary (this Mac)' }),
    ]);
  });

  it('"Delete cloud copy" removes every file and a later pass pushes everything again', async () => {
    const { engine, drive, lib } = await harness();
    (lib as MemLibrary).add('Widget pricing', 2);
    await engine.syncNow();
    expect(await engine.deleteRemote()).toBeGreaterThan(0);
    expect(drive.files.size).toBe(0);
    await engine.syncNow();
    expect(kind(drive, 'blob')).toHaveLength(2);
    expect(manifestOf(drive).seq).toBe(1);
  });
});
