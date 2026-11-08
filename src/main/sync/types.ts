/**
 * The `SyncStore` port and the sync module's shared types (16 §4.1, §4.2, §10).
 *
 * The desktop disk is the master copy; a store is a flat mirror plus a mailbox. Every remote file has
 * exactly one writer (16 §4.2), which `stores/guard.ts` enforces. Concrete stores are registered by
 * `register.ts` (HOOK-SYNC-01) and chosen by `sync.store`.
 */
import type { Settings } from '../config';

/** `appProperties.k` values (16 §4.2 table "Kind"). */
export const SYNC_KINDS = [
  'info',
  'claim',
  'device',
  'lib',
  'tree',
  'blob',
  'att',
  'job',
  'cancel',
  'status',
  'acks',
] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

/**
 * Identity of a remote file (16 §4.2). Drive stores these as `appProperties` strings; each key plus
 * value is at most 124 bytes. Names are cosmetic.
 */
export interface RemoteProps {
  k: SyncKind;
  /** The device that wrote the file: its only writer (16 §4.2). */
  dev: string;
  /** Document id, for `tree`, `blob` and `status` files. */
  d?: string;
  /** sha256 of the content, or another id (job id). */
  s?: string;
  /** Sequence number of a manifest or tree. */
  n?: number;
  /** Heartbeat, epoch seconds (16 §4.3); written with `touch` only. */
  seen?: number;
}

export interface RemoteFile {
  id: string;
  name: string;
  props: RemoteProps;
  /** Lowercase hex sha256 of the stored bytes, when the store reports one. */
  sha256?: string;
  size?: number;
  modifiedTime?: string;
}

export interface RemoteChange {
  fileId: string;
  removed: boolean;
  /** Present when `removed` is false. */
  file?: RemoteFile;
}

/** 16 §4.1. All methods reject with `SyncError` (or `NotAvailableInEdition` from a stub). */
export interface SyncStore {
  readonly id: string;
  /** Paged internally; returns every matching file. */
  list(q: { kind?: SyncKind; docId?: string }): Promise<RemoteFile[]>;
  startToken(): Promise<string>;
  /** Follows every page. Throws `E_SYNC_TOKEN` when the token expired (HTTP 410). */
  changes(token: string): Promise<{ changes: RemoteChange[]; nextToken: string }>;
  get(fileId: string, signal?: AbortSignal): Promise<Uint8Array>;
  generateIds(n: number): Promise<string[]>;
  /** Creating an id that already exists returns that file (a retried create never duplicates). */
  create(id: string, name: string, props: RemoteProps, body: Uint8Array, mime: string): Promise<RemoteFile>;
  /** Own files only (16 §4.2). */
  update(fileId: string, body: Uint8Array): Promise<RemoteFile>;
  /** Metadata only; creates no revision. */
  touch(fileId: string, props: Partial<RemoteProps>): Promise<void>;
  /** Permanent: the app-data folder has no trash. */
  delete(fileId: string): Promise<void>;
}

/** Where a store gets its bearer token (implemented by `google/oauth.ts`). */
export interface AccessTokenSource {
  /** A valid access token; refreshes when it expires within 5 minutes. */
  accessToken(signal?: AbortSignal): Promise<string>;
  /** Forget the cached access token (after an HTTP 401). */
  invalidate(): void;
}

/** A persisted resumable upload session (16 §4.5 step 4; valid one week). */
export interface ResumableSession {
  uri: string;
  /** Epoch ms when the session was opened. */
  startedAt: number;
  /** Byte length and lowercase hex sha256 of the body; a different body never resumes this session. */
  size: number;
  sha256: string;
}

/** Persists resumable session URIs across restarts, keyed by the remote file id (`state.ts`). */
export interface ResumableSessionStore {
  get(fileId: string): ResumableSession | undefined;
  set(fileId: string, session: ResumableSession): Promise<void>;
  delete(fileId: string): Promise<void>;
}

/** What a store factory receives (HOOK-SYNC-01). Nothing here makes a request on its own. */
export interface SyncStoreContext {
  settings: Settings;
  auth: AccessTokenSource;
  sessions?: ResumableSessionStore;
  /** Test seam; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export type SyncStoreFactory = (ctx: SyncStoreContext) => SyncStore;

/** The Desktop OAuth client values (16 §3.1). Never logged, never sent over IPC. */
export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

/**
 * HOOK-SYNC-02: where the Desktop OAuth client comes from. `'user'` (public): the JSON the user
 * pasted into Settings > Sync, or the development env seed. `'none'`: sync cannot sign in. A managed
 * source supplies the client from the organization.
 */
export type SyncClientSource = 'user' | 'none' | { kind: 'managed'; load(): Promise<GoogleClient | null> };

/** HOOK-SYNC-01/02 policy slot (16 §4.1). */
export interface SyncPolicy {
  /** False hides Settings > Sync and forces sync off. */
  allowed: boolean;
  /** True keeps a document out of the upload (for example one built from organization sources). */
  excludeDoc(doc: { id: string; slug: string }): boolean;
  clientSource: SyncClientSource;
}

export const DEFAULT_SYNC_POLICY: SyncPolicy = Object.freeze({
  allowed: true,
  excludeDoc: () => false,
  clientSource: 'user',
});

/**
 * Sync error codes (16 §10). The first five are the spec's table; the rest are internal (no user
 * text of their own) and let callers tell causes apart.
 */
export type SyncErrorCode =
  | 'E_SYNC_AUTH'
  | 'E_SYNC_TOKEN'
  | 'E_SYNC_QUOTA'
  | 'E_SYNC_FORMAT'
  | 'E_SYNC_OWNERSHIP'
  /** Sync is off, not allowed by policy, or not configured; no request was made. */
  | 'E_SYNC_DISABLED'
  /** No OAuth client is configured (Settings > Sync). */
  | 'E_SYNC_NOT_CONFIGURED'
  /** The remote file does not exist (HTTP 404). */
  | 'E_SYNC_NOT_FOUND'
  /** An upload's reported sha256 did not match; the file was deleted and the push should retry. */
  | 'E_SYNC_CHECKSUM'
  /** A request failed after retries, or was refused (other HTTP status, network error). */
  | 'E_SYNC_HTTP'
  /** The caller aborted. */
  | 'E_SYNC_ABORTED';

/** User-facing text for the codes that have one (16 §10). */
export const SYNC_ERROR_TEXT: Partial<Record<SyncErrorCode, string>> = {
  E_SYNC_AUTH: 'Sign in again to keep syncing',
  E_SYNC_QUOTA: 'Your Google Drive is full',
  E_SYNC_FORMAT: 'Update ELI5 Learner to keep syncing',
  E_SYNC_NOT_CONFIGURED: 'Add your Google client in Settings > Sync',
};

export class SyncError extends Error {
  constructor(
    readonly code: SyncErrorCode,
    message?: string,
    /** HTTP status, when the error came from a response. */
    readonly status?: number,
  ) {
    super(message ?? SYNC_ERROR_TEXT[code] ?? code);
    this.name = 'SyncError';
  }
}
