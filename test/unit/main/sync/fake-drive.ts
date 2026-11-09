/**
 * In-memory fake of the Google Drive REST v3 endpoints the sync module uses (16 §12), at the fetch
 * level: files.list with appProperties queries and paging, changes with tokens and 410, generateIds,
 * multipart and resumable uploads (non-final chunks must be 256 KiB multiples), media and metadata
 * PATCH, alt=media download, delete, bearer auth, an eventual-consistency delay for listings, and
 * injected failures (403 reasons, 429, 5xx). No socket is opened.
 */
import { createHash } from 'node:crypto';

export const QUANTUM = 256 * 1024;
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  appProperties: Record<string, string>;
  parents: string[];
  body: Uint8Array;
  modifiedTime: string;
  revisions: number;
  /** List call count at creation; hidden from list until `listDelay` calls later. */
  createdAtList: number;
}

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  bodyBytes: number;
}

interface Fault {
  match: (r: RecordedRequest) => boolean;
  status: number;
  reason?: string;
  times: number;
}

interface Session {
  method: 'POST' | 'PATCH';
  fileId: string;
  metadata: Record<string, unknown>;
  total: number;
  mime: string;
  received: Uint8Array[];
  receivedBytes: number;
  done?: FakeFile;
}

export interface FakeDriveOptions {
  /** Page size the fake uses regardless of the client's request (forces paging in tests). */
  pageSize?: number;
  /** A created file stays invisible to `files.list` for this many list calls. */
  listDelay?: number;
  token?: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const driveError = (status: number, reason: string, message = reason): Response =>
  json(status, { error: { code: status, message, errors: [{ reason, message }] } });

function toBytes(body: BodyInit | null | undefined): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array();
  if (typeof body === 'string') return enc.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new Error('fake-drive: unsupported body type');
}

function headerMap(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => (out[k] = v));
  return out;
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  return Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength).indexOf(Buffer.from(needle), from);
}

/** Parses a two-part multipart/related body: JSON metadata, then media. */
export function parseMultipart(
  body: Uint8Array,
  contentType: string,
): { metadata: Record<string, unknown>; media: Uint8Array; mediaType: string } {
  const m = /boundary=([^;]+)/.exec(contentType);
  if (!m || !contentType.startsWith('multipart/related')) throw new Error('not multipart/related');
  const delim = enc.encode(`--${m[1]}`);
  const p1 = indexOf(body, delim);
  const p2 = indexOf(body, delim, p1 + delim.length);
  const end = indexOf(body, enc.encode(`\r\n--${m[1]}--`), p2 + delim.length);
  if (p1 !== 0 || p2 < 0 || end < 0) throw new Error('bad multipart framing');
  const part = (a: number, b: number): { headers: string; content: Uint8Array } => {
    const chunk = body.subarray(a + delim.length + 2, b);
    const sep = indexOf(chunk, enc.encode('\r\n\r\n'));
    return { headers: dec.decode(chunk.subarray(0, sep)), content: chunk.subarray(sep + 4) };
  };
  const meta = part(p1, p2 - 2);
  const media = part(p2, end);
  if (!/content-type: application\/json/i.test(meta.headers)) throw new Error('first part is not JSON');
  const mediaType = /content-type: ([^\r\n]+)/i.exec(media.headers)?.[1] ?? '';
  return {
    metadata: JSON.parse(dec.decode(meta.content)) as Record<string, unknown>,
    media: new Uint8Array(media.content),
    mediaType,
  };
}

