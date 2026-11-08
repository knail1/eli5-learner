/**
 * Single-writer guard (16 §4.1, §4.2, §4.7). Drive has no conditional write, so correctness rests on
 * every remote file having exactly one writer. This wrapper refuses, with `E_SYNC_OWNERSHIP`:
 *
 * - `create` whose `dev` is not this device;
 * - `update`, `touch` or `delete` of a file another device wrote, or of a file the guard has not seen
 *   (an unknown owner is treated as foreign);
 *
 * with two exceptions: `gcDelete`, the primary's garbage collection of the kinds 16 §4.7 lists, and
 * `wipe`, the user's "Delete cloud copy" (16 §4.7). A refused write is a bug, never a user error.
 */
import { log } from '../../security';
import type { RemoteChange, RemoteFile, RemoteProps, SyncKind, SyncStore } from '../types';
import { SyncError } from '../types';

/** Kinds the primary may delete although another device wrote them (16 §4.7). */
export const GC_FOREIGN_KINDS: ReadonlySet<SyncKind> = new Set(['job', 'att', 'cancel', 'device', 'acks', 'claim']);

export interface GuardOptions {
  deviceId: string;
  /** True while this device holds the newest claim and runs in a normal state (16 §4.5 step 6). */
  isPrimary: () => boolean;
}

export class GuardedStore implements SyncStore {
  readonly id: string;
  /** Owner and kind of every file seen through this guard, by file id. */
  private readonly known = new Map<string, { dev: string; k: SyncKind }>();

  constructor(
    private readonly inner: SyncStore,
    private readonly opts: GuardOptions,
  ) {
    this.id = inner.id;
  }

  /** Records files learned outside this guard (for example from a persisted state file). */
  remember(files: readonly RemoteFile[]): void {
    for (const f of files) this.known.set(f.id, { dev: f.props.dev, k: f.props.k });
  }

  /** The owner the guard knows for a file, if any. */
  ownerOf(fileId: string): string | undefined {
    return this.known.get(fileId)?.dev;
  }

  async list(q: { kind?: SyncKind; docId?: string }): Promise<RemoteFile[]> {
    const files = await this.inner.list(q);
    this.remember(files);
    return files;
  }

  startToken(): Promise<string> {
    return this.inner.startToken();
  }

  async changes(token: string): Promise<{ changes: RemoteChange[]; nextToken: string }> {
    const r = await this.inner.changes(token);
    for (const c of r.changes) {
      if (c.removed) this.known.delete(c.fileId);
      else if (c.file) this.remember([c.file]);
    }
    return r;
  }

  get(fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
    return this.inner.get(fileId, signal);
  }

  generateIds(n: number): Promise<string[]> {
    return this.inner.generateIds(n);
  }

  async create(id: string, name: string, props: RemoteProps, body: Uint8Array, mime: string): Promise<RemoteFile> {
    if (props.dev !== this.opts.deviceId) this.refuse('create', props.k);
    const owner = this.known.get(id);
    if (owner && owner.dev !== this.opts.deviceId) this.refuse('create', props.k);
    const file = await this.inner.create(id, name, props, body, mime);
    this.remember([file]);
    return file;
  }

  async update(fileId: string, body: Uint8Array): Promise<RemoteFile> {
    this.assertOwn(fileId, 'update');
    const file = await this.inner.update(fileId, body);
    this.remember([file]);
    return file;
  }

  async touch(fileId: string, props: Partial<RemoteProps>): Promise<void> {
    this.assertOwn(fileId, 'touch');
    // Identity keys never change after create; only the heartbeat and seq move.
    if (props.k !== undefined || props.dev !== undefined || props.d !== undefined || props.s !== undefined) {
      this.refuse('touch', this.known.get(fileId)?.k);
    }
    await this.inner.touch(fileId, props);
  }

  async delete(fileId: string): Promise<void> {
    this.assertOwn(fileId, 'delete');
    await this.inner.delete(fileId);
    this.known.delete(fileId);
  }

  /**
   * Primary-only garbage collection (16 §4.7): own files, plus the foreign kinds in
   * `GC_FOREIGN_KINDS`. The caller decides which files are due; the guard decides who may delete.
   */
  async gcDelete(fileId: string): Promise<void> {
    const owner = this.known.get(fileId);
    if (!this.opts.isPrimary() || !owner) this.refuse('gc', owner?.k);
    if (owner!.dev !== this.opts.deviceId && !GC_FOREIGN_KINDS.has(owner!.k)) this.refuse('gc', owner!.k);
    await this.inner.delete(fileId);
    this.known.delete(fileId);
  }

  /** "Delete cloud copy" (16 §4.7): deletes every file in the store, whoever wrote it. */
  async wipe(): Promise<number> {
    const files = await this.inner.list({});
    for (const f of files) {
      await this.inner.delete(f.id);
      this.known.delete(f.id);
    }
    return files.length;
  }

  private assertOwn(fileId: string, op: string): void {
    const owner = this.known.get(fileId);
    if (!owner || owner.dev !== this.opts.deviceId) this.refuse(op, owner?.k);
  }

  private refuse(op: string, kind: SyncKind | undefined): never {
    log.error('sync.guard.refused', { step: op, kind: kind ?? 'unknown', code: 'E_SYNC_OWNERSHIP' });
    throw new SyncError('E_SYNC_OWNERSHIP', `Refused ${op} of a file this device does not own`);
  }
}
