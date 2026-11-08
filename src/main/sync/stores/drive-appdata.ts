/**
 * `google-drive-appdata` (16 §4.1, §4.2): the shipped `SyncStore`. Every file lives flat in the
 * hidden app-data folder (`drive.appdata` scope); identity comes from `appProperties`, never names.
 */
import { createHash } from 'node:crypto';
import { DriveClient, type DriveChange, type DriveFile } from '../google/drive';
import type { RemoteChange, RemoteFile, RemoteProps, SyncKind, SyncStore, SyncStoreContext } from '../types';
import { SYNC_KINDS, SyncError } from '../types';

export const DRIVE_APPDATA_STORE_ID = 'google-drive-appdata';

/** Drive's limit: each appProperties key plus value is at most 124 bytes (UTF-8). */
export const PROP_MAX_BYTES = 124;
const PROP_KEYS = ['k', 'dev', 'd', 's', 'n', 'seen'] as const;
const KINDS: ReadonlySet<string> = new Set(SYNC_KINDS);
/** Hex digest. */
const SHA_RE = /^[0-9a-f]{64}$/;

const utf8 = (s: string): number => Buffer.byteLength(s, 'utf8');

/** RemoteProps -> Drive appProperties strings; rejects oversized or malformed values. */
export function encodeProps(props: Partial<RemoteProps>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PROP_KEYS) {
    const v = props[key];
    if (v === undefined) continue;
    if (key === 'k' && !KINDS.has(String(v))) throw new SyncError('E_SYNC_HTTP', 'Unknown sync kind');
    if ((key === 'n' || key === 'seen') && !(Number.isSafeInteger(v) && (v as number) >= 0)) {
      throw new SyncError('E_SYNC_HTTP', `Property ${key} must be a non-negative integer`);
    }
    const s = String(v);
    if (s.length === 0 || utf8(key) + utf8(s) > PROP_MAX_BYTES) {
      throw new SyncError('E_SYNC_HTTP', `Property ${key} is empty or longer than ${PROP_MAX_BYTES} bytes`);
    }
    out[key] = s;
  }
  for (const key of Object.keys(props)) {
    if (!(PROP_KEYS as readonly string[]).includes(key)) throw new SyncError('E_SYNC_HTTP', `Unknown property ${key}`);
  }
  return out;
}

/** Drive appProperties -> RemoteProps, or null for a file that is not one of ours. */
export function decodeProps(ap: Record<string, string> | undefined): RemoteProps | null {
  if (!ap || !KINDS.has(ap.k ?? '') || !ap.dev) return null;
  const props: RemoteProps = { k: ap.k as SyncKind, dev: ap.dev };
  if (ap.d) props.d = ap.d;
  if (ap.s) props.s = ap.s;
  for (const key of ['n', 'seen'] as const) {
    if (ap[key] === undefined) continue;
    const n = Number(ap[key]);
    if (/^\d{1,16}$/.test(ap[key]) && Number.isSafeInteger(n)) props[key] = n;
  }
  return props;
}

/** Drive file -> RemoteFile, or null when it carries no valid sync identity (ignored by readers). */
export function toRemoteFile(f: DriveFile): RemoteFile | null {
  const props = decodeProps(f.appProperties);
  if (!props || !f.id) return null;
  const out: RemoteFile = { id: f.id, name: f.name ?? '', props };
  if (f.sha256Checksum && SHA_RE.test(f.sha256Checksum.toLowerCase())) out.sha256 = f.sha256Checksum.toLowerCase();
  if (f.size !== undefined && /^\d+$/.test(f.size)) out.size = Number(f.size);
  if (f.modifiedTime) out.modifiedTime = f.modifiedTime;
  return out;
}

function toRemoteChange(c: DriveChange): RemoteChange | null {
  if (!c.fileId) return null;
  if (c.removed || !c.file) return { fileId: c.fileId, removed: true };
  const file = toRemoteFile(c.file);
  return file ? { fileId: c.fileId, removed: false, file } : null;
}

