/**
 * The phone inbox ledger (16 §5.3 step 2): `<userData>/sync/inbox.json`, written atomically inside the
 * 0700 sync folder. One entry per phone job id this desktop has seen, accepted or not, so a job file that is
 * listed again (a replay, a lost change token, a restart) is a no-op. Entries also carry what the
 * rate limits count (16 §5.3 step 3) and the job status this desktop owes the phone.
 *
 * The ledger is local bookkeeping, never uploaded. It holds no URL, text, question or title: only
 * ids, states, times and the hashed account the job counted against.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeJsonAtomic } from '../library';
import { log } from '../security';
import { ANCHOR_ID_RE, DOC_ID_RE, ERROR_CODE_RE, JOB_ID_RE, JOB_KINDS, JOB_STATES, VERSION_ID_RE } from './protocol';

export const INBOX_LEDGER_FILE = 'inbox.json';
export const INBOX_LEDGER_VERSION = 1;

/** The fields of a `jobstatus` file besides `v`, `jobId` and `updatedAt` (16 §5.3). */
export const LedgerReportSchema = z
  .object({
    state: z.enum(JOB_STATES),
    stage: z.string().max(200).optional(),
    docId: z.string().regex(DOC_ID_RE).optional(),
    versionId: z.string().regex(VERSION_ID_RE).optional(),
    skippedSources: z.number().int().min(0).optional(),
    anchorId: z.string().regex(ANCHOR_ID_RE).optional(),
    code: z.string().regex(ERROR_CODE_RE).optional(),
    reason: z.string().max(300).optional(),
  })
  .strict();
export type LedgerReport = z.infer<typeof LedgerReportSchema>;

const EntrySchema = z
  .object({
    kind: z.enum(JOB_KINDS).optional(),
    /** When this desktop first saw the job file. */
    seenAt: z.string(),
    /** Counted against the per-account rate limits (16 §5.3 step 3): accepted, not rejected. */
    counted: z.boolean().default(false),
    /** sha256 prefix of the signed-in account, never the address itself. */
    account: z.string().max(64).optional(),
    /** The pipeline job a capture became. */
    pipelineJobId: z.string().max(128).optional(),
    /** A checkout's target, kept so a busy checkout is retried without downloading the job again. */
    checkout: z
      .object({ docId: z.string().regex(DOC_ID_RE), versionId: z.string().regex(VERSION_ID_RE) })
      .strict()
      .optional(),
    /** First time a busy checkout was tried (16 §5.3: retried for 10 minutes). */
    firstTryAt: z.string().optional(),
    /** The status this desktop owes the phone. */
    report: LedgerReportSchema,
    /** Hash of the last status body written (without `updatedAt`): unchanged statuses are not rewritten. */
    writtenHash: z.string().max(64).optional(),
    /** The remote `jobstatus-<jobId>.json` file, once created. */
    statusFileId: z.string().max(256).optional(),
    /** A preallocated id saved before the create, so a retried create never duplicates (16 §4.5 step 4). */
    pendingStatusId: z.string().max(256).optional(),
    /**
     * No status is written for this job: its file was collected after the job ended, or another
     * desktop already answered it (16 §4.6: one primary at a time).
     */
    statusGone: z.boolean().default(false),
    /** The staged attachments folder was removed. */
    cleaned: z.boolean().default(false),
  })
  .strict();
export type LedgerEntry = z.infer<typeof EntrySchema>;

export const InboxLedgerSchema = z
  .object({
    v: z.literal(INBOX_LEDGER_VERSION).default(INBOX_LEDGER_VERSION),
    jobs: z.record(z.string().regex(JOB_ID_RE), EntrySchema).default({}),
  })
  .strict();
export type InboxLedgerData = z.infer<typeof InboxLedgerSchema>;

export interface InboxLedgerOptions {
  /** `<userData>/sync`; created with mode 0700. */
  dir: string;
}

/** Loads, caches and atomically saves the ledger. Writes are serialized; a corrupt file is set aside. */
export class InboxLedger {
  private data: InboxLedgerData | undefined;
  private loading: Promise<InboxLedgerData> | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: InboxLedgerOptions) {}

  get file(): string {
    return path.join(this.opts.dir, INBOX_LEDGER_FILE);
  }

  load(): Promise<InboxLedgerData> {
    if (this.data) return Promise.resolve(this.data);
    this.loading ??= this.read().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async read(): Promise<InboxLedgerData> {
    let raw: string | undefined;
    try {
      raw = await fsp.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (raw === undefined) {
      this.data = InboxLedgerSchema.parse({});
      return this.data;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const parsed = InboxLedgerSchema.safeParse(json);
    if (parsed.success) {
      this.data = parsed.data;
      return this.data;
    }
    // Dedupe then falls back to the pipeline's job store and this desktop's own status files.
    log.warn('sync.inbox.ledger-corrupt', { step: 'load' });
    await fsp.rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {});
    this.data = InboxLedgerSchema.parse({});
    return this.data;
  }

  /** The cached ledger; `load()` must have run. */
  current(): InboxLedgerData {
    if (!this.data) throw new Error('Inbox ledger not loaded');
    return this.data;
  }

  entry(jobId: string): LedgerEntry | undefined {
    return this.data?.jobs[jobId];
  }

  /** Applies `fn` to a copy and saves it; the cache changes only after the write succeeded. */
  update(fn: (d: InboxLedgerData) => InboxLedgerData | void): Promise<InboxLedgerData> {
    const run = this.chain.then(async () => {
      const base = await this.load();
      const draft = structuredClone(base);
      const next = InboxLedgerSchema.parse(fn(draft) ?? draft);
      await fsp.mkdir(this.opts.dir, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(this.file, next);
      this.data = next;
      return next;
    });
    this.chain = run.catch(() => {});
    return run;
  }
}
