/**
 * Test builds only (13 §6.1): an in-memory `SyncStore` that the e2e suite registers in place of the
 * Drive app-data store (ELI5_SYNC_FAKE=1), so a whole Settings > Sync flow runs with no network.
 * Same contract as the real store (16 §4.1): flat files with identity properties, a change feed,
 * preallocated ids and idempotent creates. Nothing in a packaged build imports this file.
 */
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../stores/drive-appdata';
import type { RemoteChange, RemoteFile, RemoteProps, SyncKind, SyncStore } from '../types';
import { SyncError } from '../types';

interface Entry {
  file: RemoteFile;
  body: Uint8Array;
}

export class MemorySyncStore implements SyncStore {
  readonly id: string;
  private readonly files = new Map<string, Entry>();
  /** Change number i + 1 is at index i. */
  private readonly log: string[] = [];
  private readonly issued = new Set<string>();

  constructor(id = 'google-drive-appdata') {
    this.id = id;
  }

  /** Every stored file, for assertions (no body). */
  snapshot(): RemoteFile[] {
    return [...this.files.values()].map((e) => structuredClone(e.file));
  }

  /** The stored bytes of a file as text, for assertions. */
  text(fileId: string): string | undefined {
    const e = this.files.get(fileId);
    return e ? new TextDecoder().decode(e.body) : undefined;
  }

  async list(q: { kind?: SyncKind; docId?: string }): Promise<RemoteFile[]> {
    return this.snapshot().filter((f) => (!q.kind || f.props.k === q.kind) && (!q.docId || f.props.d === q.docId));
  }

  async startToken(): Promise<string> {
    return String(this.log.length + 1);
  }

  async changes(token: string): Promise<{ changes: RemoteChange[]; nextToken: string }> {
    const from = Number(token);
    if (!Number.isInteger(from) || from < 1 || from > this.log.length + 1) throw new SyncError('E_SYNC_TOKEN');
    const ids = [...new Set(this.log.slice(from - 1))];
    const changes = ids.map((fileId): RemoteChange => {
      const e = this.files.get(fileId);
      return e ? { fileId, removed: false, file: structuredClone(e.file) } : { fileId, removed: true };
    });
    return { changes, nextToken: String(this.log.length + 1) };
  }

  async get(fileId: string): Promise<Uint8Array> {
    const e = this.files.get(fileId);
    if (!e) throw new SyncError('E_SYNC_NOT_FOUND', 'Remote file not found', 404);
    return e.body.slice();
  }

  async generateIds(n: number): Promise<string[]> {
    const out: string[] = [];
    while (out.length < n) {
      const id = `m${randomBytes(12).toString('hex')}`;
      if (this.issued.has(id)) continue;
      this.issued.add(id);
      out.push(id);
    }
    return out;
  }

  async create(id: string, name: string, props: RemoteProps, body: Uint8Array, _mime: string): Promise<RemoteFile> {
    const held = this.files.get(id);
    if (held) {
      if (held.file.props.k === props.k && held.file.props.dev === props.dev) return structuredClone(held.file);
      throw new SyncError('E_SYNC_HTTP', 'Id already in use', 409);
    }
    if (!this.issued.has(id)) throw new SyncError('E_SYNC_HTTP', 'Id was not generated', 400);
    return this.put(id, { id, name, props: { ...props } }, body);
  }

  async update(fileId: string, body: Uint8Array): Promise<RemoteFile> {
    const e = this.files.get(fileId);
    if (!e) throw new SyncError('E_SYNC_NOT_FOUND', 'Remote file not found', 404);
    return this.put(fileId, e.file, body);
  }

  async touch(fileId: string, props: Partial<RemoteProps>): Promise<void> {
    const e = this.files.get(fileId);
    if (!e) throw new SyncError('E_SYNC_NOT_FOUND', 'Remote file not found', 404);
    e.file = { ...e.file, props: { ...e.file.props, ...props }, modifiedTime: new Date().toISOString() };
    this.log.push(fileId);
  }

  async delete(fileId: string): Promise<void> {
    if (!this.files.delete(fileId)) return;
    this.log.push(fileId);
  }

  private put(id: string, file: RemoteFile, body: Uint8Array): RemoteFile {
    const copy = body.slice();
    const next: RemoteFile = {
      ...file,
      sha256: sha256Hex(copy),
      size: copy.byteLength,
      modifiedTime: new Date().toISOString(),
    };
    this.files.set(id, { file: next, body: copy });
    this.log.push(id);
    return structuredClone(next);
  }
}
