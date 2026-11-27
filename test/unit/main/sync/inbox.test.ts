/**
 * The desktop phone inbox (16 §5.3, §12 "inbox tests") over the in-memory store and the real guard,
 * ledger and sniffer: schema fuzzing, sha mismatch, type sniffing, size caps, replay, rate limits
 * per account, cancel before and after running, busy checkout, kinds not accepted, status writes
 * with preallocated ids, and the engine running the inbox on a pass. Synthetic content only (13 §4).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobSnapshot } from '../../../../src/preload/contract';
import { sniffFile } from '../../../../src/main/sources';
import {
  ATTACHMENT_WAIT_MS,
  CHECKOUT_RETRY_MS,
  FOCUS_PHRASES,
  GuardedStore,
  INBOX_RATE_PER_HOUR,
  INBOX_TEXT,
  InboxLedger,
  LEDGER_KEEP_MS,
  SHARED_TEXT_FILE,
  SyncEngine,
  SyncInbox,
  SyncError,
  SyncStateStore,
  checkoutOutcomeOf,
  composeClarifying,
  reportFromSnapshot,
  stagedName,
  statusBody,
  type CheckoutOutcome,
  type EngineTimers,
  type InboxCapture,
  type RemoteFile,
  type SyncKind,
} from '../../../../src/main/sync';
import { JobRequestSchema, JobStatusSchema, type JobKind, type JobStatus } from '../../../../src/main/sync/protocol';
import { MemorySyncStore } from '../../../../src/main/sync/testing';
import { MemLibrary } from './mem-library';

const DESK = '0b7c5e2a-1f3d-4c4e-9a8b-2d6f0e1c3b5a';
const PHONE = '2d9e7a4c-3b5f-4e6a-9c0d-4f8b2a3e5d7c';
const PHONE_2 = '3e0f8b5d-4c6a-4f7b-8d1e-5a9c3b4f6e8d';
const OTHER_MAC = '4f1a9c6e-5d7b-4a8c-9e2f-6b0d4c5a7f9e';
const DOC = '3f2b8c1e-5a4d-4e7f-9b6a-0c1d2e3f4a5b';
const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FIXTURES = path.resolve(import.meta.dirname, '../../../contracts/sync/fixtures');
const enc = new TextEncoder();
const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

let jobSeq = 0;
/** A fresh UUIDv7-shaped job id; later calls sort after earlier ones. */
const newJobId = (): string => `019a3c5e-7d2f-7${(++jobSeq).toString(16).padStart(3, '0')}-9c3d-4e5f6a7b8c9d`;

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2,
]);
const PDF = enc.encode('%PDF-1.4\n% synthetic test file\n1 0 obj\n<<>>\nendobj\n');

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

interface Opts {
  enabled?: boolean;
  accepts?: JobKind[];
  checkout?: CheckoutOutcome[];
  cancel?: boolean;
  dir?: string;
  mem?: MemorySyncStore;
  knownJob?: (id: string) => JobSnapshot | undefined;
}

async function harness(o: Opts = {}) {
  const dir = o.dir ?? (await mkdtemp(path.join(tmpdir(), 'eli5-sync-inbox-')));
  if (!o.dir) dirs.push(dir);
  const mem = o.mem ?? new MemorySyncStore();
  const store = new GuardedStore(mem, { deviceId: DESK, isPrimary: () => true });
  const clock = { t: T0 };
  const ctl = { enabled: o.enabled ?? true, cancel: o.cancel ?? true, checkout: [...(o.checkout ?? [])] };
  const events: string[] = [];
  const enqueued: InboxCapture[] = [];
  const cancel = vi.fn(async (_id: string) => ctl.cancel);
  const checkout = vi.fn(async (_doc: string, _ver: string) => ctl.checkout.shift() ?? ({ kind: 'done' } as const));
  const kick = vi.fn();
  const ledger = new InboxLedger({ dir: path.join(dir, 'sync') });
  const inbox = new SyncInbox({
    ledger,
    dir: path.join(dir, 'sync', 'inbox'),
    enabled: () => ctl.enabled,
    ...(o.accepts ? { accepts: () => o.accepts! } : {}),
    enqueue: async (c) => {
      events.push(`enqueue:${c.jobId}`);
      enqueued.push(c);
      return { pipelineJobId: `p-${enqueued.length}` };
    },
    cancel,
    checkout,
    ...(o.knownJob ? { knownJob: o.knownJob } : {}),
    sniff: async (file, name, mime) => {
      const r = await sniffFile(file, name, mime);
      return r.ok ? r.mediaType : null;
    },
    kick,
    now: () => clock.t,
  });
  // The store's own create, even when another harness over the same store already spied on it.
  const realCreate = MemorySyncStore.prototype.create.bind(mem);
  vi.spyOn(mem, 'create').mockImplementation(async (id, name, props, body, mime) => {
    if (props.k === 'status') {
      events.push(`status:${props.s}:${(JSON.parse(new TextDecoder().decode(body)) as JobStatus).state}`);
    }
    return realCreate(id, name, props, body, mime);
  });

  /** A file the phone writes (its own device id), straight into the store. */
  const put = async (k: SyncKind, s: string, body: Uint8Array | string | object, dev = PHONE): Promise<RemoteFile> => {
    const [id] = await mem.generateIds(1);
    const bytes =
      body instanceof Uint8Array ? body : enc.encode(typeof body === 'string' ? body : JSON.stringify(body));
    return realCreate(id!, `${k}-${s}`, { k, dev, s }, bytes, 'application/octet-stream');
  };
  const pass = async (account = 'tester@example.com'): Promise<void> => {
    const files = await store.list({});
    await inbox.process({ store, files, deviceId: DESK, account });
  };
  const statusFiles = (jobId?: string): RemoteFile[] =>
    mem.snapshot().filter((f) => f.props.k === 'status' && (!jobId || f.props.s === jobId));
  const status = (jobId: string): JobStatus | undefined => {
    const f = statusFiles(jobId).find((x) => x.props.dev === DESK);
    return f ? JobStatusSchema.parse(JSON.parse(mem.text(f.id)!)) : undefined;
  };
  const capture = (over: Record<string, unknown> = {}) => ({
    v: 1,
    jobId: newJobId(),
    deviceId: PHONE,
    createdAt: new Date(clock.t).toISOString(),
    kind: 'capture',
    urls: ['https://example.com/article?id=1'],
    text: '',
    clarifyingInput: '',
    focus: [],
    attachments: [],
    ...over,
  });
  const send = async (job: { jobId: string } & Record<string, unknown>, dev = PHONE): Promise<string> => {
    await put('job', job.jobId, job, dev);
    return job.jobId;
  };
  return {
    dir,
    mem,
    store,
    clock,
    ctl,
    events,
    enqueued,
    cancel,
    checkout,
    kick,
    ledger,
    inbox,
    put,
    pass,
    status,
    statusFiles,
    capture,
    send,
  };
}

