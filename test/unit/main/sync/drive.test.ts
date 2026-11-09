import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BACKOFF_CAP_MS,
  DriveClient,
  MULTIPART_MAX_BYTES,
  RESUMABLE_CHUNK_BYTES,
  RESUMABLE_SESSION_MS,
  buildListQuery,
  multipartBody,
  nextOffsetFromRange,
  type DriveClientOptions,
} from '../../../../src/main/sync/google/drive';
import type { ResumableSession, ResumableSessionStore } from '../../../../src/main/sync';
import { FakeDrive, QUANTUM, fakeAuth, parseMultipart } from './fake-drive';

const enc = new TextEncoder();

function memorySessions(): ResumableSessionStore & { map: Map<string, ResumableSession> } {
  const map = new Map<string, ResumableSession>();
  return {
    map,
    get: (k) => map.get(k),
    set: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
  };
}

function setup(opts: Partial<DriveClientOptions> = {}, fakeOpts?: ConstructorParameters<typeof FakeDrive>[0]) {
  const drive = new FakeDrive(fakeOpts);
  const sleeps: number[] = [];
  const auth = fakeAuth();
  const client = new DriveClient({
    auth,
    fetch: drive.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 1,
    ...opts,
  });
  return { drive, client, sleeps, auth };
}

const meta = (id: string, k = 'blob') => ({
  id,
  name: `${k}-${id}.bin`,
  appProperties: { k, dev: 'dev-a' },
  mimeType: 'application/octet-stream',
});

const bytes = (n: number, seed = 7): Uint8Array => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
};

describe('helpers', () => {
  it('escapes query literals and builds appProperties filters', () => {
    expect(buildListQuery({})).toBe('trashed = false');
    expect(buildListQuery({ k: "it's", d: 'a\\b' })).toBe(
      "trashed = false and appProperties has { key='k' and value='it\\'s' } and appProperties has { key='d' and value='a\\\\b' }",
    );
  });

  it('frames a multipart/related body the fake (and Drive) can parse', () => {
    const body = bytes(1000);
    const mp = multipartBody({ name: 'x', parents: ['appDataFolder'] }, body, 'application/gzip');
    const parsed = parseMultipart(mp.bytes, mp.contentType);
    expect(parsed.metadata).toEqual({ name: 'x', parents: ['appDataFolder'] });
    expect(parsed.mediaType).toBe('application/gzip');
    expect(Buffer.from(parsed.media).equals(Buffer.from(body))).toBe(true);
  });

  it('reads the resumable Range header', () => {
    expect(nextOffsetFromRange(null)).toBe(0);
    expect(nextOffsetFromRange('bytes=0-262143')).toBe(QUANTUM);
    expect(nextOffsetFromRange('garbage')).toBe(0);
  });
});

describe('DriveClient reads', () => {
  it('lists the app-data folder with a narrow fields mask, following pages and filtering by appProperties', async () => {
    const { drive, client } = setup({}, { pageSize: 2 });
    for (let i = 0; i < 5; i++)
      drive.seed({ name: `t${i}`, appProperties: { k: 'tree', dev: 'd1', d: `doc${i % 2}` } });
    drive.seed({ name: 'b', appProperties: { k: 'blob', dev: 'd1' } });
    const trees = await client.list({ k: 'tree' });
    expect(trees).toHaveLength(5);
    expect(drive.requestsTo('GET', '/drive/v3/files')).toHaveLength(3);
    const first = new URL(drive.requests[0]!.url);
    expect(first.searchParams.get('spaces')).toBe('appDataFolder');
    expect(first.searchParams.get('fields')).toBe(
      'nextPageToken,files(id,name,appProperties,sha256Checksum,size,modifiedTime)',
    );
    expect(await client.list({ k: 'tree', d: 'doc1' })).toHaveLength(2);
    expect(await client.list()).toHaveLength(6);
  });

  it('pages through changes to newStartPageToken and maps 410 and invalid tokens to E_SYNC_TOKEN', async () => {
    const { drive, client } = setup({}, { pageSize: 2 });
    const start = await client.startPageToken();
    for (let i = 0; i < 5; i++) drive.seed({ name: `j${i}`, appProperties: { k: 'job', dev: 'phone' } });
    const r = await client.changes(start);
    expect(r.changes.map((c) => c.file?.name)).toEqual(['j0', 'j1', 'j2', 'j3', 'j4']);
    const feed = drive.requests.filter((q) => q.path === '/drive/v3/changes');
    expect(feed).toHaveLength(3);
    const u = new URL(feed[0]!.url);
    expect(u.searchParams.get('includeRemoved')).toBe('true');
    expect(u.searchParams.get('fields')).toContain('newStartPageToken');

    const again = await client.changes(r.newStartPageToken);
    expect(again.changes).toEqual([]);
    drive.expireTokens();
    await expect(client.changes(start)).rejects.toMatchObject({ code: 'E_SYNC_TOKEN', status: 410 });
    await expect(client.changes('not-a-token')).rejects.toMatchObject({ code: 'E_SYNC_TOKEN' });
  });

  it('reports removals in the change feed', async () => {
    const { drive, client } = setup();
    const f = drive.seed({ name: 'x', appProperties: { k: 'job', dev: 'phone' } });
    const start = await client.startPageToken();
    await client.delete(f.id);
    expect((await client.changes(start)).changes).toEqual([{ fileId: f.id, removed: true }]);
  });

  it('generates ids in the app-data space and downloads media', async () => {
    const { drive, client } = setup();
    const ids = await client.generateIds(3);
    expect(new Set(ids).size).toBe(3);
    expect(new URL(drive.requests[0]!.url).searchParams.get('space')).toBe('appDataFolder');
    await expect(client.generateIds(0)).rejects.toThrow(RangeError);
    const f = drive.seed({ name: 'b', appProperties: { k: 'blob', dev: 'd' }, body: 'hello' });
    expect(new TextDecoder().decode(await client.download(f.id))).toBe('hello');
    await expect(client.download('missing')).rejects.toMatchObject({ code: 'E_SYNC_NOT_FOUND' });
  });
});