/** Parses Drive's `appProperties has { key='k' and value='v' }` clauses. */
function parseQuery(q: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /appProperties has \{ key='((?:[^'\\]|\\.)*)' and value='((?:[^'\\]|\\.)*)' \}/g;
  for (const m of q.matchAll(re)) out[m[1]!.replace(/\\(.)/g, '$1')] = m[2]!.replace(/\\(.)/g, '$1');
  const rest = q
    .replace(re, '')
    .replace(/trashed = false/, '')
    .replace(/\band\b/g, '')
    .trim();
  if (rest) throw new Error(`fake-drive: unsupported query "${rest}"`);
  return out;
}

export class FakeDrive {
  readonly files = new Map<string, FakeFile>();
  readonly requests: RecordedRequest[] = [];
  readonly validTokens = new Set<string>();
  /** Change log: index i holds change number i + 1. */
  private readonly log: Array<{ fileId: string; removed: boolean }> = [];
  private readonly issuedIds = new Set<string>();
  private readonly sessions = new Map<string, Session>();
  private readonly faults: Fault[] = [];
  private idSeq = 0;
  private sessionSeq = 0;
  private listCalls = 0;
  private minToken = 1;
  private clock = Date.parse('2026-11-01T00:00:00Z');
  /** When set, created files report a wrong sha256Checksum (once per call). */
  corruptNextChecksum = false;

  constructor(private readonly opts: FakeDriveOptions = {}) {
    this.validTokens.add(opts.token ?? 'tok-1');
  }

  /** The fetch function to hand to the client. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    const headers = headerMap(init?.headers);
    const body = toBytes(init?.body as BodyInit | null | undefined);
    const req: RecordedRequest = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url: url.href,
      path: url.pathname,
      headers,
      bodyBytes: body.byteLength,
    };
    this.requests.push(req);
    if (url.origin !== 'https://www.googleapis.com') throw new Error(`fake-drive: unexpected host ${url.origin}`);
    const auth = headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || !this.validTokens.has(auth.slice(7))) return driveError(401, 'authError');
    const fault = this.faults.find((f) => f.times > 0 && f.match(req));
    if (fault) {
      fault.times--;
      return fault.reason ? driveError(fault.status, fault.reason) : new Response('fault', { status: fault.status });
    }
    return this.route(req, url, body, headers);
  };

  /** Inject `times` failures for requests that match. */
  fail(
    match: Partial<Pick<RecordedRequest, 'method' | 'path'>> | ((r: RecordedRequest) => boolean),
    status: number,
    reason?: string,
    times = 1,
  ): void {
    const fn =
      typeof match === 'function'
        ? match
        : (r: RecordedRequest) =>
            (!match.method || r.method === match.method) && (!match.path || r.path === match.path);
    this.faults.push({ match: fn, status, reason, times });
  }

  /** Removes every injected failure. */
  clearFaults(): void {
    this.faults.length = 0;
  }

  /** Expire every change token issued so far (the next `changes` with one gets 410). */
  expireTokens(): void {
    this.minToken = this.log.length + 1;
  }

  /** Seeds a file as if another device wrote it (no request recorded). */
  seed(f: {
    id?: string;
    name: string;
    appProperties: Record<string, string>;
    body?: string | Uint8Array;
    mimeType?: string;
  }): FakeFile {
    const id = f.id ?? this.newId();
    const file: FakeFile = {
      id,
      name: f.name,
      mimeType: f.mimeType ?? 'application/json',
      appProperties: { ...f.appProperties },
      parents: ['appDataFolder'],
      body: typeof f.body === 'string' ? enc.encode(f.body) : (f.body ?? new Uint8Array()),
      modifiedTime: this.tick(),
      revisions: 1,
      createdAtList: -Infinity,
    };
    this.files.set(id, file);
    this.log.push({ fileId: id, removed: false });
    return file;
  }

  requestsTo(method: string, pathPrefix: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix));
  }

  private newId(): string {
    return `fid${(++this.idSeq).toString(36).padStart(6, '0')}`;
  }

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private resource(f: FakeFile, checksum = sha(f.body)): Record<string, unknown> {
    return {
      id: f.id,
      name: f.name,
      appProperties: { ...f.appProperties },
      sha256Checksum: checksum,
      size: String(f.body.byteLength),
      modifiedTime: f.modifiedTime,
    };
  }

  private route(req: RecordedRequest, url: URL, body: Uint8Array, headers: Record<string, string>): Response {
    const p = url.pathname;
    const q = url.searchParams;
    if (req.method === 'GET' && p === '/drive/v3/files') return this.list(q);
    if (req.method === 'GET' && p === '/drive/v3/changes/startPageToken')
      return json(200, { startPageToken: String(this.log.length + 1) });
    if (req.method === 'GET' && p === '/drive/v3/changes') return this.changes(q);
    if (req.method === 'GET' && p === '/drive/v3/files/generateIds') return this.generateIds(q);
    const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (fileMatch) {
      const f = this.files.get(decodeURIComponent(fileMatch[1]!));
      if (!f) return driveError(404, 'notFound');
      if (req.method === 'GET') {
        return q.get('alt') === 'media' ? new Response(f.body.slice(), { status: 200 }) : json(200, this.resource(f));
      }
      if (req.method === 'DELETE') {
        this.files.delete(f.id);
        this.log.push({ fileId: f.id, removed: true });
        return new Response(null, { status: 204 });
      }
      if (req.method === 'PATCH') {
        const patch = JSON.parse(dec.decode(body)) as { appProperties?: Record<string, string | null> };
        for (const [k, v] of Object.entries(patch.appProperties ?? {})) {
          if (v === null) delete f.appProperties[k];
          else f.appProperties[k] = v;
        }
        f.modifiedTime = this.tick();
        this.log.push({ fileId: f.id, removed: false });
        return json(200, { id: f.id });
      }
    }
    if (p === '/upload/drive/v3/files' && req.method === 'POST') {
      const type = q.get('uploadType');
      if (type === 'multipart') {
        const { metadata, media, mediaType } = parseMultipart(body, headers['content-type'] ?? '');
        return this.createFile(metadata, media, mediaType);
      }
      if (type === 'resumable') return this.openSession('POST', '', body, headers);
    }
    const uploadFile = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (uploadFile && req.method === 'PATCH') {
      const f = this.files.get(decodeURIComponent(uploadFile[1]!));
      if (!f) return driveError(404, 'notFound');
      if (q.get('uploadType') === 'media') return this.replaceBody(f, body);
      if (q.get('uploadType') === 'resumable') return this.openSession('PATCH', f.id, body, headers);
    }
    if (req.method === 'PUT' && q.get('upload_id')) return this.putChunk(q.get('upload_id')!, body, headers);
    return driveError(400, 'badRequest', `fake-drive: no route for ${req.method} ${p}`);
  }

  private list(q: URLSearchParams): Response {
    if (q.get('spaces') !== 'appDataFolder') return driveError(400, 'invalidSpace');
    this.listCalls++;
    const filter = parseQuery(q.get('q') ?? '');
    const visible = [...this.files.values()].filter(
      (f) =>
        this.listCalls - f.createdAtList > (this.opts.listDelay ?? 0) &&
        Object.entries(filter).every(([k, v]) => f.appProperties[k] === v),
    );
    const size = this.opts.pageSize ?? Number(q.get('pageSize') ?? 100);
    const start = Number(q.get('pageToken') ?? 0);
    const page = visible.slice(start, start + size);
    return json(200, {
      files: page.map((f) => this.resource(f)),
      ...(start + size < visible.length ? { nextPageToken: String(start + size) } : {}),
    });
  }

  private changes(q: URLSearchParams): Response {
    const token = Number(q.get('pageToken'));
    if (!Number.isInteger(token) || token < 1 || token > this.log.length + 1)
      return driveError(400, 'invalid', 'Invalid page token');
    if (token < this.minToken) return driveError(410, 'deleted', 'Page token expired');
    if (q.get('spaces') !== 'appDataFolder' || q.get('includeRemoved') !== 'true') return driveError(400, 'badRequest');
    const size = this.opts.pageSize ?? Number(q.get('pageSize') ?? 100);
    const slice = this.log.slice(token - 1, token - 1 + size);
    const next = token + slice.length;
    const changes = slice.map((c) => {
      const f = this.files.get(c.fileId);
      return c.removed || !f
        ? { fileId: c.fileId, removed: true }
        : { fileId: c.fileId, removed: false, file: this.resource(f) };
    });
    return json(
      200,
      next > this.log.length ? { changes, newStartPageToken: String(next) } : { changes, nextPageToken: String(next) },
    );
  }

  private generateIds(q: URLSearchParams): Response {
    if (q.get('space') !== 'appDataFolder') return driveError(400, 'invalidSpace');
    const n = Number(q.get('count'));
    const ids = Array.from({ length: n }, () => this.newId());
    for (const id of ids) this.issuedIds.add(id);
    return json(200, { ids, space: 'appDataFolder', kind: 'drive#generatedIds' });
  }

  private createFile(metadata: Record<string, unknown>, media: Uint8Array, mediaType: string): Response {
    const id = metadata.id as string | undefined;
    if (JSON.stringify(metadata.parents) !== '["appDataFolder"]') return driveError(400, 'invalidParent');
    if (id && this.files.has(id)) return driveError(409, 'fileIdInUse', 'A file already exists with the provided ID');
    if (id && !this.issuedIds.has(id)) return driveError(400, 'fileIdNotUsable');
    const file: FakeFile = {
      id: id ?? this.newId(),
      name: String(metadata.name ?? ''),
      mimeType: String(metadata.mimeType ?? mediaType),
      appProperties: { ...((metadata.appProperties as Record<string, string>) ?? {}) },
      parents: ['appDataFolder'],
      body: media.slice(),
      modifiedTime: this.tick(),
      revisions: 1,
      createdAtList: this.listCalls,
    };
    this.files.set(file.id, file);
    this.log.push({ fileId: file.id, removed: false });
    const checksum = this.corruptNextChecksum ? '0'.repeat(64) : undefined;
    this.corruptNextChecksum = false;
    return json(200, this.resource(file, checksum));
  }

  private replaceBody(f: FakeFile, body: Uint8Array): Response {
    f.body = body.slice();
    f.revisions++;
    f.modifiedTime = this.tick();
    this.log.push({ fileId: f.id, removed: false });
    return json(200, this.resource(f));
  }

  private openSession(
    method: 'POST' | 'PATCH',
    fileId: string,
    body: Uint8Array,
    headers: Record<string, string>,
  ): Response {
    const total = Number(headers['x-upload-content-length']);
    if (!Number.isInteger(total) || total < 0) return driveError(400, 'badContentLength');
    const id = `s${++this.sessionSeq}`;
    const metadata = body.byteLength ? (JSON.parse(dec.decode(body)) as Record<string, unknown>) : {};
    this.sessions.set(id, {
      method,
      fileId,
      metadata,
      total,
      mime: headers['x-upload-content-type'] ?? '',
      received: [],
      receivedBytes: 0,
    });
    return new Response(null, {
      status: 200,
      headers: { location: `${UPLOAD}/files?uploadType=resumable&upload_id=${id}` },
    });
  }

  /** Forget a session (as Drive does after a week). */
  expireSessions(): void {
    this.sessions.clear();
  }

  private putChunk(sessionId: string, body: Uint8Array, headers: Record<string, string>): Response {
    const s = this.sessions.get(sessionId);
    if (!s) return driveError(404, 'notFound', 'Upload session not found');
    const range = headers['content-range'] ?? '';
    const status = (): Response =>
      new Response(null, {
        status: 308,
        headers: s.receivedBytes > 0 ? { range: `bytes=0-${s.receivedBytes - 1}` } : {},
      });
    if (/^bytes \*\/\d+$/.test(range)) {
      if (s.done) return json(200, this.resource(s.done));
      return status();
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (!m) return driveError(400, 'badContentRange');
    const [a, b, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (total !== s.total || a !== s.receivedBytes || b - a + 1 !== body.byteLength)
      return driveError(400, 'badContentRange');
    const final = b + 1 === total;
    if (!final && body.byteLength % QUANTUM !== 0)
      return driveError(400, 'badChunkSize', 'Chunk is not a multiple of 256 KiB');
    s.received.push(body.slice());
    s.receivedBytes += body.byteLength;
    if (!final) return status();
    const all = Buffer.concat(s.received.map((c) => Buffer.from(c)));
    let res: Response;
    if (s.method === 'POST') {
      res = this.createFile(s.metadata, new Uint8Array(all), s.mime);
    } else {
      const f = this.files.get(s.fileId);
      if (!f) return driveError(404, 'notFound');
      res = this.replaceBody(f, new Uint8Array(all));
    }
    if (res.ok) s.done = this.files.get((s.metadata.id as string | undefined) ?? s.fileId) ?? undefined;
    return res;
  }
}

/** A token source for the fake: a fixed token, with counters. */
export function fakeAuth(token = 'tok-1'): {
  accessToken: () => Promise<string>;
  invalidate: () => void;
  invalidations: number;
  current: string;
} {
  const a = {
    current: token,
    invalidations: 0,
    accessToken: async () => a.current,
    invalidate: () => {
      a.invalidations++;
    },
  };
  return a;
}