/** Lowercase hex sha256 of `body`. */
export function sha256Hex(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

/** Identity keys (kind, writer, document, content id) match; `n` and `seen` may move. */
function sameIdentity(a: RemoteProps, b: RemoteProps): boolean {
  return a.k === b.k && a.dev === b.dev && a.d === b.d && a.s === b.s;
}

/** Only JSON files are rewritten in place (16 §4.2: lib, tree, device, status, acks). */
const UPDATE_MIME = 'application/json';

export class DriveAppDataStore implements SyncStore {
  readonly id = DRIVE_APPDATA_STORE_ID;

  constructor(private readonly drive: DriveClient) {}

  static fromContext(ctx: SyncStoreContext): DriveAppDataStore {
    return new DriveAppDataStore(
      new DriveClient({
        auth: ctx.auth,
        ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
        ...(ctx.sessions ? { sessions: ctx.sessions } : {}),
      }),
    );
  }

  async list(q: { kind?: SyncKind; docId?: string }): Promise<RemoteFile[]> {
    const filter: Record<string, string> = {};
    if (q.kind) filter.k = q.kind;
    if (q.docId) filter.d = q.docId;
    encodeProps(filter as Partial<RemoteProps>); // validates the query values
    const files = await this.drive.list(filter);
    return files.map(toRemoteFile).filter((f): f is RemoteFile => f !== null);
  }

  startToken(): Promise<string> {
    return this.drive.startPageToken();
  }

  async changes(token: string): Promise<{ changes: RemoteChange[]; nextToken: string }> {
    const r = await this.drive.changes(token);
    return {
      changes: r.changes.map(toRemoteChange).filter((c): c is RemoteChange => c !== null),
      nextToken: r.newStartPageToken,
    };
  }

  get(fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
    return this.drive.download(fileId, signal);
  }

  generateIds(n: number): Promise<string[]> {
    return this.drive.generateIds(n);
  }

  /**
   * Creates under the preallocated id, then checks the sha256 Drive reports (16 §4.5 step 4). A
   * mismatch deletes the file and throws `E_SYNC_CHECKSUM`; the push retries with a fresh id.
   */
  async create(id: string, name: string, props: RemoteProps, body: Uint8Array, mime: string): Promise<RemoteFile> {
    const appProperties = encodeProps(props);
    const created = await this.drive.create({ id, name, appProperties, mimeType: mime }, body);
    // A retried create returns whatever already holds the id. If that is not the file we meant to
    // write (another writer or another kind), it is not ours to verify or delete (16 §4.2).
    const file = toRemoteFile(created);
    if (!file || !sameIdentity(file.props, props)) {
      throw new SyncError('E_SYNC_OWNERSHIP', 'That file id already holds a different file');
    }
    await this.verify(created, body);
    return file;
  }

  async update(fileId: string, body: Uint8Array): Promise<RemoteFile> {
    const updated = await this.drive.updateContent(fileId, body, UPDATE_MIME);
    const expected = sha256Hex(body);
    if (updated.sha256Checksum && updated.sha256Checksum.toLowerCase() !== expected) {
      // Mutable files are rewritten in place; a bad revision is replaced on the next push.
      throw new SyncError('E_SYNC_CHECKSUM', 'Uploaded content does not match');
    }
    const file = toRemoteFile(updated);
    if (!file) throw new SyncError('E_SYNC_HTTP', 'Updated file lacks its properties');
    return file;
  }

  async touch(fileId: string, props: Partial<RemoteProps>): Promise<void> {
    await this.drive.patchProperties(fileId, encodeProps(props));
  }

  delete(fileId: string): Promise<void> {
    return this.drive.delete(fileId);
  }

  private async verify(created: DriveFile, body: Uint8Array): Promise<void> {
    if (!created.sha256Checksum) return; // older responses may omit it; the reader checks shas too
    if (created.sha256Checksum.toLowerCase() === sha256Hex(body)) return;
    await this.drive.delete(created.id).catch(() => {});
    throw new SyncError('E_SYNC_CHECKSUM', 'Uploaded content does not match');
  }
}