/** A pipeline snapshot as the queue emits it. */
function snap(over: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    id: 'p-1',
    kind: 'create',
    status: 'queued',
    statusLine: 'Queued',
    createdAt: new Date(T0).toISOString(),
    skippedCount: 0,
    canCancel: true,
    canRetry: false,
    canDismiss: false,
    origin: 'inbox',
    ...over,
  };
}

describe('capture (16 §5.3)', () => {
  it("passes the phone's deadpan request on, and treats an absent or false flag as off", async () => {
    const h = await harness();
    const on = await h.send(h.capture({ deadpan: true }));
    const off = await h.send(h.capture({ deadpan: false }));
    const absent = await h.send(h.capture());
    await h.pass();
    const byId = new Map(h.enqueued.map((c) => [c.jobId, c.deadpan]));
    expect(byId.get(on)).toBe(true);
    expect(byId.get(off)).toBe(false);
    expect(byId.get(absent)).toBe(false);
  });

  it('rejects a capture whose deadpan flag is not a boolean, without enqueueing it', async () => {
    const h = await harness();
    const id = await h.send(h.capture({ deadpan: 'true' }));
    await h.pass();
    expect(h.enqueued).toEqual([]);
    expect(h.status(id)).toMatchObject({ state: 'rejected', code: 'E_INVALID' });
  });

  it('validates, writes received, then enqueues; the phone sees queued', async () => {
    const h = await harness();
    const id = await h.send(h.capture({ clarifyingInput: '  Keep it short ', focus: ['big-picture', 'numbers'] }));
    await h.pass();
    expect(h.enqueued).toEqual([
      {
        jobId: id,
        urls: ['https://example.com/article?id=1'],
        files: [],
        clarifyingInput: `Keep it short ${FOCUS_PHRASES['big-picture']} ${FOCUS_PHRASES.numbers}`,
        deadpan: false,
        root: path.join(h.dir, 'sync', 'inbox', id),
      },
    ]);
    // Status `received` is in the store before the pipeline is asked (step 5).
    expect(h.events).toEqual([`status:${id}:received`, `enqueue:${id}`]);
    expect(h.status(id)).toMatchObject({ v: 1, jobId: id, state: 'queued' });
    const [file] = h.statusFiles(id);
    expect(file).toMatchObject({ name: `jobstatus-${id}.json`, props: { k: 'status', dev: DESK, s: id } });
    expect(h.inbox.pending()).toBe(1);
  });

  it('stages shared text as a file and keeps no text in the ledger', async () => {
    const h = await harness();
    const text = 'Widget margins rose in the third quarter because the new presses use less steel.';
    const id = await h.send(h.capture({ urls: [], text }));
    await h.pass();
    const [c] = h.enqueued;
    expect(c!.files).toEqual([{ path: path.join(c!.root, SHARED_TEXT_FILE), name: SHARED_TEXT_FILE }]);
    expect(await readFile(c!.files[0]!.path, 'utf8')).toBe(text);
    expect(readFileSync(h.ledger.file, 'utf8')).not.toContain('Widget');
    expect(h.status(id)?.state).toBe('queued');
  });

  it('downloads attachments, checks sha256 and size, and sniffs the type', async () => {
    const h = await harness();
    await h.put('att', sha(PNG), PNG);
    await h.put('att', sha(PDF), PDF);
    const id = await h.send(
      h.capture({
        urls: [],
        attachments: [
          { sha: sha(PNG), name: 'chart.png', mime: 'image/png', size: PNG.byteLength },
          { sha: sha(PDF), name: 'report.pdf', mime: 'application/pdf', size: PDF.byteLength },
        ],
      }),
    );
    await h.pass();
    const [c] = h.enqueued;
    expect(c!.files.map((f) => f.name)).toEqual(['chart.png', 'report.pdf']);
    for (const f of c!.files) expect(path.dirname(f.path)).toBe(c!.root);
    expect(new Uint8Array(await readFile(c!.files[1]!.path))).toEqual(PDF);
    expect(h.status(id)?.state).toBe('queued');
  });

  it('sha mismatch: rejected with E_ATTACHMENT and the staged folder removed', async () => {
    const h = await harness();
    const claimed = sha('something else');
    await h.put('att', claimed, PNG); // listed under a sha its bytes do not have
    const id = await h.send(
      h.capture({ urls: [], attachments: [{ sha: claimed, name: 'a.png', mime: 'image/png', size: PNG.byteLength }] }),
    );
    await h.pass();
    expect(h.enqueued).toEqual([]);
    expect(h.status(id)).toMatchObject({ state: 'rejected', code: 'E_ATTACHMENT', reason: INBOX_TEXT.attachment });
    expect(existsSync(path.join(h.dir, 'sync', 'inbox', id))).toBe(false);
  });

  it('type sniffing: a PDF declared as an image is rejected; the declared type is never trusted', async () => {
    const h = await harness();
    await h.put('att', sha(PDF), PDF);
    const id = await h.send(
      h.capture({
        urls: [],
        attachments: [{ sha: sha(PDF), name: 'photo.png', mime: 'image/png', size: PDF.byteLength }],
      }),
    );
    await h.pass();
    expect(h.enqueued).toEqual([]);
    expect(h.status(id)).toMatchObject({ state: 'rejected', code: 'E_ATTACHMENT' });
  });

  it('type sniffing: bytes outside the allowlist are rejected', async () => {
    const h = await harness();
    const exe = Uint8Array.from([
      0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff, 0, 0, 0xb8, 0, 0, 0, 0, 0, 0, 0,
    ]);
    await h.put('att', sha(exe), exe);
    const id = await h.send(
      h.capture({
        urls: [],
        attachments: [{ sha: sha(exe), name: 'notes.txt', mime: 'text/plain', size: exe.byteLength }],
      }),
    );
    await h.pass();
    expect(h.status(id)).toMatchObject({ state: 'rejected', code: 'E_ATTACHMENT' });
  });

  it('size caps: a stored file bigger than declared is refused before download; an oversized declaration is invalid', async () => {
    const h = await harness();
    await h.put('att', sha(PNG), PNG);
    const get = vi.spyOn(h.mem, 'get');
    const a = await h.send(
      h.capture({
        urls: [],
        attachments: [{ sha: sha(PNG), name: 'a.png', mime: 'image/png', size: PNG.byteLength - 1 }],
      }),
    );
    const b = await h.send(
      h.capture({
        urls: [],
        attachments: [{ sha: sha(PNG), name: 'b.png', mime: 'image/png', size: 20 * 1024 * 1024 + 1 }],
      }),
    );
    await h.pass();
    expect(h.status(a)).toMatchObject({ state: 'rejected', code: 'E_ATTACHMENT' });
    expect(h.status(b)).toMatchObject({ state: 'rejected', code: 'E_INVALID' });
    const attId = h.mem.snapshot().find((f) => f.props.k === 'att')!.id;
    expect(get.mock.calls.some(([fid]) => fid === attId)).toBe(false);
  });

  it('an attachment not listed yet is waited for, then rejected after 10 minutes', async () => {
    const h = await harness();
    const late = sha('late bytes');
    const id = await h.send(
      h.capture({ urls: [], attachments: [{ sha: late, name: 'a.txt', mime: 'text/plain', size: 10 }] }),
    );
    await h.pass();
    expect(h.status(id)?.state).toBe('received');
    h.clock.t += 5 * MIN;
    await h.pass();
    expect(h.enqueued).toEqual([]);
    h.clock.t += ATTACHMENT_WAIT_MS;
    await h.pass();
    expect(h.status(id)).toMatchObject({ state: 'rejected', code: 'E_ATTACHMENT' });
  });

  it('an attachment that arrives late is used on the next pass', async () => {
    const h = await harness();
    const id = await h.send(
      h.capture({ urls: [], attachments: [{ sha: sha(PNG), name: 'a.png', mime: 'image/png', size: PNG.byteLength }] }),
    );
    await h.pass();
    expect(h.enqueued).toEqual([]);
    await h.put('att', sha(PNG), PNG);
    await h.pass();
    expect(h.enqueued.map((c) => c.jobId)).toEqual([id]);
    expect(h.status(id)?.state).toBe('queued');
  });

  it('an enqueue failure ends the job as failed with a user line', async () => {
    const h = await harness();
    const enqueue = vi.fn(async () => {
      throw Object.assign(new Error('read-only'), { code: 'E_LIBRARY_READ_ONLY' });
    });
    const inbox = new SyncInbox({
      ledger: h.ledger,
      dir: path.join(h.dir, 'sync', 'inbox'),
      enabled: () => true,
      enqueue,
      cancel: async () => false,
      checkout: async () => ({ kind: 'done' }),
      sniff: async () => null,
      now: () => h.clock.t,
    });
    const id = await h.send(h.capture());
    await inbox.process({ store: h.store, files: await h.store.list({}), deviceId: DESK });
    expect(h.status(id)).toMatchObject({ state: 'failed', code: 'E_START', reason: INBOX_TEXT.start });
  });
});

