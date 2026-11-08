/**
 * Garbage collection plan (16 §4.7). The app-data folder has no trash: delete is permanent. Only the
 * primary deletes, only in a normal state (16 §4.5 step 6), and only what this plan lists:
 *
 * - blobs and trees of documents purged from the desktop Trash, or absent from the manifest for
 *   more than 30 days;
 * - blobs no longer selected by `sync.history` for more than 7 days;
 * - `job`, `att`, `cancel` and `status` files of a job that is terminal and listed in the sender's
 *   `acks-<deviceId>.json`, or terminal for more than 30 days regardless (an attachment goes with
 *   the last job that names it; an attachment no job names is removed after 30 days);
 * - device files and acks of phones not seen for 180 days; claims older than the newest one.
 *
 * The plan is pure. The engine decides when it may run; the store guard decides who may delete.
 */
import type { ClaimRef } from './claims';
import { staleClaims } from './claims';
import type { JobState } from './protocol';
import type { RemoteFile, SyncKind } from './types';

const DAY = 24 * 60 * 60 * 1000;
export const GC_ABSENT_DOC_MS = 30 * DAY;
export const GC_UNSELECTED_BLOB_MS = 7 * DAY;
export const GC_TERMINAL_JOB_MS = 30 * DAY;
export const GC_ORPHAN_ATT_MS = 30 * DAY;
export const GC_PHONE_SILENT_MS = 180 * DAY;

export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set(['done', 'failed', 'rejected', 'cancelled']);

/** What the engine knows about one document id it ever uploaded (or found uploaded). */
export interface GcDoc {
  /** In the current manifest (live or in the desktop Trash). */
  inManifest: boolean;
  /** Purged from the desktop Trash (or emptied with it): collect now. */
  purged: boolean;
  /** Epoch ms since the document left the manifest. */
  absentSinceMs?: number;
  /** Selected shas while in the manifest. */
  selected: ReadonlySet<string>;
  /** Epoch ms since each uploaded sha stopped being selected. */
  unselectedSinceMs: Readonly<Record<string, number>>;
}

export interface GcInput {
  now: number;
  me: string;
  /** Every file the store lists (the engine's index). */
  files: readonly RemoteFile[];
  docs: ReadonlyMap<string, GcDoc>;
  /** Terminal statuses this primary wrote, by job id: when they turned terminal (epoch ms). */
  terminal: ReadonlyMap<string, number>;
  /** Attachment shas each job names (from the job files that still exist). */
  jobAttachments: ReadonlyMap<string, readonly string[]>;
  /** Job ids each phone listed in its acks file, by device id. */
  acks: ReadonlyMap<string, ReadonlySet<string>>;
  /** Devices by id: platform and last heartbeat (epoch ms). */
  devices: ReadonlyMap<string, { platform: 'macos' | 'android'; seenMs: number }>;
  claims: readonly ClaimRef[];
}

export interface GcDeletion {
  fileId: string;
  kind: SyncKind;
  reason: 'doc-gone' | 'unselected' | 'job-done' | 'orphan-att' | 'phone-silent' | 'old-claim';
}

function modifiedMs(f: RemoteFile): number | undefined {
  const t = f.modifiedTime ? Date.parse(f.modifiedTime) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

export function planGc(input: GcInput): GcDeletion[] {
  const out = new Map<string, GcDeletion>();
  const add = (f: RemoteFile, reason: GcDeletion['reason']): void => {
    if (!out.has(f.id)) out.set(f.id, { fileId: f.id, kind: f.props.k, reason });
  };
  const { now, me } = input;

  // Documents: own blobs and trees only.
  for (const f of input.files) {
    if (f.props.dev !== me || (f.props.k !== 'blob' && f.props.k !== 'tree') || !f.props.d) continue;
    const doc = input.docs.get(f.props.d);
    if (!doc) continue; // unknown to the engine: it records the id first and decides on a later pass
    const gone =
      !doc.inManifest &&
      (doc.purged || (doc.absentSinceMs !== undefined && now - doc.absentSinceMs > GC_ABSENT_DOC_MS));
    if (gone) {
      add(f, 'doc-gone');
      continue;
    }
    if (f.props.k === 'blob' && f.props.s && doc.inManifest && !doc.selected.has(f.props.s)) {
      const since = doc.unselectedSinceMs[f.props.s];
      if (since !== undefined && now - since > GC_UNSELECTED_BLOB_MS) add(f, 'unselected');
    }
  }

  // Jobs: terminal and acknowledged by the sender, or terminal for 30 days.
  const jobSender = new Map<string, string>();
  for (const f of input.files) if (f.props.k === 'job' && f.props.s) jobSender.set(f.props.s, f.props.dev);
  const doneJobs = new Set<string>();
  for (const [jobId, at] of input.terminal) {
    const sender = jobSender.get(jobId);
    const acked = sender
      ? (input.acks.get(sender)?.has(jobId) ?? false)
      : [...input.acks.values()].some((a) => a.has(jobId));
    if (acked || now - at > GC_TERMINAL_JOB_MS) doneJobs.add(jobId);
  }
  for (const f of input.files) {
    const k = f.props.k;
    if ((k === 'job' || k === 'cancel' || k === 'status') && f.props.s && doneJobs.has(f.props.s)) add(f, 'job-done');
  }
  // Attachments: named only by collected jobs, or by no job at all for 30 days.
  const keep = new Set<string>();
  const collect = new Set<string>();
  for (const [jobId, shas] of input.jobAttachments) {
    for (const sha of shas) (doneJobs.has(jobId) ? collect : keep).add(sha);
  }
  for (const f of input.files) {
    if (f.props.k !== 'att' || !f.props.s || keep.has(f.props.s)) continue;
    if (collect.has(f.props.s)) {
      add(f, 'job-done');
      continue;
    }
    const at = modifiedMs(f);
    if (at !== undefined && now - at > GC_ORPHAN_ATT_MS) add(f, 'orphan-att');
  }

  // Phones silent for 180 days: their device file and acks.
  const silent = new Set<string>();
  for (const [id, d] of input.devices) {
    if (d.platform === 'android' && now - d.seenMs > GC_PHONE_SILENT_MS) silent.add(id);
  }
  for (const f of input.files) {
    if ((f.props.k === 'device' || f.props.k === 'acks') && silent.has(f.props.dev)) add(f, 'phone-silent');
  }

  // Claims older than the newest one.
  const byId = new Map(input.files.map((f) => [f.id, f]));
  for (const c of staleClaims(input.claims)) {
    const f = byId.get(c.fileId);
    if (f) add(f, 'old-claim');
  }
  return [...out.values()];
}
