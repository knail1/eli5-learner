/**
 * The desktop side of the phone inbox (16 §5.3). Job files are untrusted input to a paid pipeline:
 * this module validates them, dedupes them against a durable ledger, applies per-account rate
 * limits, stages and checks attachments, hands captures to the pipeline through an injected
 * `enqueue` (sync never imports the pipeline, 01 §3), runs checkouts through an injected service,
 * honours cancel files and writes `jobstatus-<jobId>.json` for the phone.
 *
 * The engine calls `process` once per pass, only while this desktop is the primary and the library
 * is writable. New jobs are accepted only while "Accept jobs from phone" (`sync.inbox.enabled`) is
 * on; jobs already accepted keep reporting their status after it is turned off.
 *
 * Steps for a new job file (16 §5.3):
 * 1. Strict parse; reject `v` other than 1, a `createdAt` older than 30 days or more than a day ahead,
 *    a body whose `jobId` is not the file's, and kinds this desktop does not accept.
 * 2. Dedupe by `jobId`: the ledger, the pipeline's job store and any status file already in the store.
 * 3. Rate limits per Google account (the device id is self-asserted): 30 per hour, 100 per day.
 * 4. Attachments into `<userData>/sync/inbox/<jobId>/` (0700): sha256, size and sniffed type checked.
 * 5. Status `received`, then `enqueue`; the pipeline's events update the status (`reportJob`).
 *
 * Logs carry ids, counts and codes only, never URLs, text, names or questions (16 §9).
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { JobSnapshot } from '../../preload/contract';
import { log } from '../security';
import type { InboxLedger, LedgerEntry, LedgerReport } from './ledger';
import {
  ATTACHMENT_MIME_TYPES,
  BLANK_RE,
  DOC_ID_RE,
  ERROR_CODE_RE,
  JOB_ID_RE,
  JobRequestSchema,
  JobStatusSchema,
  PROTOCOL_VERSION,
  type FocusChip,
  type JobKind,
  type JobRequest,
  type JobState,
  type JobStatus,
} from './protocol';
import { sha256Hex } from './stores/drive-appdata';
import type { GuardedStore } from './stores/guard';
import type { RemoteFile } from './types';
import { SyncError } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 16 §5.3 step 3: jobs accepted per Google account. */
export const INBOX_RATE_PER_HOUR = 30;
export const INBOX_RATE_PER_DAY = 100;
/** 16 §5.3 step 1: the `createdAt` window. */
export const INBOX_MAX_AGE_MS = 30 * DAY;
export const INBOX_MAX_AHEAD_MS = DAY;
/** 16 §5.3: a busy document is retried for 10 minutes. */
export const CHECKOUT_RETRY_MS = 10 * MINUTE;
/** An attachment not listed yet (listings lag) is waited for this long, then the job is rejected. */
export const ATTACHMENT_WAIT_MS = 10 * MINUTE;
/** Failed captures keep their staged files this long, so Retry in the app still finds them. */
export const FAILED_FILES_KEEP_MS = 7 * DAY;
/**
 * Ledger entries are kept this long: longer than a job file can live in the store (GC removes it 30
 * days after it ended), so a job file listed again is always a no-op.
 */
export const LEDGER_KEEP_MS = 60 * DAY;
/** A job file is a few KiB; anything over this is not a job. */
export const MAX_JOB_FILE_BYTES = 1024 * 1024;
/** Job kinds whose desktop path has shipped (16 §4.3 `accepts`). Ask joins once the inbox runs the 08 §6.8 Ask path. */
export const INBOX_ACCEPTS: readonly JobKind[] = Object.freeze(['capture', 'checkout'] as JobKind[]);
/** The staged file that carries a capture's shared text. */
export const SHARED_TEXT_FILE = 'shared-text.txt';

/** Focus chips become fixed English phrases after the clarifying input (16 §5.1). */
export const FOCUS_PHRASES: Readonly<Record<FocusChip, string>> = Object.freeze({
  'big-picture': 'Focus on the big picture.',
  'how-it-works': 'Explain how it works.',
  numbers: 'Pay attention to the numbers.',
  beginner: 'Explain it for a beginner.',
});

/** The user-facing one-liners for statuses the inbox writes itself (16 §10). */
export const INBOX_TEXT = Object.freeze({
  invalid: 'Your Mac could not read this request',
  expired: 'This request is too old; send it again',
  unsupported: "Your Mac can't do this yet",
  rate: 'Too many requests from your phone; try again later',
  attachment: 'An attachment could not be used',
  conflict: 'Your Mac is updating this document; try again in a moment',
  notFound: 'This learning is no longer on your Mac',
  versionGone: 'That version is no longer on your Mac',
  checkout: 'Your Mac could not switch versions',
  start: 'Your Mac could not start this job',
  failed: 'Your Mac could not finish this job',
  busyStage: 'Waiting for the document to be free',
});