describe('validation (16 §5.3 step 1)', { timeout: 60_000 }, () => {
  const fixtures = readdirSync(FIXTURES).filter((f) => f.startsWith('job.'));

  it.each(fixtures)('%s: valid ones are accepted, invalid ones rejected with E_INVALID', async (name) => {
    const h = await harness();
    const raw = JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
    const createdAt = typeof raw.createdAt === 'string' ? Date.parse(raw.createdAt) : NaN;
    if (Number.isFinite(createdAt)) h.clock.t = createdAt + HOUR;
    const fileId = typeof raw.jobId === 'string' && /^[0-9a-f-]{36}$/.test(raw.jobId) ? raw.jobId : newJobId();
    const jobId = /-7[0-9a-f]{3}-[89ab]/.test(fileId) ? fileId : newJobId();
    await h.put('job', jobId, raw);
    await h.pass();
    const s = h.status(jobId);
    if (name.startsWith('job.valid.')) {
      if (raw.kind === 'ask') expect(s).toMatchObject({ state: 'rejected', code: 'E_UNSUPPORTED' });
      else expect(s?.state).toMatch(/^(received|queued|done)$/);
    } else {
      expect(s).toMatchObject({ state: 'rejected', code: 'E_INVALID', reason: INBOX_TEXT.invalid });
    }
  });

  it(
    'schema fuzzing: random mutations never throw and are accepted only when the strict schema accepts them',
    { timeout: 60_000 },
    async () => {
      let seed = 0x5eed;
      const rnd = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const values: unknown[] = [
        null,
        0,
        -1,
        1.5,
        2,
        '',
        'x'.repeat(30_000),
        'https://192.168.1.1/',
        'javascript:alert(1)',
        '‮',
        [],
        ['https://example.com/'],
        {},
        true,
        '2026-11-01T12:00:00.000Z',
        '2020-01-01T00:00:00.000Z',
        'capture',
        'checkout',
        'ask',
        [{ sha: 'a'.repeat(64), name: 'x.png', mime: 'image/png', size: 1 }],
      ];
      const h = await harness();
      const outcomes = new Map<string, string>();
      for (let i = 0; i < 120; i++) {
        const base: Record<string, unknown> = h.capture();
        const jobId = base.jobId as string;
        const keys = [...Object.keys(base), 'extra', 'docId', 'versionId'];
        for (let m = 0; m < 1 + Math.floor(rnd() * 3); m++) {
          const k = pick(keys);
          const op = rnd();
          if (op < 0.25) delete base[k];
          else base[k] = pick(values);
        }
        // Each job counts against its own account, so rate limits stay out of the way.
        const garbage = rnd() < 0.05;
        await h.put('job', jobId, garbage ? '{not json' : base);
        await h.pass(`fuzz-${i}@example.com`);
        const s = h.status(jobId);
        expect(s, `mutation ${i}`).toBeDefined();
        const parsed = JobRequestSchema.safeParse(base);
        const valid = !garbage && parsed.success && parsed.data.jobId === jobId;
        if (!valid) expect(s).toMatchObject({ state: 'rejected', code: expect.stringMatching(/^E_(INVALID)$/) });
        else expect(s!.state).toMatch(/^(received|queued|done|rejected)$/);
        if (s!.state === 'rejected' && valid) expect(s!.code).toMatch(/^E_(EXPIRED|UNSUPPORTED)$/);
        outcomes.set(s!.state, (outcomes.get(s!.state) ?? '') + '.');
      }
      // Both branches were exercised.
      expect(outcomes.has('rejected')).toBe(true);
      expect([...outcomes.keys()].some((k) => k !== 'rejected')).toBe(true);
    },
  );

  it('a body whose jobId differs from the file is invalid', async () => {
    const h = await harness();
    const fileId = newJobId();
    await h.put('job', fileId, h.capture());
    await h.pass();
    expect(h.status(fileId)).toMatchObject({ state: 'rejected', code: 'E_INVALID' });
    expect(h.enqueued).toEqual([]);
  });

  it('createdAt older than 30 days or more than a day ahead is rejected', async () => {
    const h = await harness();
    const old = await h.send(h.capture({ createdAt: new Date(T0 - 31 * DAY).toISOString() }));
    const ahead = await h.send(h.capture({ createdAt: new Date(T0 + DAY + MIN).toISOString() }));
    const fine = await h.send(h.capture({ createdAt: new Date(T0 - 29 * DAY).toISOString() }));
    await h.pass();
    expect(h.status(old)).toMatchObject({ state: 'rejected', code: 'E_EXPIRED', reason: INBOX_TEXT.expired });
    expect(h.status(ahead)).toMatchObject({ state: 'rejected', code: 'E_EXPIRED' });
    expect(h.status(fine)?.state).toBe('queued');
  });

  it('kinds missing from accepts are rejected', async () => {
    const h = await harness({ accepts: ['checkout'] });
    const ask = JSON.parse(readFileSync(path.join(FIXTURES, 'job.valid.ask.json'), 'utf8')) as Record<string, unknown>;
    const a = await h.send({ ...ask, jobId: newJobId(), createdAt: new Date(T0).toISOString() });
    const c = await h.send(h.capture());
    await h.pass();
    expect(h.status(a)).toMatchObject({ state: 'rejected', code: 'E_UNSUPPORTED', reason: INBOX_TEXT.unsupported });
    expect(h.status(c)).toMatchObject({ state: 'rejected', code: 'E_UNSUPPORTED' });
    expect(h.enqueued).toEqual([]);
    expect(h.inbox.accepts()).toEqual(['checkout']);
  });

  it('a job file over 1 MiB is invalid without parsing', async () => {
    const h = await harness();
    const id = newJobId();
    await h.put('job', id, ' '.repeat(1024 * 1024 + 1));
    await h.pass();
    expect(h.status(id)).toMatchObject({ state: 'rejected', code: 'E_INVALID' });
  });
});

