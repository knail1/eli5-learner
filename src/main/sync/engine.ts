/**
 * The desktop sync engine (16 §4.5–§4.8): pull of the store's index, the primary claim, the device
 * file and its heartbeat, the push of the library mirror, and garbage collection.
 *
 * One pass (`cycle`) runs at a time:
 *
 * 1. Refresh the index of remote files: `changes` from the saved token, or a full `list` on first
 *    use and on token loss (`E_SYNC_TOKEN`).
 * 2. Check `sync-info.json`. A format this app does not know stops every write and delete
 *    (`E_SYNC_FORMAT`, 16 §4.5 step 6).
 * 3. Bootstrap (`sync-info.json` and the first claim) and decide the role (claims.ts, 16 §4.6).
 * 4. Write this device's file when its content changed; the heartbeat touches it every 5 minutes.
 * 5. Primary only, library writable: push blobs, then trees, then the manifest (16 §4.5), then run
 *    garbage collection when it is due (16 §4.7).
 *
 * Creates take a preallocated id that is saved in `state.json` before the upload, so a pass that
 * dies between steps never duplicates a file. The engine never imports the pipeline; bootstrap
 * feeds it library events and reads its status.
 */
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import type { CatalogEntry, Library, LibraryOrganization } from '../library';
import { log } from '../security';
import type { SyncStatus } from '../../preload/contract';
import { claimBody, claimName, claimRefs, decideRole, nextClaimMs, type ClaimRole, type DeviceView } from './claims';
import { planGc, TERMINAL_JOB_STATES, type GcDoc } from './gc';
import { Heartbeat, seenNow, type HeartbeatTimers } from './heartbeat';
import {
  buildDocEntry,
  buildManifest,
  buildTree,
  contentHash,
  encodeJson,
  placementOf,
  selectHistory,
  type CurrentVersion,
  type HistoryMode,
} from './manifest';
import {
  AcksSchema,
  DeviceRecordSchema,
  JobRequestSchema,
  JobStatusSchema,
  LibraryManifestSchema,
  PROTOCOL_VERSION,
  SYNC_FORMAT_VERSION,
  SyncInfoSchema,
  type DeviceRecord,
  type JobKind,
  type ManifestDoc,
} from './protocol';
import type { SyncDocState, SyncState, SyncStateStore } from './state';
import { sha256Hex } from './stores/drive-appdata';
import type { GuardedStore, GuardOptions } from './stores/guard';
import type { RemoteFile, RemoteProps, SyncKind, SyncPolicy } from './types';
import { SYNC_ERROR_TEXT, SyncError } from './types';

/** Library events are coalesced for this long before a push (16 §4.5). */
export const PUSH_DEBOUNCE_MS = 5000;
/** Garbage collection runs at most this often, unless a purge is waiting (16 §4.7). */
export const GC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Window focus polls no more often than this (16 §4.8); resume and "Sync now" are not throttled. */
export const FOCUS_POLL_GAP_MS = 30_000;
/** Largest small JSON file (info, device, job, status, acks) the engine downloads; larger ones are invalid. */
export const MAX_JSON_BYTES = 4 * 1024 * 1024;
/** Ids requested per `generateIds` call. */
const ID_BATCH = 20;
const JSON_MIME = 'application/json';
const BLOB_MIME = 'application/gzip';

/** The library facade calls the engine uses (09 §4.3, "read through the facade only"). */
export type SyncLibrary = Pick<
  Library,
  'readOnly' | 'list' | 'getMeta' | 'versions' | 'readVersion' | 'withDocLock' | 'organization'
>;

export interface EngineTimers extends HeartbeatTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SyncEngineDeps {
  library: SyncLibrary;
  state: SyncStateStore;
  /** `syncActive`: `sync.enabled` and the policy allows it (HOOK-SYNC-01). */
  active(): boolean;
  /** Builds the guarded store (`openSyncStore`); null while sync is off. */
  openStore(guard: GuardOptions): GuardedStore | null;
  auth: { configured(): Promise<boolean>; signedIn(): Promise<boolean> };
  history(): HistoryMode;
  pollSeconds(): number;
  policy(): Pick<SyncPolicy, 'excludeDoc'>;
  /** Section headings of the in-depth tab, from the DocumentModel (16 §4.4); [] when it does not parse. */
  outline(html: Uint8Array): string[];
  /** A section job of the document is in flight (08 locks). */
  isBusy(slug: string): boolean;
  device: { name: string; appVersion: string };
  /** The phone inbox (S10): job kinds this desktop runs and whether the user turned it on. */
  inbox?: { accepts(): JobKind[]; enabled(): boolean; pending?(): number };
  now?: () => number;
  timers?: EngineTimers;
  debounceMs?: number;
  gcIntervalMs?: number;
}

/** Only the version fields of `sync-info.json`, for the format check (16 §4.5 step 6). */
const InfoVersionsSchema = z.looseObject({
  formatVersion: z.number().int().min(1),
  minWriterVersion: z.number().int().min(1),
});

const realTimers: EngineTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    return t;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

const codeOf = (err: unknown): string => {
  const c = (err as { code?: unknown } | undefined)?.code;
  return typeof c === 'string' ? c : 'unknown';
};

interface CachedBody {
  stamp: string;
  value: unknown;
}

/** Remote props of an own file recorded in state, so the guard knows it after a restart. */
function ownProps(role: string, me: string, docId?: string): RemoteProps | undefined {
  if (docId) {
    if (role === 'tree') return { k: 'tree', dev: me, d: docId };
    if (role.startsWith('blob:')) return { k: 'blob', dev: me, d: docId, s: role.slice(5) };
    return undefined;
  }
  if (role === 'info' || role === 'claim' || role === 'device' || role === 'lib') return { k: role, dev: me };
  return undefined;
}

const freshDoc = (): SyncDocState => ({
  treeSeq: 0,
  uploadedShas: [],
  fileIds: {},
  trashed: false,
  purged: false,
  unselectedSince: {},
});

