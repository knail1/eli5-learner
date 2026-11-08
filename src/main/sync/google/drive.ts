/**
 * Fetch-based Google Drive REST v3 client for the hidden app-data folder (16 §4.1, §4.5, §4.8).
 *
 * No Google client library: a handful of endpoints, bearer auth from an `AccessTokenSource`,
 * exponential backoff with full jitter (403 rate limits, 429, 5xx, network errors; capped at 64 s),
 * one token refresh on 401, multipart uploads up to 5 MiB and resumable uploads in 8 MiB chunks
 * above that. Logs carry HTTP codes and counts only, never names, bodies or tokens (16 §9).
 */
import { createHash, randomBytes } from 'node:crypto';
import { log } from '../../security';
import type { AccessTokenSource, ResumableSessionStore } from '../types';
import { SyncError } from '../types';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
/** The fields every file response carries (16 §4.8). */
export const FILE_FIELDS = 'id,name,appProperties,sha256Checksum,size,modifiedTime';

/** Bodies up to this size use one multipart request; larger ones a resumable session (16 §4.5). */
export const MULTIPART_MAX_BYTES = 5 * 1024 * 1024;
/** Resumable chunk size: 8 MiB, a multiple of the required 256 KiB. */
export const RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024;
export const RESUMABLE_QUANTUM = 256 * 1024;
/** Resumable session URIs are valid for one week; older ones are discarded. */
export const RESUMABLE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 64_000;
export const MAX_ATTEMPTS = 7;
const MAX_PAGES = 10_000;
/** Per-attempt time limit for a request and its response body; a timeout counts as a network error. */
export const REQUEST_TIMEOUT_MS = 60_000;
/** Per-attempt time limit for one resumable chunk (8 MiB on a slow uplink). */
export const CHUNK_TIMEOUT_MS = 5 * 60_000;

/** The raw Drive file resource, as returned with `FILE_FIELDS`. */
export interface DriveFile {
  id: string;
  name?: string;
  appProperties?: Record<string, string>;
  sha256Checksum?: string;
  size?: string;
  modifiedTime?: string;
}

export interface DriveChange {
  fileId: string;
  removed?: boolean;
  file?: DriveFile;
}

export interface DriveClientOptions {
  auth: AccessTokenSource;
  fetch?: typeof fetch;
  sessions?: ResumableSessionStore;
  /** Test seams. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  maxAttempts?: number;
  /** Per-attempt request timeout (default `REQUEST_TIMEOUT_MS`). */
  timeoutMs?: number;
}

interface Req {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  signal?: AbortSignal;
  /** Statuses returned to the caller instead of being treated as errors. */
  accept?: readonly number[];
  /** Overrides the client's per-attempt timeout. */
  timeoutMs?: number;
}