describe('dedupe and replay (16 §5.3 step 2)', () => {
  it('a job listed again is a no-op, across passes and a restart', async () => {
    const h = await harness();
    const id = await h.send(h.capture());
    await h.pass();
    await h.pass();
    const again = await harness({ dir: h.dir, mem: h.mem });
    await again.pass();
    expect(h.enqueued).toHaveLength(1);
    expect(again.enqueued).toEqual([]);
    expect(h.statusFiles(id)).toHaveLength(1);
  });

  it('with the ledger lost, the pipeline job store and own status files still dedupe', async () => {
    const h = await harness();
    const id = await h.send(h.capture());
    await h.pass();
    await rm(path.join(h.dir, 'sync', 'inbox.json'));
    // Own status file in the store and the pipeline job: adopted, not rewritten.
    const a = await harness({ dir: h.dir, mem: h.mem, knownJob: (j) => (j === id ? snap() : undefined) });
    await a.pass();
    expect(a.enqueued).toEqual([]);
    expect(h.statusFiles(id)).toHaveLength(1);
    expect(a.ledger.entry(id)).toMatchObject({ kind: 'capture', pipelineJobId: 'p-1', statusGone: false });
    expect(a.status(id)).toMatchObject({ state: 'queued' });
    // Pipeline knows the job (status file gone): adopted from the snapshot.
    await rm(path.join(h.dir, 'sync', 'inbox.json'));
    await h.mem.delete(h.statusFiles(id)[0]!.id);
    const b = await harness({
      dir: h.dir,
      mem: h.mem,
      knownJob: (j) =>
        j === id ? snap({ id: 'p-9', status: 'generating', statusLine: 'Writing the in-depth tab' }) : undefined,
    });
    await b.pass();
    expect(b.enqueued).toEqual([]);
    expect(b.status(id)).toMatchObject({ state: 'running', stage: 'Writing the in-depth tab' });
  });

  it('own unfinished status with the ledger lost and no pipeline job: ends as failed, never restarts', async () => {
    const h = await harness();
    const id = await h.send(
      h.capture({ urls: [], attachments: [{ sha: sha('late'), name: 'a.txt', mime: 'text/plain', size: 4 }] }),
    );
    await h.pass();
    expect(h.status(id)?.state).toBe('received');
    await rm(path.join(h.dir, 'sync', 'inbox.json'));
    const a = await harness({ dir: h.dir, mem: h.mem, knownJob: () => undefined });
    await a.put('att', sha('late'), 'late');
    await a.pass();
    expect(a.enqueued).toEqual([]);
    expect(a.status(id)).toMatchObject({ state: 'failed', code: 'E_INTERNAL' });
    expect(h.statusFiles(id)).toHaveLength(1);
  });

  it('a crash between enqueue and saving the pipeline id never starts the job twice', async () => {
    const h = await harness();
    const id = await h.send(
      h.capture({ urls: [], attachments: [{ sha: sha('late'), name: 'a.txt', mime: 'text/plain', size: 4 }] }),
    );
    await h.pass();
    expect(h.ledger.entry(id)).toMatchObject({ report: { state: 'received' } });
    expect(h.ledger.entry(id)?.pipelineJobId).toBeUndefined();
    // Relaunch: the ledger still says `received`, but the pipeline already has the job.
    const a = await harness({
      dir: h.dir,
      mem: h.mem,
      knownJob: (j) => (j === id ? snap({ id: 'p-7', status: 'reading', statusLine: 'Reading sources' }) : undefined),
    });
    await a.put('att', sha('late'), 'late');
    await a.pass();
    expect(a.enqueued).toEqual([]);
    expect(a.ledger.entry(id)).toMatchObject({ pipelineJobId: 'p-7', report: { state: 'running' } });
    expect(a.status(id)).toMatchObject({ state: 'running', stage: 'Reading sources' });
  });

  it('a job another desktop already answered is left to it: no status from this one', async () => {
    const h = await harness();
    const id = await h.send(h.capture());
    await h.put(
      'status',
      id,
      { v: 1, jobId: id, updatedAt: new Date(T0).toISOString(), state: 'running', stage: 'Reading sources' },
      OTHER_MAC,
    );
    await h.pass();
    expect(h.enqueued).toEqual([]);
    expect(h.status(id)).toBeUndefined();
  });

  it('a corrupt ledger is set aside and the store dedupes', async () => {
    const h = await harness();
    const id = await h.send(h.capture());
    await h.pass();
    await writeFile(path.join(h.dir, 'sync', 'inbox.json'), '{broken');
    const again = await harness({ dir: h.dir, mem: h.mem, knownJob: (j) => (j === id ? snap() : undefined) });
    await again.pass();
    expect(again.enqueued).toEqual([]);
    expect(readdirSync(path.join(h.dir, 'sync')).some((n) => n.startsWith('inbox.json.corrupt-'))).toBe(true);
    expect(again.ledger.entry(id)?.report.state).toBe('queued');
  });
});