describe('DriveClient uploads', () => {
  it('creates small files with one multipart request under the preallocated id', async () => {
    const { drive, client } = setup();
    const [id] = await client.generateIds(1);
    const f = await client.create(meta(id!), enc.encode('{"a":1}'));
    expect(f).toMatchObject({ id, appProperties: { k: 'blob', dev: 'dev-a' }, size: '7' });
    const post = drive.requestsTo('POST', '/upload/drive/v3/files')[0]!;
    expect(new URL(post.url).searchParams.get('uploadType')).toBe('multipart');
    expect(post.headers['content-type']).toMatch(/^multipart\/related; boundary=/);
    expect(drive.files.get(id!)!.parents).toEqual(['appDataFolder']);
  });

  it('a retried create (id already used) returns the existing file instead of duplicating', async () => {
    const { drive, client } = setup();
    const [id] = await client.generateIds(1);
    await client.create(meta(id!), enc.encode('one'));
    const again = await client.create(meta(id!), enc.encode('one'));
    expect(again.id).toBe(id);
    expect(drive.files.size).toBe(1);
  });

  it('uses a resumable session in 8 MiB chunks above 5 MiB', async () => {
    const sessions = memorySessions();
    const { drive, client } = setup({ sessions });
    const [id] = await client.generateIds(1);
    const body = bytes(RESUMABLE_CHUNK_BYTES * 2 + 1234);
    const f = await client.create(meta(id!), body);
    expect(f.id).toBe(id);
    const puts = drive.requestsTo('PUT', '/upload/drive/v3/files');
    expect(puts.map((p) => p.bodyBytes)).toEqual([RESUMABLE_CHUNK_BYTES, RESUMABLE_CHUNK_BYTES, 1234]);
    expect(puts.map((p) => p.headers['content-range'])).toEqual([
      `bytes 0-${RESUMABLE_CHUNK_BYTES - 1}/${body.byteLength}`,
      `bytes ${RESUMABLE_CHUNK_BYTES}-${2 * RESUMABLE_CHUNK_BYTES - 1}/${body.byteLength}`,
      `bytes ${2 * RESUMABLE_CHUNK_BYTES}-${body.byteLength - 1}/${body.byteLength}`,
    ]);
    expect(Buffer.from(drive.files.get(id!)!.body).equals(Buffer.from(body))).toBe(true);
    expect(sessions.map.size).toBe(0);
    expect(MULTIPART_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it('resumes a persisted session after a failure instead of re-sending acknowledged chunks', async () => {
    const sessions = memorySessions();
    const { drive, client } = setup({ sessions, maxAttempts: 1 });
    const [id] = await client.generateIds(1);
    const body = bytes(RESUMABLE_CHUNK_BYTES + 3 * QUANTUM + 5);
    let puts = 0;
    drive.fail((r) => r.method === 'PUT' && ++puts === 2, 503);
    await expect(client.create(meta(id!), body)).rejects.toMatchObject({ code: 'E_SYNC_HTTP' });
    expect(sessions.map.has(id!)).toBe(true);

    // A new client (app restart) with the same persisted sessions.
    const resumed = new DriveClient({ auth: fakeAuth(), fetch: drive.fetch, sessions, sleep: async () => {} });
    const before = drive.requests.length;
    await resumed.create(meta(id!), body);
    const after = drive.requests.slice(before).filter((r) => r.method === 'PUT');
    expect(after[0]!.headers['content-range']).toBe(`bytes */${body.byteLength}`); // status probe
    expect(after.slice(1).map((r) => r.bodyBytes)).toEqual([3 * QUANTUM + 5]);
    expect(drive.requestsTo('POST', '/upload/drive/v3/files')).toHaveLength(1); // no second session
    expect(Buffer.from(drive.files.get(id!)!.body).equals(Buffer.from(body))).toBe(true);
    expect(sessions.map.size).toBe(0);
  });

  it('starts over when the session expired at Drive (404) or is older than a week', async () => {
    const sessions = memorySessions();
    let now = 1_000_000;
    const { drive, client } = setup({ sessions, maxAttempts: 1, now: () => now });
    const [a, b] = await client.generateIds(2);
    const body = bytes(MULTIPART_MAX_BYTES + 10);
    drive.fail({ method: 'PUT' }, 503);
    await expect(client.create(meta(a!), body)).rejects.toBeTruthy();
    drive.expireSessions();
    await client.create(meta(a!), body);
    expect(drive.requestsTo('POST', '/upload/drive/v3/files')).toHaveLength(2);

    drive.fail({ method: 'PUT' }, 503);
    await expect(client.create(meta(b!), body)).rejects.toBeTruthy();
    now += RESUMABLE_SESSION_MS + 1;
    const probesBefore = drive.requests.filter((r) => r.headers['content-range']?.startsWith('bytes */')).length;
    await client.create(meta(b!), body);
    const probesAfter = drive.requests.filter((r) => r.headers['content-range']?.startsWith('bytes */')).length;
    expect(probesAfter).toBe(probesBefore); // a week-old session is not even probed
    expect(drive.files.has(b!)).toBe(true);
  });

  it('never resumes a session with different bytes or a foreign URI', async () => {
    const sessions = memorySessions();
    const { drive, client } = setup({ sessions, maxAttempts: 1 });
    const f = drive.seed({ name: 'lib', appProperties: { k: 'lib', dev: 'dev-a' }, body: '{}' });
    const first = bytes(MULTIPART_MAX_BYTES + QUANTUM + 3, 1);
    let puts = 0;
    drive.fail((r) => r.method === 'PUT' && ++puts === 1, 503);
    await expect(client.updateContent(f.id, first, 'application/json')).rejects.toBeTruthy();
    expect(sessions.map.get(f.id)?.size).toBe(first.byteLength);

    // A later, different body for the same file must start a fresh session, not splice onto the old one.
    const second = bytes(MULTIPART_MAX_BYTES + QUANTUM + 3, 2);
    const probes = () => drive.requests.filter((r) => r.headers['content-range']?.startsWith('bytes */')).length;
    const before = probes();
    await client.updateContent(f.id, second, 'application/json');
    expect(probes()).toBe(before);
    expect(Buffer.from(drive.files.get(f.id)!.body).equals(Buffer.from(second))).toBe(true);

    // A tampered state file cannot send the bearer token anywhere but Drive's upload endpoint.
    const third = bytes(MULTIPART_MAX_BYTES + 9, 3);
    await sessions.set(f.id, {
      uri: 'https://example.invalid/upload',
      startedAt: Date.now(),
      size: third.byteLength,
      sha256: createHash('sha256').update(third).digest('hex'),
    });
    await client.updateContent(f.id, third, 'application/json');
    expect(drive.requests.some((r) => r.url.startsWith('https://example.invalid'))).toBe(false);
    expect(sessions.map.size).toBe(0);
  });

  it('updates content as a new revision and touches metadata without one', async () => {
    const { drive, client } = setup();
    const f = drive.seed({ name: 'tree', appProperties: { k: 'tree', dev: 'dev-a', n: '1' }, body: '{}' });
    const up = await client.updateContent(f.id, enc.encode('{"seq":2}'), 'application/json');
    expect(up.sha256Checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(drive.files.get(f.id)!.revisions).toBe(2);
    await client.patchProperties(f.id, { seen: '1700000000' });
    expect(drive.files.get(f.id)!.revisions).toBe(2);
    expect(drive.files.get(f.id)!.appProperties.seen).toBe('1700000000');
    const big = bytes(MULTIPART_MAX_BYTES + 1);
    await client.updateContent(f.id, big, 'application/json');
    expect(drive.files.get(f.id)!.body.byteLength).toBe(big.byteLength);
  });

  it('treats deleting a missing file as done', async () => {
    const { client } = setup();
    await expect(client.delete('gone')).resolves.toBeUndefined();
  });
});

describe('DriveClient errors and backoff (16 §4.5 step 5)', () => {
  it('retries 429, 5xx and 403 rate limits with full-jitter exponential backoff', async () => {
    const { drive, client, sleeps } = setup();
    drive.fail({ path: '/drive/v3/files' }, 429, undefined, 1);
    drive.fail({ path: '/drive/v3/files' }, 503, undefined, 1);
    drive.fail({ path: '/drive/v3/files' }, 403, 'userRateLimitExceeded', 1);
    drive.fail({ path: '/drive/v3/files' }, 403, 'rateLimitExceeded', 1);
    expect(await client.list()).toEqual([]);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
  });

  it('caps the delay at 64 s and draws it uniformly below the cap', () => {
    const { client } = setup({ random: () => 0.999999 });
    expect(client.backoffMs(20)).toBeLessThan(BACKOFF_CAP_MS);
    expect(client.backoffMs(20)).toBe(BACKOFF_CAP_MS - 1);
    expect(setup({ random: () => 0 }).client.backoffMs(3)).toBe(0);
  });

  it('gives up after the attempt limit with E_SYNC_HTTP', async () => {
    const { drive, client, sleeps } = setup({ maxAttempts: 3 });
    drive.fail({ path: '/drive/v3/files' }, 500, undefined, 10);
    await expect(client.list()).rejects.toMatchObject({ code: 'E_SYNC_HTTP', status: 500 });
    expect(sleeps).toHaveLength(2);
  });

  it('retries network errors, and does not retry other 4xx', async () => {
    const drive = new FakeDrive();
    let first = true;
    const flaky: typeof fetch = async (i, init) => {
      if (first) {
        first = false;
        throw new TypeError('fetch failed');
      }
      return drive.fetch(i, init);
    };
    const client = new DriveClient({ auth: fakeAuth(), fetch: flaky, sleep: async () => {}, random: () => 0 });
    expect(await client.list()).toEqual([]);
    drive.fail({ path: '/drive/v3/files' }, 400, 'badRequest', 5);
    await expect(client.list()).rejects.toMatchObject({ code: 'E_SYNC_HTTP', status: 400 });
  });

  it('maps a full Drive to E_SYNC_QUOTA without retrying', async () => {
    const { drive, client, sleeps } = setup();
    drive.fail({ method: 'POST' }, 403, 'storageQuotaExceeded');
    const [id] = await client.generateIds(1);
    await expect(client.create(meta(id!), enc.encode('x'))).rejects.toMatchObject({
      code: 'E_SYNC_QUOTA',
      message: 'Your Google Drive is full',
    });
    expect(sleeps).toEqual([]);
  });

  it('maps a disabled Drive API to E_SYNC_API_DISABLED without retrying (audit round 3)', async () => {
    const { drive, client, sleeps } = setup();
    drive.fail({ path: '/drive/v3/files' }, 403, 'accessNotConfigured', 5);
    await expect(client.list()).rejects.toMatchObject({
      code: 'E_SYNC_API_DISABLED',
      status: 403,
      message: 'Turn on the Google Drive API in your Google Cloud project, then Sync now',
    });
    expect(sleeps).toEqual([]);
    // The newer error shape names it only in details[].reason.
    const body = {
      error: {
        code: 403,
        message: 'Google Drive API has not been used in this project before or it is disabled.',
        status: 'PERMISSION_DENIED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }],
      },
    };
    const only = new DriveClient({
      auth: fakeAuth(),
      fetch: async () => new Response(JSON.stringify(body), { status: 403 }),
      sleep: async () => {},
    });
    await expect(only.list()).rejects.toMatchObject({ code: 'E_SYNC_API_DISABLED' });
  });

  it('on 401 drops the access token and retries once, then fails with E_SYNC_AUTH', async () => {
    const { drive, client, auth } = setup();
    drive.validTokens.clear();
    drive.validTokens.add('tok-2');
    auth.invalidate = () => {
      auth.invalidations++;
      auth.current = 'tok-2';
    };
    expect(await client.list()).toEqual([]);
    expect(auth.invalidations).toBe(1);

    drive.validTokens.clear();
    await expect(client.list()).rejects.toMatchObject({
      code: 'E_SYNC_AUTH',
      message: 'Sign in again to keep syncing',
    });
    expect(auth.invalidations).toBe(3);
  });

  it('stops on abort', async () => {
    const { client } = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(client.list({}, ac.signal)).rejects.toMatchObject({ code: 'E_SYNC_ABORTED' });
  });
});