const RETRY_403_REASONS = new Set(['userRateLimitExceeded', 'rateLimitExceeded']);
const QUOTA_REASONS = new Set(['storageQuotaExceeded', 'quotaExceeded']);

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new SyncError('E_SYNC_ABORTED', 'Aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new SyncError('E_SYNC_ABORTED', 'Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Escapes a value for a Drive query string literal. */
export function quoteQueryValue(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Builds the `files.list` query: not trashed, plus `appProperties has` filters. */
export function buildListQuery(props: Record<string, string>): string {
  const parts = ['trashed = false'];
  for (const [k, v] of Object.entries(props)) {
    parts.push(`appProperties has { key=${quoteQueryValue(k)} and value=${quoteQueryValue(v)} }`);
  }
  return parts.join(' and ');
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

function includesBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  return Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength).includes(Buffer.from(needle));
}

/** A `multipart/related` body: JSON metadata, then the media (Drive "multipart upload"). */
export function multipartBody(
  metadata: unknown,
  body: Uint8Array,
  mime: string,
): { contentType: string; bytes: Uint8Array } {
  const enc = new TextEncoder();
  let boundary = '';
  do boundary = `eli5-${randomBytes(16).toString('hex')}`;
  while (includesBytes(body, enc.encode(boundary)));
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  return { contentType: `multipart/related; boundary=${boundary}`, bytes: concat([head, body, tail]) };
}

/** Parses a resumable `Range: bytes=0-N` header into the next offset (N + 1), or 0 when absent. */
export function nextOffsetFromRange(range: string | null): number {
  const m = range ? /^bytes=0-(\d+)$/.exec(range.trim()) : null;
  return m ? Number(m[1]) + 1 : 0;
}

async function errorReason(res: Response): Promise<{ reason?: string; message?: string }> {
  try {
    const j = (await res.json()) as { error?: { errors?: Array<{ reason?: string }>; message?: string } | string };
    if (typeof j.error === 'string') return { reason: j.error };
    return { reason: j.error?.errors?.[0]?.reason, message: j.error?.message };
  } catch {
    return {};
  }
}

export class DriveClient {
  private readonly auth: AccessTokenSource;
  private readonly fetchFn: typeof fetch;
  private readonly sessions: ResumableSessionStore | undefined;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;

  constructor(opts: DriveClientOptions) {
    this.auth = opts.auth;
    this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sessions = opts.sessions;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  // ------------------------------------------------------------------------------- transport

  /** Full-jitter delay for a retry attempt (0-based), capped at 64 s. */
  backoffMs(attempt: number): number {
    return Math.floor(this.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt));
  }

  /**
   * One authorized request with retries. Returns the response for 2xx and `accept`ed statuses;
   * maps everything else to a `SyncError`.
   */
  private async send(req: Req): Promise<Response> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      if (req.signal?.aborted) throw new SyncError('E_SYNC_ABORTED', 'Aborted');
      const token = await this.auth.accessToken(req.signal);
      // A hung connection must not stall sync forever: each attempt (and its body) has a deadline.
      const deadline = AbortSignal.timeout(req.timeoutMs ?? this.timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, deadline]) : deadline;
      let res: Response;
      try {
        res = await this.fetchFn(req.url, {
          method: req.method,
          headers: { authorization: `Bearer ${token}`, ...req.headers },
          ...(req.body !== undefined ? { body: req.body as BodyInit } : {}),
          signal,
          // A resumable "308 Resume Incomplete" has no Location and must reach us as-is.
          redirect: 'manual',
        });
      } catch (err) {
        if (req.signal?.aborted) throw new SyncError('E_SYNC_ABORTED', 'Aborted');
        if (attempt + 1 >= this.maxAttempts) throw new SyncError('E_SYNC_HTTP', 'Network error');
        log.warn('sync.drive.retry', { kind: 'network', attempt: attempt + 1, errorKind: errName(err) });
        await this.sleep(this.backoffMs(attempt), req.signal);
        continue;
      }
      if (res.ok || req.accept?.includes(res.status)) return res;

      const status = res.status;
      if (status === 401) {
        await res.body?.cancel().catch(() => {});
        this.auth.invalidate();
        if (refreshed) throw new SyncError('E_SYNC_AUTH', undefined, 401);
        refreshed = true;
        attempt--; // a token refresh is not a backoff attempt
        continue;
      }
      const { reason } = await errorReason(res);
      const retryable =
        status === 429 || status >= 500 || (status === 403 && reason !== undefined && RETRY_403_REASONS.has(reason));
      if (retryable && attempt + 1 < this.maxAttempts) {
        log.warn('sync.drive.retry', { status, attempt: attempt + 1 });
        await this.sleep(this.backoffMs(attempt), req.signal);
        continue;
      }
      if (reason !== undefined && QUOTA_REASONS.has(reason)) throw new SyncError('E_SYNC_QUOTA', undefined, status);
      if (status === 404) throw new SyncError('E_SYNC_NOT_FOUND', 'Remote file not found', status);
      if (status === 410) throw new SyncError('E_SYNC_TOKEN', 'Change token expired', status);
      log.warn('sync.drive.failed', { status, code: reason ?? 'unknown' });
      throw new SyncError('E_SYNC_HTTP', `Drive request failed (${status})`, status);
    }
  }

  private async json<T>(req: Req): Promise<T> {
    return readJson<T>(await this.send(req), req.signal);
  }

  // --------------------------------------------------------------------------------- reading

  /** `files.list` in the app-data folder, following every page. */
  async list(props: Record<string, string> = {}, signal?: AbortSignal): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const u = new URL(`${DRIVE_API}/files`);
      u.searchParams.set('spaces', 'appDataFolder');
      u.searchParams.set('pageSize', '1000');
      u.searchParams.set('q', buildListQuery(props));
      u.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`);
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const r = await this.json<{ files?: DriveFile[]; nextPageToken?: string }>({
        method: 'GET',
        url: u.href,
        signal,
      });
      out.push(...(r.files ?? []));
      if (!r.nextPageToken) return out;
      pageToken = r.nextPageToken;
    }
    throw new SyncError('E_SYNC_HTTP', 'Too many list pages');
  }

  async startPageToken(signal?: AbortSignal): Promise<string> {
    const r = await this.json<{ startPageToken?: string }>({
      method: 'GET',
      url: `${DRIVE_API}/changes/startPageToken`,
      signal,
    });
    if (!r.startPageToken) throw new SyncError('E_SYNC_HTTP', 'No start page token');
    return r.startPageToken;
  }

  /** `changes.list` to the end; throws `E_SYNC_TOKEN` on 410 or an invalid token. */
  async changes(token: string, signal?: AbortSignal): Promise<{ changes: DriveChange[]; newStartPageToken: string }> {
    const out: DriveChange[] = [];
    let pageToken = token;
    for (let page = 0; page < MAX_PAGES; page++) {
      const u = new URL(`${DRIVE_API}/changes`);
      u.searchParams.set('pageToken', pageToken);
      u.searchParams.set('spaces', 'appDataFolder');
      u.searchParams.set('includeRemoved', 'true');
      u.searchParams.set('pageSize', '1000');
      u.searchParams.set('fields', `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`);
      let r: { changes?: DriveChange[]; nextPageToken?: string; newStartPageToken?: string };
      try {
        r = await this.json({ method: 'GET', url: u.href, signal });
      } catch (err) {
        // Drive answers an unknown or malformed page token with 400 "invalid".
        if (err instanceof SyncError && err.status === 400)
          throw new SyncError('E_SYNC_TOKEN', 'Invalid change token', 400);
        throw err;
      }
      out.push(...(r.changes ?? []));
      if (r.newStartPageToken) return { changes: out, newStartPageToken: r.newStartPageToken };
      if (!r.nextPageToken) throw new SyncError('E_SYNC_HTTP', 'Change list ended without a token');
      pageToken = r.nextPageToken;
    }
    throw new SyncError('E_SYNC_HTTP', 'Too many change pages');
  }

  async metadata(fileId: string, signal?: AbortSignal): Promise<DriveFile> {
    return this.json<DriveFile>({
      method: 'GET',
      url: `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}`,
      signal,
    });
  }

  async download(fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await this.send({
      method: 'GET',
      url: `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`,
      signal,
    });
    try {
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      throw bodyError(err, signal);
    }
  }

  async generateIds(count: number, signal?: AbortSignal): Promise<string[]> {
    if (!Number.isInteger(count) || count < 1 || count > 1000) throw new RangeError('generateIds: 1..1000');
    const u = new URL(`${DRIVE_API}/files/generateIds`);
    u.searchParams.set('count', String(count));
    u.searchParams.set('space', 'appDataFolder');
    u.searchParams.set('type', 'files');
    const r = await this.json<{ ids?: string[] }>({ method: 'GET', url: u.href, signal });
    if (!r.ids || r.ids.length !== count) throw new SyncError('E_SYNC_HTTP', 'generateIds returned the wrong count');
    return r.ids;
  }

  // --------------------------------------------------------------------------------- writing

  /**
   * Creates a file in the app-data folder under a preallocated id. A retry after a lost response
   * finds the id taken (409) and returns the existing file instead of duplicating it.
   */
  async create(
    meta: { id: string; name: string; appProperties: Record<string, string>; mimeType: string },
    body: Uint8Array,
    signal?: AbortSignal,
  ): Promise<DriveFile> {
    const metadata = { ...meta, parents: ['appDataFolder'] };
    try {
      if (body.byteLength <= MULTIPART_MAX_BYTES) {
        const mp = multipartBody(metadata, body, meta.mimeType);
        return await this.json<DriveFile>({
          method: 'POST',
          url: `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`,
          headers: { 'content-type': mp.contentType },
          body: mp.bytes,
          signal,
        });
      }
      return await this.resumable('POST', `${DRIVE_UPLOAD_API}/files`, meta.id, metadata, body, meta.mimeType, signal);
    } catch (err) {
      if (err instanceof SyncError && err.status === 409) return this.metadata(meta.id, signal);
      throw err;
    }
  }

  /** Replaces a file's content (a new revision). */
  async updateContent(fileId: string, body: Uint8Array, mime: string, signal?: AbortSignal): Promise<DriveFile> {
    const base = `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}`;
    if (body.byteLength <= MULTIPART_MAX_BYTES) {
      return this.json<DriveFile>({
        method: 'PATCH',
        url: `${base}?uploadType=media&fields=${encodeURIComponent(FILE_FIELDS)}`,
        headers: { 'content-type': mime },
        body,
        signal,
      });
    }
    return this.resumable('PATCH', base, fileId, {}, body, mime, signal);
  }

  /** Metadata-only update of `appProperties` (no revision). */
  async patchProperties(fileId: string, appProperties: Record<string, string>, signal?: AbortSignal): Promise<void> {
    const res = await this.send({
      method: 'PATCH',
      url: `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id`,
      headers: { 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ appProperties }),
      signal,
    });
    await res.body?.cancel().catch(() => {});
  }

  /** Permanent delete; a file already gone counts as deleted. */
  async delete(fileId: string, signal?: AbortSignal): Promise<void> {
    try {
      const res = await this.send({
        method: 'DELETE',
        url: `${DRIVE_API}/files/${encodeURIComponent(fileId)}`,
        signal,
      });
      await res.body?.cancel().catch(() => {});
    } catch (err) {
      if (err instanceof SyncError && err.code === 'E_SYNC_NOT_FOUND') return;
      throw err;
    }
  }

  // ------------------------------------------------------------------------------- resumable

  /**
   * Resumable upload (16 §4.5 step 4): 8 MiB chunks, the session URI persisted under the file id so a
   * restart resumes instead of starting over. A session older than a week, or one Drive no longer
   * knows (404/410), starts again.
   */
  private async resumable(
    method: 'POST' | 'PATCH',
    base: string,
    key: string,
    metadata: object,
    body: Uint8Array,
    mime: string,
    signal?: AbortSignal,
  ): Promise<DriveFile> {
    const total = body.byteLength;
    const sha256 = createHash('sha256').update(body).digest('hex');
    let session = this.sessions?.get(key);
    // Resume only the same bytes to the same Drive endpoint within a week; anything else starts over
    // (a later update of the same file must never be spliced onto an older body).
    if (
      session &&
      (this.now() - session.startedAt > RESUMABLE_SESSION_MS ||
        session.size !== total ||
        session.sha256 !== sha256 ||
        !session.uri.startsWith(`${DRIVE_UPLOAD_API}/`))
    ) {
      await this.sessions?.delete(key);
      session = undefined;
    }
    let offset = 0;
    if (session) {
      const probe = await this.probeSession(session.uri, total, signal);
      if (probe.done) {
        await this.sessions?.delete(key);
        return probe.done;
      }
      if (probe.offset === undefined) {
        await this.sessions?.delete(key);
        session = undefined;
      } else {
        offset = probe.offset;
      }
    }
    if (!session) {
      const res = await this.send({
        method,
        url: `${base}?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`,
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': mime,
          'x-upload-content-length': String(total),
        },
        body: JSON.stringify(metadata),
        signal,
      });
      await res.body?.cancel().catch(() => {});
      const uri = res.headers.get('location');
      if (!uri || !uri.startsWith(`${DRIVE_UPLOAD_API}/`)) throw new SyncError('E_SYNC_HTTP', 'No resumable session');
      session = { uri, startedAt: this.now(), size: total, sha256 };
      await this.sessions?.set(key, session);
    }

    while (offset < total) {
      const end = Math.min(offset + RESUMABLE_CHUNK_BYTES, total);
      const res = await this.send({
        method: 'PUT',
        url: session.uri,
        headers: { 'content-range': `bytes ${offset}-${end - 1}/${total}` },
        body: body.subarray(offset, end),
        signal,
        accept: [308],
        timeoutMs: Math.max(this.timeoutMs, CHUNK_TIMEOUT_MS),
      });
      if (res.status === 308) {
        await res.body?.cancel().catch(() => {});
        const next = nextOffsetFromRange(res.headers.get('range'));
        // Drive must accept whole 256 KiB quanta; anything else is a broken session.
        if (next < offset || (next < total && next % RESUMABLE_QUANTUM !== 0)) {
          throw new SyncError('E_SYNC_HTTP', 'Resumable upload lost its place');
        }
        offset = next;
        continue;
      }
      await this.sessions?.delete(key);
      return readJson<DriveFile>(res, signal);
    }
    // Every byte was acknowledged but no final response arrived: ask the session for the file.
    const probe = await this.probeSession(session.uri, total, signal);
    await this.sessions?.delete(key);
    if (probe.done) return probe.done;
    throw new SyncError('E_SYNC_HTTP', 'Resumable upload did not complete');
  }

  /** `PUT bytes * /total` status check: done, resume at an offset, or unknown (start over). */
  private async probeSession(
    uri: string,
    total: number,
    signal?: AbortSignal,
  ): Promise<{ done?: DriveFile; offset?: number }> {
    try {
      const res = await this.send({
        method: 'PUT',
        url: uri,
        headers: { 'content-range': `bytes */${total}` },
        signal,
        accept: [308],
      });
      if (res.status === 308) {
        await res.body?.cancel().catch(() => {});
        return { offset: nextOffsetFromRange(res.headers.get('range')) };
      }
      return { done: await readJson<DriveFile>(res, signal) };
    } catch (err) {
      // A session Drive no longer knows (404, 410) or refuses (other 4xx): start over.
      if (
        err instanceof SyncError &&
        err.code !== 'E_SYNC_AUTH' &&
        err.status !== undefined &&
        err.status >= 400 &&
        err.status < 500
      ) {
        return {};
      }
      throw err;
    }
  }
}

/** Reads a JSON body; a timeout or broken body becomes a `SyncError`. */
async function readJson<T>(res: Response, signal?: AbortSignal): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw bodyError(err, signal);
  }
}

function bodyError(err: unknown, signal?: AbortSignal): SyncError {
  if (signal?.aborted) return new SyncError('E_SYNC_ABORTED', 'Aborted');
  log.warn('sync.drive.body-failed', { errorKind: errName(err) });
  return new SyncError('E_SYNC_HTTP', 'Drive response could not be read');
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}