describe('rate limits (16 §5.3 step 3)', { timeout: 60_000 }, () => {
  it('30 per hour per account, whatever device id the job claims', async () => {
    const h = await harness();
    const ids: string[] = [];
    for (let i = 0; i < INBOX_RATE_PER_HOUR + 1; i++) {
      ids.push(await h.send(h.capture({ deviceId: i % 2 ? PHONE : PHONE_2 }), i % 2 ? PHONE : PHONE_2));
    }
    await h.pass();
    expect(h.enqueued).toHaveLength(INBOX_RATE_PER_HOUR);
    expect(h.status(ids.at(-1)!)).toMatchObject({ state: 'rejected', code: 'E_RATE', reason: INBOX_TEXT.rate });
    // Another account is not limited by this one.
    const other = await h.send(h.capture());
    await h.pass('someone-else@example.com');
    expect(h.status(other)?.state).toBe('queued');
    // An hour later the first account may send again.
    h.clock.t += HOUR;
    const later = await h.send(h.capture());
    await h.pass();
    expect(h.status(later)?.state).toBe('queued');
  });

  it('100 per day per account', async () => {
    const h = await harness();
    for (let hour = 0; hour < 4; hour++) {
      for (let i = 0; i < 25; i++) await h.send(h.capture());
      await h.pass();
      h.clock.t += HOUR;
    }
    expect(h.enqueued).toHaveLength(100);
    const over = await h.send(h.capture());
    await h.pass();
    expect(h.status(over)).toMatchObject({ state: 'rejected', code: 'E_RATE' });
    h.clock.t += DAY;
    const next = await h.send(h.capture());
    await h.pass();
    expect(h.status(next)?.state).toBe('queued');
  });

  it('rejected jobs do not count', async () => {
    const h = await harness();
    for (let i = 0; i < 40; i++) await h.put('job', newJobId(), '{bad');
    const ok = await h.send(h.capture());
    await h.pass();
    expect(h.status(ok)?.state).toBe('queued');
  });
});