export class SyncEngine {
  private store: GuardedStore | null = null;
  private role: ClaimRole | undefined;
  private readonly index = new Map<string, RemoteFile>();
  private readonly bodies = new Map<string, CachedBody>();
  /** Manifest entries of live documents pushed this session. */
  private readonly entries = new Map<string, ManifestDoc>();
  /** The manifest found in the store at start: entries for documents now in the Trash. */
  private readonly previous = new Map<string, ManifestDoc>();
  /** Shas selected by `sync.history`, per document pushed this session. */
  private readonly selected = new Map<string, Set<string>>();
  private readonly dirty = new Set<string>();
  private readonly createdThisSession = new Set<string>();
  /** Document ids in the manifest last built (live and Trash): what garbage collection keeps. */
  private manifestIds: Set<string> | undefined;
  /** "Delete cloud copy" is running: passes wait it out instead of writing into the wipe. */
  private wiping = false;
  private lastPassAt = 0;
  private idPool: string[] = [];
  private full = true;
  private indexed = false;
  private formatBlocked = false;
  private configured = false;
  private signedIn = false;
  /** `configured` and `signedIn` were read at least once since start. */
  private authChecked = false;
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = true;
  private lastError: unknown;
  private lastSyncAt: string | undefined;
  private debounce: unknown;
  private pollTimer: unknown;
  private readonly heartbeat: Heartbeat;
  /** This device's record as last written. */
  private ownDevice: DeviceRecord | undefined;
  private readonly listeners = new Set<(s: SyncStatus) => void>();
  private lastStatusJson = '';
  private readonly now: () => number;
  private readonly timers: EngineTimers;

  constructor(private readonly d: SyncEngineDeps) {
    this.now = d.now ?? Date.now;
    this.timers = d.timers ?? realTimers;
    this.heartbeat = new Heartbeat({
      now: this.now,
      timers: this.timers,
      target: () => {
        if (!this.store || this.formatBlocked) return null;
        const id = this.d.state.current().files.device;
        return id ? { store: this.store, fileId: id } : null;
      },
    });
  }

  // ---------------------------------------------------------------------------- lifecycle

  /** Starts polling when sync is active; otherwise makes sure nothing runs. */
  start(): void {
    if (!this.d.active()) {
      this.stop();
      this.emit();
      return;
    }
    this.stopped = false;
    this.schedulePoll(0);
  }

  /** Re-evaluates after a settings, sign-in or policy change. */
  refresh(): void {
    if (this.d.active()) {
      if (this.stopped) this.start();
      else this.pollSoon();
    } else {
      this.stop();
      this.emit();
    }
  }

  /** Stops timers and forgets the store; an in-flight pass ends at its next step. Never waits on the network. */
  stop(): void {
    this.stopped = true;
    if (this.debounce !== undefined) this.timers.clearTimeout(this.debounce);
    if (this.pollTimer !== undefined) this.timers.clearTimeout(this.pollTimer);
    this.debounce = undefined;
    this.pollTimer = undefined;
    this.heartbeat.stop();
    this.store = null;
    this.role = undefined;
    this.index.clear();
    this.indexed = false;
    this.full = true;
    this.idPool = [];
  }

  private dropStore(): void {
    this.store = null;
    this.role = undefined;
    this.index.clear();
    this.bodies.clear();
    this.indexed = false;
    this.full = true;
    this.idPool = [];
  }

  /** Library changed (16 §4.5 trigger): push those documents after a 5 s quiet period. */
  schedulePush(slugs: readonly string[] = []): void {
    for (const s of slugs) this.dirty.add(s);
    if (this.stopped || !this.d.active()) return;
    if (this.debounce !== undefined) this.timers.clearTimeout(this.debounce);
    this.debounce = this.timers.setTimeout(() => {
      this.debounce = undefined;
      void this.cycle();
    }, this.d.debounceMs ?? PUSH_DEBOUNCE_MS);
  }

  /**
   * Window focus or `powerMonitor` resume (16 §4.8): poll now. With `minGapMs` (window focus), a
   * pass that started less than that long ago makes this a no-op, so switching windows does not
   * hammer the store.
   */
  pollSoon(minGapMs = 0): void {
    if (this.stopped || !this.d.active()) return;
    if (minGapMs > 0 && (this.running || this.now() - this.lastPassAt < minGapMs)) return;
    this.schedulePoll(0);
  }

  /** "Sync now": a full pass, resolved with the status after it. */
  async syncNow(): Promise<SyncStatus> {
    this.full = true;
    if (this.stopped && this.d.active()) this.stopped = false;
    await this.cycle();
    return this.status();
  }

  /** "Make this Mac the primary" (16 §4.6): a new claim, then wait for the old primary. */
  async makePrimary(): Promise<SyncStatus> {
    const store = await this.ready();
    this.stopped = false;
    await this.checkFormat(store);
    if (this.formatBlocked) throw new SyncError('E_SYNC_FORMAT');
    if (this.role?.role === 'primary' || this.role?.role === 'waiting') return this.status();
    const ms = nextClaimMs(claimRefs(this.index.values()), this.now());
    await this.createClaim(store, ms);
    this.full = true;
    await this.cycle();
    return this.status();
  }

  /**
   * "Delete cloud copy" (16 §4.7): deletes every file in the store, whoever wrote it, and forgets
   * what was uploaded. The local library is untouched; a later pass pushes everything again.
   */
  async deleteRemote(): Promise<number> {
    const store = await this.ready();
    this.wiping = true;
    try {
      return await this.wipe(store);
    } finally {
      this.wiping = false;
    }
  }

