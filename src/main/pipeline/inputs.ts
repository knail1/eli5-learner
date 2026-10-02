// Input snapshots at enqueue (06 §9.2): make a job independent of the outside world.
import { constants as fsConst } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { draftsRoot, normalizeUrl } from '../sources';
import type { SourceInput } from './types';

const DIR_MODE = 0o700;
/**
 * Files up to this size that cannot be force-cloned are copied inline: even a full copy takes well
 * under the 1 s `jobs:start` budget (06 acceptance). Node has no forced clone on macOS (ENOSYS), where
 * COPYFILE_FICLONE still clones on APFS. Larger files are copied in the background (06 §9.2).
 */
export const INLINE_COPY_MAX_BYTES = 8 * 1024 * 1024;

/** Snapshot file name: `<index>-<basename>` (06 §9.2). */
function snapshotName(index: number, p: string): string {
  const base =
    [...path.basename(p)].map((c) => (c.charCodeAt(0) < 0x20 || c === '/' || c === '\\' ? '_' : c)).join('') || 'input';
  return `${index}-${base}`;
}

function within(root: string, p: string): boolean {
  const rel = path.relative(root, path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Exact duplicates within one job are dropped silently (06 §12); content-level dedupe is 03 §4's. */
export function dedupeInputs(inputs: readonly SourceInput[]): SourceInput[] {
  const seen = new Set<string>();
  return inputs.filter((i) => {
    let key: string;
    switch (i.kind) {
      case 'file':
        key = `file:${path.resolve(i.path)}`;
        break;
      case 'url': {
        const n = normalizeUrl(i.url);
        key = `url:${n.ok ? n.key : i.url.trim()}`;
        break;
      }
      default:
        key = `${i.kind}:${i.stagedPath}`;
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** fs.copyFile's shape; injected in tests (13 §3.2). */
export type CopyFileFn = (src: string, dst: string, mode?: number) => Promise<void>;

/** A copy that could not be cloned; it runs in the background after `jobs:start` returns (06 §9.2). */
export interface PendingCopy {
  index: number;
  src: string;
  dst: string;
}

export interface SnapshotResult {
  inputs: SourceInput[];
  pending: PendingCopy[];
}

export interface SnapshotOptions {
  /** `<userData>/jobs/<jobId>/`. */
  stagingDir: string;
  userData: string;
  /** Files at or under this size are copied (APFS clone); larger ones are referenced (HOOK-PIPE-01). */
  copyMaxBytes: number;
  copyFile?: CopyFileFn;
  /** Default INLINE_COPY_MAX_BYTES. */
  inlineCopyMaxBytes?: number;
}

/**
 * 06 §9.2: dropped files ≤ copyMaxBytes are cloned into inputs/ (`COPYFILE_FICLONE_FORCE`). When a
 * clone is not possible, small files are copied inline and larger ones are returned as pending copies
 * for the queue to run in the background, so `jobs:start` never waits for a long copy (06 §5.1
 * step 2). Files over copyMaxBytes are
 * recorded by size and mtime; staged clipboard drafts are copied into inputs/ (the draft keeps its own
 * files, so the input zone can Start or Restart it again, 11 §5.4; 03 §13 owns their deletion); URLs
 * are strings only. A file that cannot be read here is left without a snapshot, so the file resolver
 * reports why (03 §5.1). Staged paths outside the drafts root are never copied.
 */
export async function snapshotInputs(inputs: readonly SourceInput[], o: SnapshotOptions): Promise<SnapshotResult> {
  const dir = path.join(o.stagingDir, 'inputs');
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  const drafts = draftsRoot(o.userData);
  const copy = o.copyFile ?? copyFile;
  const out: SourceInput[] = [];
  const pending: PendingCopy[] = [];
  for (const [index, input] of inputs.entries()) {
    switch (input.kind) {
      case 'url':
        out.push(input);
        break;
      case 'file': {
        const st = await stat(input.path).catch(() => undefined);
        if (!st?.isFile()) {
          out.push(input); // folders expand in place; missing files are skipped by the resolver
          break;
        }
        const snapshot = { sizeBytes: st.size, mtimeMs: st.mtimeMs };
        if (st.size > o.copyMaxBytes) {
          out.push({ ...input, snapshot });
          break;
        }
        const copyPath = path.join(dir, snapshotName(index, input.path));
        const inline = st.size <= (o.inlineCopyMaxBytes ?? INLINE_COPY_MAX_BYTES);
        try {
          await copy(input.path, copyPath, fsConst.COPYFILE_FICLONE_FORCE);
          out.push({ ...input, snapshot: { ...snapshot, copyPath } });
          break;
        } catch {
          // No forced clone here (another volume, non-APFS, or a platform without it).
        }
        if (!inline) {
          out.push({ ...input, snapshot });
          pending.push({ index, src: input.path, dst: copyPath });
          break;
        }
        try {
          await copy(input.path, copyPath, fsConst.COPYFILE_FICLONE);
          out.push({ ...input, snapshot: { ...snapshot, copyPath } });
        } catch {
          out.push({ ...input, snapshot });
        }
        break;
      }
      case 'text':
      case 'image': {
        if (!within(drafts, input.stagedPath)) {
          out.push(input); // not ours to copy; the clipboard resolver refuses it (03 §6.4)
          break;
        }
        // A copy, never a move: the draft's chip stays usable for another start. Pastes are small,
        // and on APFS the clone is free. A failed copy leaves the target missing, and the clipboard
        // resolver skips it with its reason (03 §6.4).
        const target = path.join(dir, snapshotName(index, input.stagedPath));
        await copyFile(input.stagedPath, target, fsConst.COPYFILE_FICLONE).catch(() => undefined);
        out.push({ ...input, stagedPath: target });
        break;
      }
    }
  }
  return { inputs: out, pending };
}

/**
 * Runs one pending copy (06 §9.2): writes `<dst>.part` and renames it, so a crash never leaves a
 * short file at `dst`. Resolves true on success; the caller sets `copyPath` either way, so a failed
 * copy is skipped by the file resolver as `file changed or moved` (03 §5.1 step 0).
 */
export async function runPendingCopy(p: PendingCopy, copy: CopyFileFn = copyFile): Promise<boolean> {
  const part = `${p.dst}.part`;
  try {
    await copy(p.src, part, fsConst.COPYFILE_FICLONE);
    await rename(part, p.dst);
    return true;
  } catch {
    await rm(part, { force: true }).catch(() => undefined);
    return false;
  }
}