describe('cancel (16 §5.2 step 3)', () => {
  it('a cancel file that arrives with the job: cancelled, never started', async () => {
    const h = await harness();
    const id = await h.send(h.capture());
    await h.put('cancel', id, { jobId: id, at: new Date(T0).toISOString() });
    await h.pass();
    expect(h.enqueued).toEqual([]);
    expect(h.status(id)?.state).toBe('cancelled');
  });

  it('a cancel while the job is queued cancels the pipeline job', async () => {
    const h = await harness();
    const id = await h.send(h.capture());
    await h.pass();
    await h.put('cancel', id, { jobId: id, at: new Date(T0).toISOString() });
    await h.pass();
    expect(h.cancel).toHaveBeenCalledWith('p-1');
    expect(h.status(id)?.state).toBe('cancelled');
  });

  it('a cancel after the job started running is not honoured', async () => {
    const h = await harness();
    const id = await h.send(h.capture());
    await h.pass();
    await h.inbox.reportJob(id, snap({ status: 'reading', statusLine: 'Reading sources (0 of 1)' }));
    await h.put('cancel', id, { jobId: id, at: new Date(T0).toISOString() });
    await h.pass();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.status(id)).toMatchObject({ state: 'running', stage: 'Reading sources (0 of 1)' });
  });

  it('a cancel that loses the race to the pipeline leaves the job alone', async () => {
    const h = await harness({ cancel: false });
    const id = await h.send(h.capture());
    await h.pass();
    await h.put('cancel', id, { jobId: id, at: new Date(T0).toISOString() });
    await h.pass();
    expect(h.cancel).toHaveBeenCalledOnce();
    expect(h.status(id)?.state).toBe('queued');
  });
});

describe('checkout (16 §5.3 "checkout")', () => {
  const checkoutJob = (createdAt: number) => ({
    v: 1,
    jobId: newJobId(),
    deviceId: PHONE,
    createdAt: new Date(createdAt).toISOString(),
    kind: 'checkout',
    docId: DOC,
    versionId: 'v-000000000002',
  });

  it('runs the checkout service and reports done with the version', async () => {
    const h = await harness();
    const id = await h.send(checkoutJob(T0));
    await h.pass();
    expect(h.checkout).toHaveBeenCalledWith(DOC, 'v-000000000002');
    expect(h.status(id)).toMatchObject({ state: 'done', docId: DOC, versionId: 'v-000000000002' });
  });

  it('a busy document is retried for 10 minutes, then failed with E_CONFLICT', async () => {
    const busy = Array.from({ length: 10 }, () => ({ kind: 'busy' }) as const);
    const h = await harness({ checkout: busy });
    const id = await h.send(checkoutJob(T0));
    await h.pass();
    expect(h.status(id)).toMatchObject({ state: 'queued', stage: INBOX_TEXT.busyStage });
    h.clock.t += CHECKOUT_RETRY_MS - MIN;
    await h.pass();
    expect(h.status(id)?.state).toBe('queued');
    h.clock.t += MIN;
    await h.pass();
    expect(h.status(id)).toMatchObject({ state: 'failed', code: 'E_CONFLICT', reason: INBOX_TEXT.conflict });
    const calls = h.checkout.mock.calls.length;
    await h.pass();
    expect(h.checkout.mock.calls.length).toBe(calls);
  });

  it('a busy document that frees up within the window is checked out', async () => {
    const h = await harness({ checkout: [{ kind: 'busy' }, { kind: 'done' }] });
    const id = await h.send(checkoutJob(T0));
    await h.pass();
    h.clock.t += MIN;
    await h.pass();
    expect(h.status(id)?.state).toBe('done');
  });

  it('a cancel while a busy checkout waits cancels it', async () => {
    const h = await harness({ checkout: [{ kind: 'busy' }, { kind: 'busy' }] });
    const id = await h.send(checkoutJob(T0));
    await h.pass();
    await h.put('cancel', id, { jobId: id, at: new Date(T0).toISOString() });
    await h.pass();
    expect(h.status(id)?.state).toBe('cancelled');
    expect(h.checkout).toHaveBeenCalledOnce();
  });

  it('maps a missing document or version to its own failure', async () => {
    const h = await harness({ checkout: [{ kind: 'not-found' }, { kind: 'version-gone' }, { kind: 'failed' }] });
    const a = await h.send(checkoutJob(T0));
    const b = await h.send(checkoutJob(T0));
    const c = await h.send(checkoutJob(T0));
    await h.pass();
    expect(h.status(a)).toMatchObject({ state: 'failed', code: 'E_NOT_FOUND', reason: INBOX_TEXT.notFound });
    expect(h.status(b)).toMatchObject({ state: 'failed', code: 'E_VERSION_GONE' });
    expect(h.status(c)).toMatchObject({ state: 'failed', code: 'E_CHECKOUT' });
  });

  it('checkoutOutcomeOf maps the service error codes', () => {
    expect(checkoutOutcomeOf('E_CONFLICT')).toEqual({ kind: 'busy' });
    expect(checkoutOutcomeOf('E_NOT_FOUND')).toEqual({ kind: 'not-found' });
    expect(checkoutOutcomeOf('NOT_FOUND')).toEqual({ kind: 'not-found' });
    expect(checkoutOutcomeOf('VERSION_NOT_FOUND')).toEqual({ kind: 'version-gone' });
    expect(checkoutOutcomeOf(undefined)).toEqual({ kind: 'failed' });
  });
});