  private async wipe(store: GuardedStore): Promise<number> {
    await this.running?.catch(() => {});
    this.heartbeat.stop();
    const n = await store.wipe();
    await this.d.state.update((s) => {
      s.startToken = undefined;
      s.primary = false;
      s.manifestSeq = 0;
      s.docs = {};
      s.pendingCreates = {};
      s.resumable = {};
      s.files = {};
      s.manifestHash = undefined;
      s.deviceHash = undefined;
      s.lastGcAt = undefined;
    });
    this.index.clear();
    this.bodies.clear();
    this.entries.clear();
    this.previous.clear();
    this.selected.clear();
    this.createdThisSession.clear();
    this.manifestIds = undefined;
    this.role = undefined;
    this.indexed = false;
    this.full = true;
    log.info('sync.remote-deleted', { count: n });
    this.emit();
    return n;
  }

  onStatus(cb: (s: SyncStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** The current status (16 §8 `SyncStatus`): no token, client value or document content. */
  status(): SyncStatus {
    let st: SyncState | undefined;
    try {
      st = this.d.state.current();
    } catch {
      st = undefined;
    }
    const base = {
      configured: this.configured,
      pendingUploads: this.dirty.size,
      inboxPending: this.d.inbox?.pending?.() ?? 0,
      devices: this.devicesView(st?.deviceId),
      ...(st?.account ? { account: st.account } : {}),
      ...(this.lastSyncAt ? { lastSyncAt: this.lastSyncAt } : {}),
    };
    if (!this.d.active()) return { ...base, state: 'off' };
    if (this.authChecked && !this.configured) {
      return { ...base, state: 'not-configured', message: SYNC_ERROR_TEXT.E_SYNC_NOT_CONFIGURED! };
    }
    if (this.authChecked && !this.signedIn) return { ...base, state: 'signed-out' };
    if (this.running) return { ...base, state: 'syncing' };
    if (this.formatBlocked) return { ...base, state: 'error', message: SYNC_ERROR_TEXT.E_SYNC_FORMAT! };
    if (this.d.library.readOnly) return { ...base, state: 'paused-read-only' };
    if (this.lastError !== undefined) {
      const code = codeOf(this.lastError) as keyof typeof SYNC_ERROR_TEXT;
      return { ...base, state: 'error', message: SYNC_ERROR_TEXT[code] ?? 'Sync could not finish; it will try again' };
    }
    if (this.role?.role === 'waiting') {
      return { ...base, state: 'mirror', message: 'Waiting for your other Mac to hand over' };
    }
    if (this.role?.role === 'mirror') return { ...base, state: 'mirror', message: 'Another Mac is the primary' };
    return { ...base, state: 'idle' };
  }

  // ------------------------------------------------------------------------------- passes

  /** One pass; concurrent calls join it and run one more pass after. Never rejects. */
  cycle(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && !this.stopped);
      } finally {
        this.running = undefined;
        this.emit();
        if (!this.stopped) this.schedulePoll(this.d.pollSeconds() * 1000);
      }
    })();
    this.emit();
    return this.running;
  }

  private schedulePoll(ms: number): void {
    if (this.pollTimer !== undefined) this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = this.timers.setTimeout(() => {
      this.pollTimer = undefined;
      void this.cycle();
    }, ms);
  }

  /** The store when sync is active, configured and signed in; else throws `E_SYNC_*`. */
  private async ready(): Promise<GuardedStore> {
    if (!this.d.active()) throw new SyncError('E_SYNC_DISABLED', 'Sync is off');
    this.configured = await this.d.auth.configured();
    this.signedIn = this.configured && (await this.d.auth.signedIn());
    this.authChecked = true;
    if (!this.configured) throw new SyncError('E_SYNC_NOT_CONFIGURED');
    if (!this.signedIn) throw new SyncError('E_SYNC_AUTH');
    const st = await this.d.state.load();
    if (!this.store) {
      this.store = this.d.openStore({
        deviceId: st.deviceId,
        isPrimary: () => this.role?.role === 'primary' && !this.formatBlocked && !this.d.library.readOnly,
      });
      if (!this.store) throw new SyncError('E_SYNC_DISABLED', 'Sync is off');
      this.rememberOwn(this.store, st);
    }
    if (!this.indexed) await this.refreshIndex(this.store);
    return this.store;
  }

  private async pass(): Promise<void> {
    const started = this.now();
    this.lastPassAt = started;
    try {
      if (!this.d.active()) {
        this.stop();
        return;
      }
      if (this.wiping) return;
      const fresh = !this.indexed;
      const store = await this.ready().catch((err: unknown) => {
        const code = codeOf(err);
        if (code === 'E_SYNC_DISABLED' || code === 'E_SYNC_NOT_CONFIGURED') return null;
        if (code === 'E_SYNC_AUTH' && !this.signedIn) return null;
        throw err;
      });
      if (!store || this.stopped) {
        this.heartbeat.stop();
        // Signed out or unconfigured: forget the store and its index, so a later sign-in (perhaps
        // as another account) starts from a fresh listing instead of this account's view.
        this.dropStore();
        return;
      }
      if (!fresh) await this.refreshIndex(store);
      await this.checkFormat(store);
      if (this.formatBlocked || this.stopped) {
        this.heartbeat.stop();
        return;
      }
      await this.bootstrapStore(store);
      await this.decideRole(store);
      await this.writeDevice(store);
      this.heartbeat.start();
      if (this.role?.role === 'primary' && !this.d.library.readOnly && !this.stopped) {
        await this.push(store);
        await this.gcIfDue(store);
      }
      this.full = false;
      this.lastError = undefined;
      this.lastSyncAt = new Date(this.now()).toISOString();
      await this.d.state.update((s) => {
        s.lastSyncAt = this.lastSyncAt;
        s.primary = this.role?.role === 'primary';
      });
      log.info('sync.pass', { status: this.role?.role ?? 'none', durationMs: this.now() - started });
    } catch (err) {
      this.lastError = err;
      if (codeOf(err) === 'E_SYNC_TOKEN') this.indexed = false;
      log.warn('sync.pass-failed', { code: codeOf(err), durationMs: this.now() - started });
    }
  }

  // -------------------------------------------------------------------------------- index

  /** Changes since the saved token, or a full listing (first use, token loss). */
  private async refreshIndex(store: GuardedStore): Promise<void> {
    const st = this.d.state.current();
    if (this.indexed && st.startToken) {
      try {
        const r = await store.changes(st.startToken);
        for (const c of r.changes) {
          if (c.removed) {
            this.index.delete(c.fileId);
            this.bodies.delete(c.fileId);
          } else if (c.file) this.index.set(c.fileId, c.file);
        }
        if (r.nextToken !== st.startToken) {
          await this.d.state.update((s) => {
            s.startToken = r.nextToken;
          });
        }
        return;
      } catch (err) {
        if (codeOf(err) !== 'E_SYNC_TOKEN') throw err;
        log.info('sync.token-expired', { step: 'changes' });
      }
    }
    // Token first, then the listing: a change made in between shows up in the next `changes`.
    const token = await store.startToken();
    const files = await store.list({});
    this.index.clear();
    for (const f of files) this.index.set(f.id, f);
    await this.forgetVanished(store);
    await this.d.state.update((s) => {
      s.startToken = token;
    });
    this.indexed = true;
    await this.loadPreviousManifest(store);
  }

  /**
   * Own files recorded in state but missing from a full listing were deleted elsewhere (for example
   * "Delete hidden app data" in Google Drive). Files created this session may simply not be listed
   * yet (eventual consistency) and are kept.
   */
  private async forgetVanished(_store: GuardedStore): Promise<void> {
    const st = this.d.state.current();
    const gone = (id: string): boolean => !this.index.has(id) && !this.createdThisSession.has(id);
    const lost: string[] = [];
    for (const [role, id] of Object.entries(st.files)) if (gone(id)) lost.push(role);
    const lostDocs: Array<[string, string]> = [];
    for (const [docId, ds] of Object.entries(st.docs)) {
      for (const [role, id] of Object.entries(ds.fileIds)) if (gone(id)) lostDocs.push([docId, role]);
    }
    if (lost.length === 0 && lostDocs.length === 0) return;
    log.info('sync.remote-files-missing', { count: lost.length + lostDocs.length });
    await this.d.state.update((s) => {
      for (const role of lost) delete s.files[role];
      if (lost.includes('lib')) s.manifestHash = undefined;
      if (lost.includes('device')) s.deviceHash = undefined;
      for (const [docId, role] of lostDocs) {
        const ds = s.docs[docId];
        if (!ds) continue;
        delete ds.fileIds[role];
        if (role === 'tree') ds.treeHash = undefined;
        if (role.startsWith('blob:')) ds.uploadedShas = ds.uploadedShas.filter((x) => x !== role.slice(5));
      }
    });
    this.entries.clear();
    this.full = true;
  }

  /** The manifest this device last wrote: entries for documents that are now in the Trash. */
  private async loadPreviousManifest(store: GuardedStore): Promise<void> {
    const id = this.d.state.current().files.lib;
    if (!id || this.previous.size > 0) return;
    try {
      const m = LibraryManifestSchema.safeParse(JSON.parse(new TextDecoder().decode(await store.get(id))));
      if (m.success) for (const doc of m.data.docs) this.previous.set(doc.docId, doc);
    } catch (err) {
      log.info('sync.manifest-unreadable', { code: codeOf(err) });
    }
  }

  private files(kind: SyncKind): RemoteFile[] {
    return [...this.index.values()].filter((f) => f.props.k === kind);
  }

  /** Downloads and parses a small JSON file, cached until its modifiedTime changes. */
  private async body<T>(
    store: GuardedStore,
    f: RemoteFile,
    parse: (v: unknown) => { success: true; data: T } | { success: false },
  ): Promise<T | undefined> {
    const stamp = `${f.modifiedTime ?? ''}|${f.sha256 ?? ''}|${f.size ?? ''}`;
    const hit = this.bodies.get(f.id);
    if (hit && hit.stamp === stamp) return hit.value as T | undefined;
    if (f.size !== undefined && f.size > MAX_JSON_BYTES) {
      this.bodies.set(f.id, { stamp, value: undefined });
      return undefined;
    }
    let value: T | undefined;
    try {
      const bytes = await store.get(f.id);
      if (bytes.byteLength > MAX_JSON_BYTES) throw new Error('too large');
      const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
      const r = parse(raw);
      value = r.success ? r.data : undefined;
    } catch (err) {
      if (codeOf(err) === 'E_SYNC_NOT_FOUND') {
        this.index.delete(f.id);
        return undefined;
      }
      if (err instanceof SyncError) throw err;
      value = undefined; // not JSON: treated as invalid
    }
    this.bodies.set(f.id, { stamp, value });
    return value;
  }

  // ------------------------------------------------------------------ format, claims, device

  /** 16 §4.5 step 6: a remote format this app does not know stops all writes and deletes. */
  private async checkFormat(store: GuardedStore): Promise<void> {
    let blocked = false;
    for (const f of this.files('info')) {
      // Read loosely: a newer format may add fields the strict schema refuses. An info file that
      // does not even carry readable versions is treated as unknown, so nothing is written.
      const info = await this.body(store, f, (v) => InfoVersionsSchema.safeParse(v));
      if (!info || info.formatVersion > SYNC_FORMAT_VERSION || info.minWriterVersion > SYNC_FORMAT_VERSION) {
        blocked = true;
      }
    }
    if (blocked && !this.formatBlocked) log.warn('sync.format-unknown', { code: 'E_SYNC_FORMAT' });
    this.formatBlocked = blocked;
    if (blocked) this.lastError = new SyncError('E_SYNC_FORMAT');
  }

  /** The first desktop writes `sync-info.json` and the first claim (16 §4.6). */
  private async bootstrapStore(store: GuardedStore): Promise<void> {
    const st = this.d.state.current();
    if (this.files('info').length === 0 && !st.files.info) {
      const info = SyncInfoSchema.parse({
        formatVersion: SYNC_FORMAT_VERSION,
        minReaderVersion: SYNC_FORMAT_VERSION,
        minWriterVersion: SYNC_FORMAT_VERSION,
        createdAt: new Date(this.now()).toISOString(),
      });
      await this.ensureOwn(
        store,
        'info',
        'sync-info.json',
        { k: 'info', dev: st.deviceId },
        encodeJson(info),
        JSON_MIME,
        (s, id) => {
          s.files.info = id;
        },
      );
    }
    if (claimRefs(this.index.values()).length === 0) await this.createClaim(store, this.now());
  }

  private async createClaim(store: GuardedStore, ms: number): Promise<void> {
    const me = this.d.state.current().deviceId;
    await this.ensureOwn(
      store,
      `claim:${ms}`,
      claimName(ms, me),
      { k: 'claim', dev: me, n: ms },
      encodeJson(claimBody(ms, me)),
      JSON_MIME,
      (s, id) => {
        s.files.claim = id;
      },
    );
    log.info('sync.claimed', { step: 'claim' });
  }

  private async deviceViews(store: GuardedStore): Promise<Map<string, DeviceView & { record?: DeviceRecord }>> {
    const out = new Map<string, DeviceView & { record?: DeviceRecord }>();
    for (const f of this.files('device')) {
      const record = await this.body(store, f, (v) => DeviceRecordSchema.safeParse(v));
      // The body names the device; a file whose writer differs from its body is ignored.
      if (record && record.deviceId !== f.props.dev) continue;
      const mt = f.modifiedTime ? Date.parse(f.modifiedTime) : NaN;
      const seenMs = f.props.seen !== undefined ? f.props.seen * 1000 : Number.isFinite(mt) ? mt : undefined;
      const prev = out.get(f.props.dev);
      if (prev && (prev.seenMs ?? 0) >= (seenMs ?? 0)) continue;
      out.set(f.props.dev, {
        ...(record ? { role: record.role, record } : {}),
        ...(seenMs !== undefined ? { seenMs } : {}),
      });
    }
    return out;
  }

  private async decideRole(store: GuardedStore): Promise<void> {
    const me = this.d.state.current().deviceId;
    const next = decideRole({
      me,
      claims: claimRefs(this.index.values()),
      devices: await this.deviceViews(store),
      now: this.now(),
    });
    if (this.role?.role !== next.role) {
      log.info('sync.role', { from: this.role?.role ?? 'none', to: next.role });
      // Gained the primary: rebuild every remote view from the disk (16 §1 principle 5).
      if (next.role === 'primary') this.full = true;
    }
    this.role = next;
  }

  /** This device's record (16 §4.3), rewritten only when it changed. */
  private async writeDevice(store: GuardedStore): Promise<void> {
    const st = this.d.state.current();
    const primary = this.role?.role === 'primary';
    const readOnly = this.d.library.readOnly;
    const record = DeviceRecordSchema.parse({
      v: PROTOCOL_VERSION,
      deviceId: st.deviceId,
      platform: 'macos',
      name: this.d.device.name.trim().slice(0, 100) || 'Mac',
      appVersion: this.d.device.appVersion.slice(0, 40) || '0.0.0',
      role: primary ? 'primary' : 'mirror',
      accepts: primary ? [...new Set(this.d.inbox?.accepts() ?? [])] : [],
      inbox: readOnly ? 'paused-read-only' : primary && this.d.inbox?.enabled() ? 'on' : 'off',
    } satisfies DeviceRecord);
    this.ownDevice = record;
    const body = encodeJson(record);
    const hash = sha256Hex(body);
    if (st.files.device && st.deviceHash === hash) return;
    await this.writeOwn(
      store,
      'device',
      `device-${st.deviceId}.json`,
      { k: 'device', dev: st.deviceId, seen: seenNow(this.now()) },
      body,
      st.files.device,
      (s, id) => {
        s.files.device = id;
        s.deviceHash = hash;
      },
    );
  }

  // ---------------------------------------------------------------------------------- push

  private async push(store: GuardedStore): Promise<void> {
    const lib = this.d.library;
    const policy = this.d.policy();
    const org = await lib.organization();
    const live = lib.list().filter((e) => !policy.excludeDoc({ id: e.id, slug: e.topicSlug }));
    const liveIds = new Set(live.map((e) => e.id));
    const full = this.full;
    for (const e of live) {
      if (this.stopped) return;
      if (!full && this.entries.has(e.id) && !this.dirty.has(e.topicSlug)) continue;
      if (this.d.isBusy(e.topicSlug)) continue; // pushed once the job finishes (its change event)
      // A document that could not be read stays pending and is tried again on the next pass.
      if (await this.pushDoc(store, e, liveIds)) this.dirty.delete(e.topicSlug);
    }
    // Dirty slugs that are no longer catalogued are handled by the manifest diff below.
    for (const s of [...this.dirty]) if (!live.some((e) => e.topicSlug === s)) this.dirty.delete(s);
    await this.pushManifest(store, live, liveIds, org);
  }

  /** Blobs selected by `sync.history`, then the tree (16 §4.5 steps 2–3). */
  private async pushDoc(store: GuardedStore, e: CatalogEntry, liveIds: ReadonlySet<string>): Promise<boolean> {
    const lib = this.d.library;
    const slug = e.topicSlug;
    let view;
    try {
      view = await lib.versions(slug);
    } catch (err) {
      log.info('sync.doc-skipped', { code: codeOf(err), step: 'versions' });
      return false;
    }
    const tree = view.tree;
    const currentNode = tree.nodes.find((n) => n.id === tree.currentId);
    if (!currentNode?.sha256) return false;
    const st = this.d.state.current();
    const me = st.deviceId;
    const known = st.docs[e.id];
    // A re-minted id (09 §7 step 4, Put Back): a new docId whose tree is a document that left.
    let replaces = known?.replaces;
    if (!known) {
      const old = Object.entries(st.docs).find(
        ([id, ds]) => id !== e.id && ds.rootId === tree.rootId && !liveIds.has(id),
      );
      if (old) replaces = old[0];
    }
    const selected = selectHistory(tree, this.d.history());
    const selShas = new Set(selected.map((n) => n.sha256!));
    const uploaded = new Set(known?.uploadedShas ?? []);
    let currentHtml: Buffer | undefined;
    for (const n of selected) {
      const sha = n.sha256!;
      if (this.stopped) return false;
      if (uploaded.has(sha)) continue;
      const html = await this.readSnapshot(slug, n.id);
      if (!html) continue;
      if (sha256Hex(html) !== sha) {
        log.warn('sync.snapshot-mismatch', { step: 'blob' });
        continue;
      }
      if (n.id === currentNode.id) currentHtml = html;
      await this.ensureOwn(
        store,
        `doc:${e.id}:blob:${sha}`,
        `blob-${sha}.html.gz`,
        { k: 'blob', dev: me, d: e.id, s: sha },
        new Uint8Array(gzipSync(html)),
        BLOB_MIME,
        (s, id) => {
          const ds = (s.docs[e.id] ??= freshDoc());
          if (!ds.uploadedShas.includes(sha)) ds.uploadedShas.push(sha);
          ds.fileIds[`blob:${sha}`] = id;
        },
      );
      uploaded.add(sha);
    }
    this.selected.set(e.id, selShas);

    // The live version: size and headings are read once per sha.
    let current: CurrentVersion;
    if (known?.current && known.current.sha === currentNode.sha256) {
      current = { ...known.current, versionId: currentNode.id };
    } else {
      currentHtml ??= await this.readSnapshot(slug, currentNode.id);
      if (!currentHtml) return false;
      current = {
        versionId: currentNode.id,
        sha: currentNode.sha256,
        sizeBytes: currentHtml.byteLength,
        headings: this.d.outline(currentHtml),
      };
    }

    const nowIso = new Date(this.now()).toISOString();
    const shown = new Set([...selShas].filter((s) => uploaded.has(s)));
    const treeBody = buildTree({ docId: e.id, seq: 1, tree, uploaded: shown, fallbackTime: nowIso });
    const treeHash = contentHash(treeBody);
    const ds0 = this.d.state.current().docs[e.id];
    if (!ds0?.fileIds.tree || ds0.treeHash !== treeHash) {
      const remoteMax = Math.max(
        0,
        ...this.files('tree')
          .filter((f) => f.props.d === e.id)
          .map((f) => f.props.n ?? 0),
      );
      const seq = Math.max(ds0?.treeSeq ?? 0, remoteMax) + 1;
      await this.writeOwn(
        store,
        `doc:${e.id}:tree`,
        `tree-${e.id}.json`,
        { k: 'tree', dev: me, d: e.id, n: seq },
        encodeJson({ ...treeBody, seq }),
        ds0?.fileIds.tree,
        (s, id) => {
          const ds = (s.docs[e.id] ??= freshDoc());
          ds.fileIds.tree = id;
          ds.treeSeq = seq;
          ds.treeHash = treeHash;
        },
      );
    }

    const meta = await lib.getMeta(slug).catch(() => undefined);
    if (!meta) return false;
    const entry = buildDocEntry({
      entry: e,
      meta,
      current,
      placement: { kind: 'unfiled' }, // set per push from the organization view
      busy: false,
      ...(replaces ? { replaces } : {}),
      fallbackTime: nowIso,
    });
    this.entries.set(e.id, entry);
    await this.d.state.update((s) => {
      const ds = (s.docs[e.id] ??= freshDoc());
      ds.rootId = tree.rootId;
      if (replaces) ds.replaces = replaces;
      else delete ds.replaces;
      ds.current = { ...current, headings: [...current.headings] };
      ds.trashed = false;
      ds.purged = false;
      delete ds.absentSince;
      // 16 §4.7: blobs no longer selected are collected after 7 days.
      for (const sha of ds.uploadedShas) {
        if (selShas.has(sha)) delete ds.unselectedSince[sha];
        else ds.unselectedSince[sha] ??= nowIso;
      }
      for (const sha of Object.keys(ds.unselectedSince)) {
        if (!ds.uploadedShas.includes(sha)) delete ds.unselectedSince[sha];
      }
    });
    return true;
  }

  /** One snapshot's html, copied under the document lock (16 §4.5 step 2). */
  private async readSnapshot(slug: string, versionId: string): Promise<Buffer | undefined> {
    try {
      return await this.d.library.withDocLock(
        slug,
        async () => (await this.d.library.readVersion(slug, versionId)).html,
      );
    } catch (err) {
      log.info('sync.doc-skipped', { code: codeOf(err), step: 'read' });
      return undefined;
    }
  }

  /** The manifest last (16 §4.5 step 3), plus the bookkeeping for documents that left it. */
  private async pushManifest(
    store: GuardedStore,
    live: readonly CatalogEntry[],
    liveIds: ReadonlySet<string>,
    org: LibraryOrganization,
  ): Promise<void> {
    const docs: ManifestDoc[] = [];
    for (const e of live) {
      const cached = this.entries.get(e.id) ?? this.previous.get(e.id);
      if (!cached) continue;
      docs.push({ ...cached, placement: placementOf(org, e.id), busy: this.d.isBusy(e.topicSlug) });
    }
    const trashedIds = new Set<string>();
    for (const t of org.trash) {
      if (liveIds.has(t.docId)) continue;
      const prev = this.entries.get(t.docId) ?? this.previous.get(t.docId);
      if (!prev || this.d.policy().excludeDoc({ id: t.docId, slug: t.topicSlug })) continue;
      trashedIds.add(t.docId);
      docs.push({ ...prev, placement: { kind: 'trash' }, busy: false });
    }
    const inManifest = new Set(docs.map((x) => x.docId));
    const st = this.d.state.current();
    const nowIso = new Date(this.now()).toISOString();
    // Documents found in the store under this device but unknown to state (a lost state file).
    const orphanIds = new Set<string>();
    for (const f of this.index.values()) {
      if (
        f.props.dev === st.deviceId &&
        (f.props.k === 'blob' || f.props.k === 'tree') &&
        f.props.d &&
        !st.docs[f.props.d]
      ) {
        orphanIds.add(f.props.d);
      }
    }
    await this.d.state.update((s) => {
      for (const id of orphanIds) s.docs[id] ??= freshDoc();
      for (const [id, ds] of Object.entries(s.docs)) {
        if (trashedIds.has(id)) {
          ds.trashed = true;
          delete ds.absentSince;
          continue;
        }
        if (inManifest.has(id)) continue;
        if (ds.trashed) ds.purged = true; // left the Trash without coming back: purged (16 §4.7)
        ds.trashed = false;
        ds.absentSince ??= nowIso;
      }
    });
    // Entries of documents in the Trash are kept: the next push lists them again (and a document
    // that drops out of the manifest while in the Trash would count as purged and be collected).
    for (const id of [...this.entries.keys()]) if (!liveIds.has(id) && !trashedIds.has(id)) this.entries.delete(id);
    this.manifestIds = inManifest;

    const folders = org.folders.map((f) => ({ id: f.id, name: f.name }));
    const draft = buildManifest({ seq: 1, generatedAt: nowIso, folders, docs });
    const hash = contentHash(draft);
    const st2 = this.d.state.current();
    if (st2.files.lib && st2.manifestHash === hash) return;
    const remoteMax = Math.max(0, ...this.files('lib').map((f) => f.props.n ?? 0));
    const seq = Math.max(st2.manifestSeq, remoteMax) + 1;
    await this.writeOwn(
      store,
      'lib',
      `lib-${st2.deviceId}.json`,
      { k: 'lib', dev: st2.deviceId, n: seq },
      encodeJson({ ...draft, seq }),
      st2.files.lib,
      (s, id) => {
        s.files.lib = id;
        s.manifestSeq = seq;
        s.manifestHash = hash;
      },
    );
    log.info('sync.manifest-written', { count: docs.length });
  }

  // ----------------------------------------------------------------------------------- GC

  private async gcIfDue(store: GuardedStore): Promise<void> {
    const st = this.d.state.current();
    const now = this.now();
    const last = st.lastGcAt ? Date.parse(st.lastGcAt) : 0;
    const purgeWaiting = Object.values(st.docs).some((ds) => ds.purged);
    if (!purgeWaiting && now - last < (this.d.gcIntervalMs ?? GC_INTERVAL_MS)) return;
    await this.collect(store);
  }

  /** One garbage collection run (16 §4.7). Primary, normal state only; the guard checks again. */
  async collect(store?: GuardedStore): Promise<number> {
    const s0 = store ?? this.store;
    if (!s0 || this.role?.role !== 'primary' || this.formatBlocked || this.d.library.readOnly) return 0;
    const st = this.d.state.current();
    const now = this.now();
    const docs = new Map<string, GcDoc>();
    const manifestIds = this.manifestIds ?? new Set([...this.entries.keys()]);
    for (const [id, ds] of Object.entries(st.docs)) {
      const inManifest = manifestIds.has(id) || ds.trashed;
      const unselected: Record<string, number> = {};
      for (const [sha, at] of Object.entries(ds.unselectedSince)) unselected[sha] = Date.parse(at);
      docs.set(id, {
        inManifest,
        purged: ds.purged,
        ...(ds.absentSince ? { absentSinceMs: Date.parse(ds.absentSince) } : {}),
        // Documents in the Trash keep every uploaded blob until they are purged.
        selected: this.selected.get(id) ?? new Set(ds.uploadedShas),
        unselectedSinceMs: unselected,
      });
    }
    const terminal = new Map<string, number>();
    for (const f of this.files('status')) {
      if (f.props.dev !== st.deviceId || !f.props.s) continue;
      const s = await this.body(s0, f, (v) => JobStatusSchema.safeParse(v));
      if (s && TERMINAL_JOB_STATES.has(s.state)) terminal.set(f.props.s, Date.parse(s.updatedAt));
    }
    const jobAttachments = new Map<string, string[]>();
    for (const f of this.files('job')) {
      if (!f.props.s) continue;
      const j = await this.body(s0, f, (v) => JobRequestSchema.safeParse(v));
      jobAttachments.set(f.props.s, j?.kind === 'capture' ? j.attachments.map((a) => a.sha) : []);
    }
    const acks = new Map<string, Set<string>>();
    for (const f of this.files('acks')) {
      const a = await this.body(s0, f, (v) => AcksSchema.safeParse(v));
      if (a) acks.set(f.props.dev, new Set(a.terminalJobIds));
    }
    const devices = new Map<string, { platform: 'macos' | 'android'; seenMs: number }>();
    for (const [id, v] of await this.deviceViews(s0)) {
      if (v.record && v.seenMs !== undefined) devices.set(id, { platform: v.record.platform, seenMs: v.seenMs });
    }
    const plan = planGc({
      now,
      me: st.deviceId,
      files: [...this.index.values()],
      docs,
      terminal,
      jobAttachments,
      acks,
      devices,
      claims: claimRefs(this.index.values()),
    });
    let deleted = 0;
    for (const del of plan) {
      if (this.stopped || this.role?.role !== 'primary') break;
      try {
        await s0.gcDelete(del.fileId);
      } catch (err) {
        if (codeOf(err) !== 'E_SYNC_NOT_FOUND') throw err;
      }
      const f = this.index.get(del.fileId);
      this.index.delete(del.fileId);
      this.bodies.delete(del.fileId);
      deleted++;
      if (f?.props.dev === st.deviceId && f.props.d) {
        const docId = f.props.d;
        await this.d.state.update((s) => {
          const ds = s.docs[docId];
          if (!ds) return;
          for (const [role, id] of Object.entries(ds.fileIds)) if (id === del.fileId) delete ds.fileIds[role];
          if (f.props.k === 'blob' && f.props.s) {
            ds.uploadedShas = ds.uploadedShas.filter((x) => x !== f.props.s);
            delete ds.unselectedSince[f.props.s];
          }
          if (f.props.k === 'tree') ds.treeHash = undefined;
        });
      }
    }
    const remaining = new Set<string>();
    for (const f of this.index.values()) if (f.props.dev === st.deviceId && f.props.d) remaining.add(f.props.d);
    await this.d.state.update((s) => {
      // A document that left the manifest and has nothing left in the store is forgotten.
      for (const [id, ds] of Object.entries(s.docs)) {
        const left = !manifestIds.has(id) && !ds.trashed;
        if (left && Object.keys(ds.fileIds).length === 0 && !remaining.has(id)) delete s.docs[id];
      }
      s.lastGcAt = new Date(now).toISOString();
    });
    if (deleted > 0) log.info('sync.gc', { count: deleted });
    return deleted;
  }

  // ------------------------------------------------------------------------- own writes

  private rememberOwn(store: GuardedStore, st: SyncState): void {
    const files: RemoteFile[] = [];
    for (const [role, id] of Object.entries(st.files)) {
      const props = ownProps(role, st.deviceId);
      if (props) files.push({ id, name: '', props });
    }
    for (const [docId, ds] of Object.entries(st.docs)) {
      for (const [role, id] of Object.entries(ds.fileIds)) {
        const props = ownProps(role, st.deviceId, docId);
        if (props) files.push({ id, name: '', props });
      }
    }
    store.remember(files);
  }

  private async takeId(store: GuardedStore): Promise<string> {
    if (this.idPool.length === 0) this.idPool = await store.generateIds(ID_BATCH);
    const id = this.idPool.shift();
    if (!id) throw new SyncError('E_SYNC_HTTP', 'No file id available');
    return id;
  }

  /**
   * Creates an immutable or first-time file under a preallocated id (16 §4.5 step 4). The id is
   * saved before the upload; a retry after a crash reuses it and finds the file instead of making a
   * second one. A checksum mismatch (the store deleted the bad file) retries with a fresh id.
   */
  private async ensureOwn(
    store: GuardedStore,
    key: string,
    name: string,
    props: RemoteProps,
    body: Uint8Array,
    mime: string,
    record: (s: SyncState, id: string) => void,
  ): Promise<RemoteFile> {
    for (let attempt = 0; ; attempt++) {
      let id = this.d.state.current().pendingCreates[key];
      if (!id) {
        const fresh = await this.takeId(store);
        await this.d.state.update((s) => {
          s.pendingCreates[key] = fresh;
        });
        id = fresh;
      }
      try {
        const file = await store.create(id, name, props, body, mime);
        this.index.set(file.id, file);
        this.createdThisSession.add(file.id);
        await this.d.state.update((s) => {
          delete s.pendingCreates[key];
          record(s, file.id);
        });
        return file;
      } catch (err) {
        const code = codeOf(err);
        if (code === 'E_SYNC_CHECKSUM' || code === 'E_SYNC_OWNERSHIP') {
          await this.d.state.update((s) => {
            delete s.pendingCreates[key];
          });
          if (code === 'E_SYNC_CHECKSUM' && attempt < 2) continue;
        }
        throw err;
      }
    }
  }

  /** Rewrites an own mutable file, or creates it (16 §4.2 "rewritten"); `n` moves with `touch`. */
  private async writeOwn(
    store: GuardedStore,
    key: string,
    name: string,
    props: RemoteProps,
    body: Uint8Array,
    existing: string | undefined,
    record: (s: SyncState, id: string) => void,
  ): Promise<void> {
    if (existing) {
      try {
        let file: RemoteFile;
        try {
          file = await store.update(existing, body);
        } catch (err) {
          if (codeOf(err) !== 'E_SYNC_CHECKSUM') throw err;
          file = await store.update(existing, body); // a bad revision is replaced at once
        }
        const moved: Partial<RemoteProps> = {};
        if (props.n !== undefined) moved.n = props.n;
        if (props.seen !== undefined) moved.seen = props.seen;
        if (Object.keys(moved).length > 0) await store.touch(existing, moved);
        this.index.set(existing, { ...file, props: { ...file.props, ...moved } });
        await this.d.state.update((s) => record(s, existing));
        return;
      } catch (err) {
        if (codeOf(err) !== 'E_SYNC_NOT_FOUND') throw err;
        log.info('sync.own-file-missing', { kind: props.k });
        this.index.delete(existing);
      }
    }
    await this.ensureOwn(store, key, name, props, body, props.k === 'blob' ? BLOB_MIME : JSON_MIME, record);
  }

  // ------------------------------------------------------------------------------ status

  private devicesView(me: string | undefined): SyncStatus['devices'] {
    const out: SyncStatus['devices'] = [];
    for (const f of this.files('device')) {
      const hit = f.props.dev === me ? this.ownDevice : (this.bodies.get(f.id)?.value as DeviceRecord | undefined);
      if (!hit || hit.deviceId !== f.props.dev) continue;
      const mt = f.modifiedTime ? Date.parse(f.modifiedTime) : NaN;
      const seenMs = f.props.seen !== undefined ? f.props.seen * 1000 : Number.isFinite(mt) ? mt : 0;
      out.push({
        name: hit.name,
        platform: hit.platform,
        role: hit.deviceId === me ? `${hit.role} (this Mac)` : hit.role,
        lastSeen: new Date(seenMs).toISOString(),
      });
    }
    return out;
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const s = this.status();
    const json = JSON.stringify(s);
    if (json === this.lastStatusJson) return;
    this.lastStatusJson = json;
    for (const cb of this.listeners) cb(s);
  }
}
