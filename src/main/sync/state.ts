/**
 * Local sync state (16 §4.5 step 1): `<userData>/sync/state.json`, written atomically with mode 0600.
 * Sync state never goes into `meta.json`, so a push never changes a document's `updatedAt`.
 *
 * The device id is a UUIDv4 minted on first use; it is an identity, not a credential (16 §4.2).
 * The account email is a display hint. No token or client value is ever stored here (they live in
 * the Keychain, 16 §3.2).
 */
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeJsonAtomic } from '../library';
import { log } from '../security';
import { DEVICE_ID_RE } from './protocol';
import type { ResumableSession, ResumableSessionStore } from './types';

export const SYNC_STATE_FILE = 'state.json';
export const SYNC_STATE_VERSION = 1;

const DocStateSchema = z
  .object({
    treeSeq: z.number().int().min(0).default(0),
    uploadedShas: z.array(z.string()).default([]),
    /** Remote file ids by local role (for example `tree`, or `blob:<sha>`). */
    fileIds: z.record(z.string(), z.string()).default({}),
    /** Root version id: tells a re-minted id (same tree, new docId) from a new document (09 §7). */
    rootId: z.string().max(64).optional(),
    /** The old docId this one replaces in the manifest (16 §4.4). */
    replaces: z.string().max(64).optional(),
    /** The live version as last pushed: id, sha, size and in-depth headings (16 §4.4). */
    current: z
      .object({
        versionId: z.string().max(64),
        sha: z.string().regex(/^[0-9a-f]{64}$/),
        sizeBytes: z.number().int().min(0),
        headings: z.array(z.string().max(400)).max(200),
      })
      .strict()
      .optional(),
    /** Content hash of the last uploaded tree (without seq): unchanged trees are not rewritten. */
    treeHash: z.string().max(64).optional(),
    /** In the desktop Trash at the last push. */
    trashed: z.boolean().default(false),
    /** Purged from the Trash: its remote files are collected at once (16 §4.7). */
    purged: z.boolean().default(false),
    /** When the document left the manifest (16 §4.7: collected after 30 days). */
    absentSince: z.string().optional(),
    /** sha -> when it stopped being selected by `sync.history` (collected after 7 days). */
    unselectedSince: z.record(z.string(), z.string()).default({}),
  })
  .strict();

const SessionSchema = z
  .object({
    uri: z.string().url(),
    startedAt: z.number().int().min(0),
    size: z.number().int().min(0),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const SyncStateSchema = z
  .object({
    v: z.literal(SYNC_STATE_VERSION).default(SYNC_STATE_VERSION),
    deviceId: z.string().regex(DEVICE_ID_RE),
    /** Account email shown in Settings > Sync; a hint, not a boundary (16 §3.2 step 7). */
    account: z.string().max(320).optional(),
    primary: z.boolean().default(false),
    startToken: z.string().max(512).optional(),
    manifestSeq: z.number().int().min(0).default(0),
    lastSyncAt: z.string().optional(),
    docs: z.record(z.string(), DocStateSchema).default({}),
    /**
     * Create key (`<role>` or `doc:<docId>:<role>`) -> preallocated id, persisted before the upload
     * so a retried create never duplicates (16 §4.5 step 4).
     */
    pendingCreates: z.record(z.string(), z.string()).default({}),
    /** Remote file id -> open resumable session. */
    resumable: z.record(z.string(), SessionSchema).default({}),
    /** This device's own single files by role (`info`, `claim`, `device`, `lib`) -> remote id. */
    files: z.record(z.string(), z.string()).default({}),
    /** Content hashes of the last manifest and device record written (unchanged ones are not rewritten). */
    manifestHash: z.string().max(64).optional(),
    deviceHash: z.string().max(64).optional(),
    /** Last garbage collection run (16 §4.7). */
    lastGcAt: z.string().optional(),
    /** Owned by the inbox (S10); kept opaque here. */
    inbox: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type SyncState = z.infer<typeof SyncStateSchema>;
export type SyncDocState = z.infer<typeof DocStateSchema>;

export function freshState(deviceId: string = randomUUID()): SyncState {
  return SyncStateSchema.parse({ deviceId });
}

export interface SyncStateStoreOptions {
  /** `<userData>/sync`; created with mode 0700. */
  dir: string;
  mintDeviceId?: () => string;
}

/** Loads, caches and atomically saves the state file. Writes are serialized. */
export class SyncStateStore implements ResumableSessionStore {
  private state: SyncState | undefined;
  private loading: Promise<SyncState> | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: SyncStateStoreOptions) {}

  get file(): string {
    return path.join(this.opts.dir, SYNC_STATE_FILE);
  }

  /**
   * Reads the file once. A missing file starts fresh; a corrupt one is set aside as
   * `state.json.corrupt-<ms>` and starts fresh with the old device id when it can still be read.
   */
  load(): Promise<SyncState> {
    if (this.state) return Promise.resolve(this.state);
    this.loading ??= this.read().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async read(): Promise<SyncState> {
    let raw: string | undefined;
    try {
      raw = await fsp.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (raw === undefined) {
      this.state = freshState(this.mint());
      await this.persist();
      return this.state;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const parsed = SyncStateSchema.safeParse(json);
    if (parsed.success) {
      this.state = parsed.data;
      return this.state;
    }
    const oldId = (json as { deviceId?: unknown } | undefined)?.deviceId;
    log.warn('sync.state.corrupt', { step: 'load' });
    await fsp.rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {});
    this.state = freshState(typeof oldId === 'string' && DEVICE_ID_RE.test(oldId) ? oldId : this.mint());
    await this.persist();
    return this.state;
  }

  /** The cached state; `load()` must have run. */
  current(): SyncState {
    if (!this.state) throw new Error('Sync state not loaded');
    return this.state;
  }

  /** Applies `fn` to a copy and saves it; the cache changes only after the write succeeded. */
  update(fn: (s: SyncState) => SyncState | void): Promise<SyncState> {
    const run = this.chain.then(async () => {
      const base = await this.load();
      const draft = structuredClone(base);
      const next = SyncStateSchema.parse(fn(draft) ?? draft);
      await this.write(next);
      this.state = next;
      return next;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  // ResumableSessionStore (16 §4.5 step 4)
  get(fileId: string): ResumableSession | undefined {
    return this.state?.resumable[fileId];
  }
  async set(fileId: string, session: ResumableSession): Promise<void> {
    await this.update((s) => {
      s.resumable[fileId] = session;
    });
  }
  async delete(fileId: string): Promise<void> {
    if (!this.state?.resumable[fileId]) return;
    await this.update((s) => {
      delete s.resumable[fileId];
    });
  }

  private mint(): string {
    const id = (this.opts.mintDeviceId ?? randomUUID)();
    if (!DEVICE_ID_RE.test(id)) throw new Error('Device id must be a lowercase UUIDv4');
    return id;
  }

  private persist(): Promise<void> {
    return this.write(this.current());
  }

  private async write(s: SyncState): Promise<void> {
    await fsp.mkdir(this.opts.dir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(this.file, s);
  }
}