describe('statuses (16 §5.3)', () => {
  it('pipeline events become statuses; a terminal one is final', async () => {
    const h = await harness();
    const id = await h.send(h.capture());
    await h.pass();
    await h.inbox.reportJob(id, snap({ status: 'generating', statusLine: 'Writing the in-depth tab' }));
    expect(h.kick).toHaveBeenCalledTimes(1);
    // A repeated progress event with the same report is not saved or pushed again.
    await h.inbox.reportJob(id, snap({ status: 'generating', statusLine: 'Writing the in-depth tab' }));
    expect(h.kick).toHaveBeenCalledTimes(1);
    await h.pass();
    expect(h.status(id)).toMatchObject({ state: 'running', stage: 'Writing the in-depth tab' });
    const docId = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    await h.inbox.reportJob(
      id,
      snap({
        status: 'done',
        statusLine: 'Done: Widget pricing',
        skippedCount: 1,
        result: { docId, topicSlug: 'widget-pricing', title: 'Widget pricing' },
      }),
    );
    await h.inbox.reportJob(id, snap({ status: 'queued', statusLine: 'Queued' })); // a later Retry: ignored
    await h.pass();
    expect(h.status(id)).toMatchObject({ state: 'done', docId, skippedSources: 1 });
    expect(existsSync(path.join(h.dir, 'sync', 'inbox', id))).toBe(false);
    expect(h.statusFiles(id)).toHaveLength(1);
    expect(h.inbox.pending()).toBe(0);
  });

  it('reportFromSnapshot maps every pipeline state', () => {
    expect(reportFromSnapshot(snap())).toEqual({ state: 'queued', stage: 'Queued' });
    expect(reportFromSnapshot(snap({ status: 'saving', statusLine: 'Saving\nnow' }))).toEqual({
      state: 'running',
      stage: 'Saving now',
    });
    expect(reportFromSnapshot(snap({ status: 'failed', failureCode: 'CANCELLED', statusLine: 'Cancelled' }))).toEqual({
      state: 'cancelled',
    });
    expect(
      reportFromSnapshot(
        snap({ status: 'failed', failureCode: 'NO_USABLE_CONTENT', statusLine: 'Failed: no usable content' }),
      ),
    ).toEqual({ state: 'failed', code: 'E_NO_USABLE_CONTENT', reason: 'no usable content' });
    expect(reportFromSnapshot(snap({ status: 'done', statusLine: 'Done' }))).toMatchObject({
      state: 'failed',
      code: 'E_INTERNAL',
    });
  });

  it('statusBody always satisfies the shared schema', () => {
    const id = newJobId();
    expect(JobStatusSchema.safeParse(statusBody(id, { state: 'running', stage: 'a\nb'.repeat(200) }, T0)).success).toBe(
      true,
    );
    expect(statusBody(id, { state: 'failed' }, T0)).toMatchObject({ state: 'failed', code: 'E_INTERNAL' });
    expect(statusBody(id, { state: 'done' }, T0)).toMatchObject({ state: 'failed', code: 'E_INTERNAL' });
  });

  it('a lost create response reuses the preallocated id: one status file', async () => {
    const h = await harness();
    const id = await h.send(h.capture());
    const create = MemorySyncStore.prototype.create.bind(h.mem);
    let failed = false;
    vi.spyOn(h.mem, 'create').mockImplementation(async (...args) => {
      const f = await create(...args);
      if (args[2].k === 'status' && !failed) {
        failed = true;
        throw new SyncError('E_SYNC_HTTP', 'socket hang up');
      }
      return f;
    });
    await expect(h.pass()).rejects.toMatchObject({ code: 'E_SYNC_HTTP' });
    await h.pass();
    expect(h.statusFiles(id)).toHaveLength(1);
    expect(h.status(id)?.state).toBe('queued');
    expect(h.enqueued).toHaveLength(1);
  });

  it('a status collected after the job ended is not written again', async () => {
    const h = await harness();
    const id = await h.send(h.capture());
    await h.put('cancel', id, { jobId: id, at: new Date(T0).toISOString() });
    await h.pass();
    expect(h.status(id)?.state).toBe('cancelled');
    await h.mem.delete(h.statusFiles(id)[0]!.id);
    await h.ledger.update((l) => {
      l.jobs[id]!.report = { state: 'cancelled' };
      l.jobs[id]!.writtenHash = 'stale';
    });
    await h.pass();
    expect(h.statusFiles(id)).toEqual([]);
  });

  it('turning the inbox off stops new jobs; accepted jobs keep reporting', async () => {
    const h = await harness();
    const first = await h.send(h.capture());
    await h.pass();
    h.ctl.enabled = false;
    const second = await h.send(h.capture());
    await h.inbox.reportJob(first, snap({ status: 'reading', statusLine: 'Reading sources' }));
    await h.pass();
    expect(h.status(first)?.state).toBe('running');
    expect(h.status(second)).toBeUndefined();
    expect(h.inbox.pending()).toBe(2);
    h.ctl.enabled = true;
    await h.pass();
    expect(h.status(second)?.state).toBe('queued');
  });

  it('forgets ledger entries after 60 days once the job file is gone', async () => {
    const h = await harness();
    const id = await h.send(h.capture());
    await h.put('cancel', id, { jobId: id, at: new Date(T0).toISOString() });
    await h.pass();
    h.clock.t += LEDGER_KEEP_MS + MIN;
    await h.pass();
    expect(h.ledger.entry(id)).toBeDefined(); // the job file is still listed
    const job = h.mem.snapshot().find((f) => f.props.k === 'job' && f.props.s === id)!;
    await h.mem.delete(job.id);
    await h.pass();
    expect(h.ledger.entry(id)).toBeUndefined();
  });

  it('stagedName keeps long names under the file system limit with their extension', () => {
    expect(stagedName(0, 'chart.png')).toBe('1-chart.png');
    const long = stagedName(2, `${'\u{1F4C8}'.repeat(200)}.pdf`);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(180);
    expect(long.startsWith('3-')).toBe(true);
    expect(long.endsWith('.pdf')).toBe(true);
  });

  it('a local failure ends the job instead of repeating on every pass', async () => {
    const h = await harness();
    const inbox = new SyncInbox({
      ledger: h.ledger,
      dir: path.join(h.dir, 'sync', 'inbox'),
      enabled: () => true,
      enqueue: async () => ({ pipelineJobId: 'p-1' }),
      cancel: async () => false,
      checkout: async () => ({ kind: 'done' }),
      sniff: async () => {
        throw new Error('disk full');
      },
      now: () => h.clock.t,
    });
    await h.put('att', sha(PNG), PNG);
    const id = await h.send(
      h.capture({ urls: [], attachments: [{ sha: sha(PNG), name: 'a.png', mime: 'image/png', size: PNG.byteLength }] }),
    );
    await inbox.process({ store: h.store, files: await h.store.list({}), deviceId: DESK });
    expect(h.status(id)).toMatchObject({ state: 'failed', code: 'E_INTERNAL', reason: INBOX_TEXT.failed });
  });

  it('composeClarifying appends focus phrases in order', () => {
    expect(composeClarifying('', [])).toBe('');
    expect(composeClarifying(' Short ', ['beginner'])).toBe(`Short ${FOCUS_PHRASES.beginner}`);
  });
});