/** What `enqueue` receives: a capture staged by main (16 §5.3 "capture"). */
export interface InboxCapture {
  /** The phone's job id. */
  jobId: string;
  urls: string[];
  /** Staged attachments and the shared text, all under `root`. */
  files: Array<{ path: string; name: string }>;
  clarifyingInput: string;
  /** The phone asked for the Deadpan tab too (16 §5.1, 0.6.0); false when the key was absent. */
  deadpan: boolean;
  /** `<userData>/sync/inbox/<jobId>/`. */
  root: string;
}

export type CheckoutOutcome =
  { kind: 'done' } | { kind: 'busy' } | { kind: 'not-found' } | { kind: 'version-gone' } | { kind: 'failed' };

/**
 * Maps a checkout service failure to an outcome by its error code: 08's `E_CONFLICT` (a section of
 * the document is busy) and `E_NOT_FOUND`, 09's `NOT_FOUND`, `VERSION_NOT_FOUND` and `VERSION_CORRUPT`.
 */
export function checkoutOutcomeOf(code: string | undefined): CheckoutOutcome {
  switch (code) {
    case 'E_CONFLICT':
      return { kind: 'busy' };
    case 'E_NOT_FOUND':
    case 'NOT_FOUND':
      return { kind: 'not-found' };
    case 'VERSION_NOT_FOUND':
    case 'VERSION_CORRUPT':
      return { kind: 'version-gone' };
    default:
      return { kind: 'failed' };
  }
}

export interface SyncInboxDeps {
  ledger: InboxLedger;
  /** `<userData>/sync/inbox`; one 0700 folder per accepted capture. */
  dir: string;
  /** `sync.inbox.enabled` ("Accept jobs from phone"). */
  enabled(): boolean;
  /** Defaults to `INBOX_ACCEPTS`. */
  accepts?(): readonly JobKind[];
  /** Starts the pipeline job (`jobs.startFromMain(..., {origin: 'inbox'})`); bootstrap injects it. */
  enqueue(c: InboxCapture): Promise<{ pipelineJobId: string }>;
  /** Cancels a pipeline job that is not running yet; false when it is running or already over. */
  cancel(pipelineJobId: string): Promise<boolean>;
  /** The 08 §6.7 checkout service. */
  checkout(docId: string, versionId: string): Promise<CheckoutOutcome>;
  /** The pipeline job already started for this phone job id (a ledger that was lost), if any. */
  knownJob?(jobId: string): JobSnapshot | undefined;
  /** Sniffed media type of a staged file (03 §5.2), or null when it is not a supported type. */
  sniff(filePath: string, name: string, declaredMime: string): Promise<string | null>;
  /** Asks for a sync pass soon, so a changed status reaches the store. */
  kick?(): void;
  now?(): number;
}

/** What the engine hands `process` on each pass (primary, writable library). */
export interface InboxPass {
  store: GuardedStore;
  /** Every file in the engine's index. */
  files: readonly RemoteFile[];
  deviceId: string;
  /** The signed-in account (a hint shown in Settings); hashed before it is stored. */
  account?: string;
  /** A status file was created or rewritten: the engine updates its index (GC reads it). */
  onWritten?(file: RemoteFile): void;
}

const TERMINAL: ReadonlySet<JobState> = new Set(['done', 'failed', 'rejected', 'cancelled']);
const TEXT_FAMILY: ReadonlySet<string> = new Set(['text/plain', 'text/markdown', 'text/csv', 'text/html']);
const enc = new TextEncoder();
const dec = new TextDecoder();

const isTerminal = (s: JobState): boolean => TERMINAL.has(s);

const codeOf = (err: unknown): string => {
  const c = (err as { code?: unknown } | undefined)?.code;
  return typeof c === 'string' ? c : 'unknown';
};

/** One line, at most `max` code points. */
export function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  const cps = Array.from(flat);
  return cps.length > max ? cps.slice(0, max).join('') : flat;
}

/** The clarifying input the pipeline receives: the phone's text, then the focus phrases. */
export function composeClarifying(clarifyingInput: string, focus: readonly FocusChip[]): string {
  return [clarifyingInput.trim(), ...focus.map((f) => FOCUS_PHRASES[f])].filter((x) => x !== '').join(' ');
}