describe('engine runs the inbox (16 §4.3, §5.3)', () => {
  const inertTimers: EngineTimers = {
    setTimeout: () => ({}),
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };

  it('advertises the inbox in the device file and answers a job on a pass', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'eli5-sync-inbox-engine-'));
    dirs.push(dir);
    const mem = new MemorySyncStore();
    const h = await harness({ dir, mem });
    const state = new SyncStateStore({ dir: path.join(dir, 'sync'), mintDeviceId: () => DESK });
    const lib = new MemLibrary();
    const engine = new SyncEngine({
      library: lib,
      state,
      active: () => true,
      openStore: (guard) => new GuardedStore(mem, guard),
      auth: { configured: async () => true, signedIn: async () => true },
      history: () => 'recent',
      pollSeconds: () => 60,
      policy: () => ({ excludeDoc: () => false }),
      outline: () => [],
      isBusy: () => false,
      device: { name: 'Example Mac', appVersion: '0.2.0' },
      inbox: h.inbox,
      now: () => h.clock.t,
      timers: inertTimers,
    });
    await engine.syncNow();
    const device = mem.snapshot().find((f) => f.props.k === 'device' && f.props.dev === DESK)!;
    expect(JSON.parse(mem.text(device.id)!)).toMatchObject({
      role: 'primary',
      accepts: ['capture', 'checkout'],
      inbox: 'on',
    });

    const id = await h.send(h.capture());
    await engine.syncNow();
    expect(h.enqueued.map((c) => c.jobId)).toEqual([id]);
    expect(h.status(id)?.state).toBe('queued');
    expect(engine.status().inboxPending).toBe(1);

    // Read-only library: the inbox pauses and the device says so.
    lib.readOnly = true;
    const waiting = await h.send(h.capture());
    await engine.syncNow();
    expect(h.status(waiting)).toBeUndefined();
    expect(JSON.parse(mem.text(device.id)!)).toMatchObject({ inbox: 'paused-read-only' });
    engine.stop();
  });

  it('a mirror never answers jobs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'eli5-sync-inbox-mirror-'));
    dirs.push(dir);
    const mem = new MemorySyncStore();
    const h = await harness({ dir, mem });
    // Another Mac holds a newer claim and is alive.
    await h.put('claim', '', { deviceId: OTHER_MAC, claimedAt: new Date(T0).toISOString() }, OTHER_MAC);
    const claim = mem.snapshot().find((f) => f.props.k === 'claim')!;
    await mem.touch(claim.id, { n: T0 + 1000 });
    const state = new SyncStateStore({ dir: path.join(dir, 'sync'), mintDeviceId: () => DESK });
    const engine = new SyncEngine({
      library: new MemLibrary(),
      state,
      active: () => true,
      openStore: (guard) => new GuardedStore(mem, guard),
      auth: { configured: async () => true, signedIn: async () => true },
      history: () => 'recent',
      pollSeconds: () => 60,
      policy: () => ({ excludeDoc: () => false }),
      outline: () => [],
      isBusy: () => false,
      device: { name: 'Example Mac', appVersion: '0.2.0' },
      inbox: h.inbox,
      now: () => h.clock.t,
      timers: inertTimers,
    });
    const id = await h.send(h.capture());
    await engine.syncNow();
    expect(engine.status().state).not.toBe('idle');
    expect(h.status(id)).toBeUndefined();
    expect(h.enqueued).toEqual([]);
    engine.stop();
  });
});