/** The account a job counts against: a sha256 prefix, never the address itself. */
export function accountKey(account: string | undefined): string {
  return createHash('sha256')
    .update((account ?? '').trim().toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

/**
 * The status a pipeline snapshot means for the phone (16 §5.3 "Bootstrap maps pipeline events").
 * The failure reason is the pipeline's own one-line status without its `Failed: ` prefix.
 */
export function reportFromSnapshot(s: JobSnapshot): LedgerReport {
  const stage = oneLine(s.statusLine, 200);
  switch (s.status) {
    case 'queued':
      return { state: 'queued', ...(stage ? { stage } : {}) };
    case 'reading':
    case 'extracting':
    case 'generating':
    case 'saving':
      return { state: 'running', ...(stage ? { stage } : {}) };
    case 'done': {
      const docId = s.result?.docId;
      if (!docId || !DOC_ID_RE.test(docId)) return { state: 'failed', code: 'E_INTERNAL', reason: INBOX_TEXT.failed };
      return { state: 'done', docId, skippedSources: s.skippedCount, ...(stage ? { stage } : {}) };
    }
    case 'failed': {
      if (s.failureCode === 'CANCELLED') return { state: 'cancelled' };
      const code = `E_${s.failureCode ?? 'INTERNAL'}`;
      const reason = oneLine(s.statusLine.replace(/^Failed:\s*/, ''), 300) || INBOX_TEXT.failed;
      return { state: 'failed', code: ERROR_CODE_RE.test(code) ? code : 'E_INTERNAL', reason };
    }
  }
}

/** The `jobstatus` body for a report; a report the schema refuses degrades to a plain failure. */
export function statusBody(jobId: string, r: LedgerReport, nowMs: number): JobStatus {
  const body = {
    v: PROTOCOL_VERSION,
    jobId,
    updatedAt: new Date(nowMs).toISOString(),
    ...r,
    ...(r.stage !== undefined ? { stage: oneLine(r.stage, 200) } : {}),
    ...(r.reason !== undefined ? { reason: oneLine(r.reason, 300) } : {}),
  };
  const ok = JobStatusSchema.safeParse(body);
  if (ok.success) return ok.data;
  return JobStatusSchema.parse({
    v: PROTOCOL_VERSION,
    jobId,
    updatedAt: body.updatedAt,
    state: 'failed',
    code: 'E_INTERNAL',
    reason: INBOX_TEXT.failed,
  });
}

const reportHash = (r: LedgerReport): string => sha256Hex(enc.encode(JSON.stringify(r)));

/** Sniffed type matches the declared one, or both are plain-text family types (extension decides there). */
function sameType(sniffed: string, declared: string): boolean {
  return sniffed === declared || (TEXT_FAMILY.has(sniffed) && TEXT_FAMILY.has(declared));
}

type Parsed = { ok: true; job: JobRequest } | { ok: false };

/** File names stay well under the 255-byte limit of macOS file systems. */
const MAX_NAME_BYTES = 180;

/**
 * The staged file name of attachment `i`: `<i+1>-<name>`, shortened to `MAX_NAME_BYTES` with its
 * extension kept (the protocol allows 200 code points, which can be 800 bytes). The name is already
 * free of separators, controls and bidi characters (`ATTACHMENT_NAME_RE`).
 */
export function stagedName(i: number, name: string): string {
  const full = `${i + 1}-${name}`;
  if (Buffer.byteLength(full) <= MAX_NAME_BYTES) return full;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
  const cps = Array.from(name.slice(0, name.length - ext.length));
  while (cps.length > 0 && Buffer.byteLength(`${i + 1}-${cps.join('')}${ext}`) > MAX_NAME_BYTES) cps.pop();
  return `${i + 1}-${cps.join('')}${ext}`;
}

export class SyncInbox {
  private readonly now: () => number;
  private waiting = 0;
  /** Jobs whose processing is in flight in this pass (a report arriving meanwhile is merged). */
  private readonly busy = new Set<string>();

  constructor(private readonly d: SyncInboxDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Job kinds this desktop runs (16 §4.3 `accepts`). */
  accepts(): JobKind[] {
    return [...(this.d.accepts?.() ?? INBOX_ACCEPTS)];
  }

  enabled(): boolean {
    return this.d.enabled();
  }

  /** Jobs waiting in the store or not finished yet (`SyncStatus.inboxPending`). */
  pending(): number {
    let open = 0;
    try {
      for (const e of Object.values(this.d.ledger.current().jobs)) {
        if (!isTerminal(e.report.state) && !e.statusGone) open++;
      }
    } catch {
      open = 0;
    }
    return this.waiting + open;
  }

  // ------------------------------------------------------------------------------- the pass

  async process(p: InboxPass): Promise<void> {
    await this.d.ledger.load();
    this.rememberStatusFiles(p);
    const jobFiles = new Map<string, RemoteFile>();
    const cancels = new Set<string>();
    const statuses = new Map<string, RemoteFile>();
    for (const f of p.files) {
      const id = f.props.s;
      if (!id || !JOB_ID_RE.test(id)) continue;
      if (f.props.k === 'job' && !jobFiles.has(id)) jobFiles.set(id, f);
      else if (f.props.k === 'cancel') cancels.add(id);
      else if (f.props.k === 'status') {
        // This desktop's own file wins over another desktop's.
        if (!statuses.has(id) || f.props.dev === p.deviceId) statuses.set(id, f);
      }
    }

    // New job files, oldest first (a UUIDv7 sorts by time).
    let waiting = 0;
    const handled = new Set<string>();
    for (const jobId of [...jobFiles.keys()].sort()) {
      if (this.d.ledger.entry(jobId)) continue;
      if (!this.d.enabled()) {
        waiting++;
        continue;
      }
      handled.add(jobId);
      await this.guarded(jobId, () =>
        this.receive(p, jobId, jobFiles.get(jobId)!, cancels.has(jobId), statuses.get(jobId)),
      );
    }
    this.waiting = waiting;

    // Jobs already accepted: cancels, busy checkouts, captures waiting for attachments.
    for (const [jobId, e] of Object.entries(this.d.ledger.current().jobs)) {
      // A job another desktop answered (statusGone) is that desktop's to finish.
      if (isTerminal(e.report.state) || e.statusGone || this.busy.has(jobId) || handled.has(jobId)) continue;
      await this.guarded(jobId, async () => {
        if (cancels.has(jobId) && (await this.tryCancel(jobId, e))) return;
        if (e.kind === 'checkout' && e.checkout && e.report.state !== 'running') {
          await this.runCheckout(jobId);
        } else if (e.kind === 'capture' && e.report.state === 'received' && !e.pipelineJobId) {
          const f = jobFiles.get(jobId);
          const parsed = f ? await this.readJob(p.store, f) : ({ ok: false } as Parsed);
          if (parsed.ok && parsed.job.kind === 'capture') await this.startCapture(p, jobId, parsed.job);
          else await this.finish(jobId, { state: 'failed', code: 'E_INVALID', reason: INBOX_TEXT.invalid });
        }
      });
    }

    await this.flush(p);
    await this.cleanup(new Set(jobFiles.keys()));
  }

  /** Runs one job's step; a store failure ends the pass, anything else is logged and retried later. */
  private async guarded(jobId: string, fn: () => Promise<void>): Promise<void> {
    this.busy.add(jobId);
    try {
      await fn();
    } catch (err) {
      if (err instanceof SyncError && err.code !== 'E_SYNC_NOT_FOUND') throw err;
      log.warn('sync.inbox.job-step-failed', { code: codeOf(err) });
      // A local failure (disk full, a file system refusing a name) would repeat on every pass: the
      // job ends instead, and the phone can send it again.
      if (!(err instanceof SyncError)) {
        await this.finish(jobId, { state: 'failed', code: 'E_INTERNAL', reason: INBOX_TEXT.failed });
      }
    } finally {
      this.busy.delete(jobId);
    }
  }

  /** The guard learns this desktop's status files after a restart, before any update. */
  private rememberStatusFiles(p: InboxPass): void {
    const files: RemoteFile[] = [];
    for (const [jobId, e] of Object.entries(this.d.ledger.current().jobs)) {
      if (e.statusFileId)
        files.push({ id: e.statusFileId, name: '', props: { k: 'status', dev: p.deviceId, s: jobId } });
    }
    if (files.length > 0) p.store.remember(files);
  }

  // --------------------------------------------------------------------------- a new job

  private async receive(
    p: InboxPass,
    jobId: string,
    file: RemoteFile,
    cancelled: boolean,
    status: RemoteFile | undefined,
  ): Promise<void> {
    const now = this.now();
    const seenAt = new Date(now).toISOString();

    // 16 §5.3 step 2: a job some desktop already answered, or the pipeline already has, is a no-op.
    if (status) {
      const own = status.props.dev === p.deviceId;
      const body = await this.readStatus(p.store, status);
      const written: LedgerReport = body ? reportOf(body) : { state: 'received' };
      // This desktop's own unfinished job with the ledger lost: the pipeline job is adopted so its
      // events keep reaching the phone; a job the pipeline never got cannot resume, so it ends.
      const known = own && !isTerminal(written.state) ? this.d.knownJob?.(jobId) : undefined;
      const report: LedgerReport =
        !own || isTerminal(written.state)
          ? written
          : known
            ? reportFromSnapshot(known)
            : { state: 'failed', code: 'E_INTERNAL', reason: INBOX_TEXT.failed };
      await this.d.ledger.update((l) => {
        l.jobs[jobId] = {
          ...(known ? { kind: 'capture' as const, pipelineJobId: known.id } : {}),
          seenAt,
          counted: false,
          report,
          ...(own ? { statusFileId: status.id, writtenHash: reportHash(written) } : {}),
          statusGone: !own,
          cleaned: !own,
        };
      });
      log.info('sync.inbox.replay', { status: own ? 'own-status' : 'other-desktop' });
      return;
    }
    const known = this.d.knownJob?.(jobId);
    if (known) {
      await this.d.ledger.update((l) => {
        l.jobs[jobId] = {
          kind: 'capture',
          seenAt,
          counted: false,
          pipelineJobId: known.id,
          report: reportFromSnapshot(known),
          statusGone: false,
          cleaned: false,
        };
      });
      log.info('sync.inbox.replay', { status: 'pipeline' });
      return;
    }

    const parsed = await this.readJob(p.store, file);
    if (!parsed.ok || parsed.job.jobId !== jobId) {
      return this.reject(jobId, seenAt, 'E_INVALID', INBOX_TEXT.invalid);
    }
    const job = parsed.job;
    const created = Date.parse(job.createdAt);
    if (now - created > INBOX_MAX_AGE_MS || created - now > INBOX_MAX_AHEAD_MS) {
      return this.reject(jobId, seenAt, 'E_EXPIRED', INBOX_TEXT.expired, job.kind);
    }
    if (!this.accepts().includes(job.kind)) {
      return this.reject(jobId, seenAt, 'E_UNSUPPORTED', INBOX_TEXT.unsupported, job.kind);
    }
    if (cancelled) {
      await this.d.ledger.update((l) => {
        l.jobs[jobId] = {
          kind: job.kind,
          seenAt,
          counted: false,
          report: { state: 'cancelled' },
          statusGone: false,
          cleaned: true,
        };
      });
      log.info('sync.inbox.cancelled', { step: 'before-start' });
      return;
    }
    const account = accountKey(p.account);
    if (this.overLimit(account, now)) {
      log.warn('sync.inbox.rate-limited', { code: 'E_RATE' });
      return this.reject(jobId, seenAt, 'E_RATE', INBOX_TEXT.rate, job.kind);
    }
    await this.d.ledger.update((l) => {
      l.jobs[jobId] = {
        kind: job.kind,
        seenAt,
        counted: true,
        account,
        report: { state: 'received' },
        ...(job.kind === 'checkout' ? { checkout: { docId: job.docId, versionId: job.versionId } } : {}),
        statusGone: false,
        cleaned: job.kind !== 'capture',
      };
    });
    log.info('sync.inbox.received', { kind: job.kind });
    if (job.kind === 'checkout') {
      await this.runCheckout(jobId);
    } else if (job.kind === 'capture') {
      // 16 §5.3 step 5: the phone sees `received` before the pipeline is asked to start.
      await this.flushOne(p, jobId);
      await this.startCapture(p, jobId, job);
    }
  }

  /** 16 §5.3 step 3: jobs accepted for this account in the last hour and day. */
  private overLimit(account: string, now: number): boolean {
    let hour = 0;
    let day = 0;
    for (const e of Object.values(this.d.ledger.current().jobs)) {
      if (!e.counted || e.account !== account) continue;
      const age = now - Date.parse(e.seenAt);
      if (age < 0 || age >= DAY) continue;
      day++;
      if (age < HOUR) hour++;
    }
    return hour >= INBOX_RATE_PER_HOUR || day >= INBOX_RATE_PER_DAY;
  }

  private async reject(jobId: string, seenAt: string, code: string, reason: string, kind?: JobKind): Promise<void> {
    await this.d.ledger.update((l) => {
      l.jobs[jobId] = {
        ...(kind ? { kind } : {}),
        seenAt,
        counted: false,
        report: { state: 'rejected', code, reason },
        statusGone: false,
        cleaned: true,
      };
    });
    log.info('sync.inbox.rejected', { code });
  }

  /** Downloads and strictly parses a job file; anything unreadable is invalid. */
  private async readJob(store: GuardedStore, f: RemoteFile): Promise<Parsed> {
    if (f.size !== undefined && f.size > MAX_JOB_FILE_BYTES) return { ok: false };
    let bytes: Uint8Array;
    try {
      bytes = await store.get(f.id);
    } catch (err) {
      if (codeOf(err) === 'E_SYNC_NOT_FOUND') return { ok: false };
      throw err;
    }
    if (bytes.byteLength > MAX_JOB_FILE_BYTES) return { ok: false };
    let raw: unknown;
    try {
      raw = JSON.parse(dec.decode(bytes));
    } catch {
      return { ok: false };
    }
    const r = JobRequestSchema.safeParse(raw);
    return r.success ? { ok: true, job: r.data } : { ok: false };
  }

  private async readStatus(store: GuardedStore, f: RemoteFile): Promise<JobStatus | undefined> {
    try {
      const bytes = await store.get(f.id);
      if (bytes.byteLength > MAX_JOB_FILE_BYTES) return undefined;
      const r = JobStatusSchema.safeParse(JSON.parse(dec.decode(bytes)));
      return r.success ? r.data : undefined;
    } catch (err) {
      if (err instanceof SyncError && err.code !== 'E_SYNC_NOT_FOUND') throw err;
      return undefined;
    }
  }

  // ------------------------------------------------------------------------------ capture

  /**
   * 16 §5.3 step 4–5: stage and check attachments, write the shared text, then enqueue. An
   * attachment the store does not list yet is waited for (listings lag) before the job is rejected.
   */
  private async startCapture(
    p: InboxPass,
    jobId: string,
    job: Extract<JobRequest, { kind: 'capture' }>,
  ): Promise<void> {
    const entry = this.d.ledger.entry(jobId);
    if (!entry) return;
    // A crash between `enqueue` and saving its id leaves the entry `received`: adopt, never start twice.
    const known = this.d.knownJob?.(jobId);
    if (known) {
      await this.d.ledger.update((l) => {
        const x = l.jobs[jobId];
        if (!x || isTerminal(x.report.state)) return;
        x.pipelineJobId = known.id;
        x.report = reportFromSnapshot(known);
      });
      log.info('sync.inbox.replay', { status: 'pipeline' });
      return;
    }
    const dir = path.join(this.d.dir, jobId);
    const files: InboxCapture['files'] = [];
    if (job.attachments.length > 0 || !BLANK_RE.test(job.text)) await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const [i, a] of job.attachments.entries()) {
      const remote = p.files.find((f) => f.props.k === 'att' && f.props.s === a.sha);
      let bytes: Uint8Array | undefined;
      if (remote) {
        if (remote.size !== undefined && remote.size !== a.size) return this.rejectAttachment(jobId, 'size');
        try {
          bytes = await p.store.get(remote.id);
        } catch (err) {
          if (codeOf(err) !== 'E_SYNC_NOT_FOUND') throw err;
        }
      }
      if (!bytes) {
        if (this.now() - Date.parse(entry.seenAt) > ATTACHMENT_WAIT_MS) return this.rejectAttachment(jobId, 'missing');
        log.info('sync.inbox.attachment-waiting', { count: i + 1 });
        return; // tried again on the next pass
      }
      if (bytes.byteLength !== a.size) return this.rejectAttachment(jobId, 'size');
      if (sha256Hex(bytes) !== a.sha) return this.rejectAttachment(jobId, 'sha');
      const target = path.join(dir, stagedName(i, a.name));
      await fsp.writeFile(target, bytes, { mode: 0o600 });
      const sniffed = await this.d.sniff(target, a.name, a.mime);
      if (!sniffed || !(ATTACHMENT_MIME_TYPES as readonly string[]).includes(sniffed) || !sameType(sniffed, a.mime)) {
        return this.rejectAttachment(jobId, 'type');
      }
      files.push({ path: target, name: a.name });
    }
    if (!BLANK_RE.test(job.text)) {
      const target = path.join(dir, SHARED_TEXT_FILE);
      await fsp.writeFile(target, job.text, { mode: 0o600 });
      files.push({ path: target, name: SHARED_TEXT_FILE });
    }
    let pipelineJobId: string;
    try {
      ({ pipelineJobId } = await this.d.enqueue({
        jobId,
        urls: [...job.urls],
        files,
        clarifyingInput: composeClarifying(job.clarifyingInput, job.focus),
        deadpan: job.deadpan === true,
        root: dir,
      }));
    } catch (err) {
      log.warn('sync.inbox.enqueue-failed', { code: codeOf(err) });
      await this.finish(jobId, { state: 'failed', code: 'E_START', reason: INBOX_TEXT.start });
      return;
    }
    await this.d.ledger.update((l) => {
      const e = l.jobs[jobId];
      if (!e) return;
      e.pipelineJobId = pipelineJobId;
      // The pipeline may already have reported a later state through `reportJob`.
      if (e.report.state === 'received') e.report = { state: 'queued' };
    });
    log.info('sync.inbox.enqueued', { count: job.urls.length + files.length });
  }

  private async rejectAttachment(jobId: string, why: 'missing' | 'size' | 'sha' | 'type'): Promise<void> {
    log.warn('sync.inbox.attachment-refused', { code: 'E_ATTACHMENT', kind: why });
    await this.finish(jobId, { state: 'rejected', code: 'E_ATTACHMENT', reason: INBOX_TEXT.attachment });
  }

  // ----------------------------------------------------------------------------- checkout

  /** 08 §6.7 checkout; a busy document is retried on later passes for 10 minutes (16 §5.3). */
  private async runCheckout(jobId: string): Promise<void> {
    const e = this.d.ledger.entry(jobId);
    if (!e?.checkout || isTerminal(e.report.state)) return;
    const { docId, versionId } = e.checkout;
    let out: CheckoutOutcome;
    try {
      out = await this.d.checkout(docId, versionId);
    } catch (err) {
      log.warn('sync.inbox.checkout-failed', { code: codeOf(err) });
      out = { kind: 'failed' };
    }
    const now = this.now();
    switch (out.kind) {
      case 'done':
        return this.finish(jobId, { state: 'done', docId, versionId });
      case 'busy': {
        const first = e.firstTryAt ? Date.parse(e.firstTryAt) : now;
        if (now - first >= CHECKOUT_RETRY_MS) {
          return this.finish(jobId, { state: 'failed', code: 'E_CONFLICT', reason: INBOX_TEXT.conflict });
        }
        await this.d.ledger.update((l) => {
          const x = l.jobs[jobId];
          if (!x) return;
          x.firstTryAt ??= new Date(now).toISOString();
          x.report = { state: 'queued', stage: INBOX_TEXT.busyStage };
        });
        return;
      }
      case 'not-found':
        return this.finish(jobId, { state: 'failed', code: 'E_NOT_FOUND', reason: INBOX_TEXT.notFound });
      case 'version-gone':
        return this.finish(jobId, { state: 'failed', code: 'E_VERSION_GONE', reason: INBOX_TEXT.versionGone });
      case 'failed':
        return this.finish(jobId, { state: 'failed', code: 'E_CHECKOUT', reason: INBOX_TEXT.checkout });
    }
  }

  // ------------------------------------------------------------------------------- cancel

  /** 16 §5.2 step 3: a cancel is honoured only while the job is not running. True when it ended. */
  private async tryCancel(jobId: string, e: LedgerEntry): Promise<boolean> {
    if (e.report.state === 'running') return false;
    if (e.pipelineJobId) {
      let ok = false;
      try {
        ok = await this.d.cancel(e.pipelineJobId);
      } catch (err) {
        log.info('sync.inbox.cancel-refused', { code: codeOf(err) });
      }
      if (!ok) return false;
    }
    await this.finish(jobId, { state: 'cancelled' });
    log.info('sync.inbox.cancelled', { step: e.pipelineJobId ? 'queued' : 'before-start' });
    return true;
  }

  // ------------------------------------------------------------------------------ reports

  /**
   * A pipeline event for a job started from the inbox (`jobs.originOf(id).ref`). Statuses after a
   * terminal one are ignored: the phone may already have acknowledged it and GC removed its files.
   */
  async reportJob(jobId: string, s: JobSnapshot): Promise<void> {
    await this.d.ledger.load();
    const e = this.d.ledger.entry(jobId);
    if (!e || isTerminal(e.report.state)) return;
    const next = reportFromSnapshot(s);
    // Progress events repeat; only a changed report is saved and pushed.
    if (e.pipelineJobId === s.id && reportHash(e.report) === reportHash(next)) return;
    await this.d.ledger.update((l) => {
      const x = l.jobs[jobId];
      if (!x || isTerminal(x.report.state)) return;
      x.pipelineJobId ??= s.id;
      x.report = next;
    });
    if (isTerminal(next.state)) log.info('sync.inbox.finished', { status: next.state });
    this.d.kick?.();
  }

  private async finish(jobId: string, report: LedgerReport): Promise<void> {
    await this.d.ledger.update((l) => {
      const x = l.jobs[jobId];
      if (x && !isTerminal(x.report.state)) x.report = report;
    });
  }

  /** Writes every status that changed since it was last written (16 §5.3, one writer: this desktop). */
  private async flush(p: InboxPass): Promise<void> {
    for (const jobId of Object.keys(this.d.ledger.current().jobs)) await this.flushOne(p, jobId);
  }

  private async flushOne(p: InboxPass, jobId: string): Promise<void> {
    const e = this.d.ledger.entry(jobId);
    if (!e || e.statusGone) return;
    const hash = reportHash(e.report);
    if (e.writtenHash === hash && e.statusFileId) return;
    await this.writeStatus(p, jobId, e, hash);
  }

  private async writeStatus(p: InboxPass, jobId: string, e: LedgerEntry, hash: string): Promise<void> {
    const body = enc.encode(JSON.stringify(statusBody(jobId, e.report, this.now())));
    if (e.statusFileId) {
      try {
        // Not inside `onWritten?.(...)`: an optional call skips evaluating its arguments.
        const file = await p.store.update(e.statusFileId, body);
        p.onWritten?.(file);
      } catch (err) {
        if (codeOf(err) === 'E_SYNC_CHECKSUM') return; // a bad revision: rewritten on the next pass
        if (codeOf(err) !== 'E_SYNC_NOT_FOUND') throw err;
        // Collected (16 §4.7) or deleted by hand. A finished job's status is not brought back.
        const ended = e.writtenHash !== undefined && isTerminal(e.report.state);
        await this.d.ledger.update((l) => {
          const x = l.jobs[jobId];
          if (!x) return;
          if (ended) x.statusGone = true;
          delete x.statusFileId;
        });
        if (!ended) await this.writeStatus(p, jobId, { ...e, statusFileId: undefined }, hash);
        return;
      }
    } else {
      let id = e.pendingStatusId;
      if (!id) {
        const [fresh] = await p.store.generateIds(1);
        if (!fresh) throw new SyncError('E_SYNC_HTTP', 'No file id available');
        id = fresh;
        await this.d.ledger.update((l) => {
          const x = l.jobs[jobId];
          if (x) x.pendingStatusId = fresh;
        });
      }
      let file: RemoteFile;
      try {
        file = await p.store.create(
          id,
          `jobstatus-${jobId}.json`,
          { k: 'status', dev: p.deviceId, s: jobId },
          body,
          'application/json',
        );
      } catch (err) {
        if (codeOf(err) === 'E_SYNC_CHECKSUM' || codeOf(err) === 'E_SYNC_OWNERSHIP') {
          await this.d.ledger.update((l) => {
            const x = l.jobs[jobId];
            if (x) delete x.pendingStatusId;
          });
        }
        throw err;
      }
      await this.d.ledger.update((l) => {
        const x = l.jobs[jobId];
        if (!x) return;
        x.statusFileId = file.id;
        delete x.pendingStatusId;
      });
      // A retried create returns the file a lost response made, with that attempt's content.
      if (file.sha256 !== sha256Hex(body)) file = await p.store.update(file.id, body);
      p.onWritten?.(file);
    }
    await this.d.ledger.update((l) => {
      const x = l.jobs[jobId];
      if (x) x.writtenHash = hash;
    });
  }

  // ------------------------------------------------------------------------------ cleanup

  /**
   * Removes staged files of finished jobs (a failed capture keeps them 7 days for Retry in the app)
   * and forgets ledger entries after 60 days, once their job file has left the store.
   */
  private async cleanup(listed: ReadonlySet<string>): Promise<void> {
    const now = this.now();
    const drop: string[] = [];
    const cleaned: string[] = [];
    for (const [jobId, e] of Object.entries(this.d.ledger.current().jobs)) {
      if (!isTerminal(e.report.state)) continue;
      const age = now - Date.parse(e.seenAt);
      if (!e.cleaned && (e.report.state !== 'failed' || age > FAILED_FILES_KEEP_MS)) {
        await fsp.rm(path.join(this.d.dir, jobId), { recursive: true, force: true });
        cleaned.push(jobId);
      }
      if (age > LEDGER_KEEP_MS && !listed.has(jobId)) drop.push(jobId);
    }
    if (drop.length === 0 && cleaned.length === 0) return;
    await this.d.ledger.update((l) => {
      for (const id of cleaned) if (l.jobs[id]) l.jobs[id].cleaned = true;
      for (const id of drop) delete l.jobs[id];
    });
  }
}

/** A status file's body as a ledger report (dedupe of a job some desktop already answered). */
function reportOf(s: JobStatus): LedgerReport {
  const { v: _v, jobId: _j, updatedAt: _u, ...rest } = s;
  return rest;
}
