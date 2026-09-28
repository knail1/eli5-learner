// Input snapshots at enqueue (06 §9.2): make a job independent of the outside world.
import { constants as fsConst } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { draftDir, draftsRoot, normalizeUrl } from '../sources';
import type { SourceInput } from './types';

const DIR_MODE = 0o700;

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

export interface SnapshotOptions {
  /** `<userData>/jobs/<jobId>/`. */
  stagingDir: string;
  userData: string;
  /** Files at or under this size are copied (APFS clone); larger ones are referenced (HOOK-PIPE-01). */
  copyMaxBytes: number;
  draftId?: string;
}

/**
 * 06 §9.2: dropped files ≤ copyMaxBytes are cloned into inputs/ (`COPYFILE_FICLONE` falls back to a
 * plain copy off APFS), larger ones are recorded by size and mtime; staged clipboard drafts move into
 * inputs/; URLs are strings only. A file that cannot be read here is left without a snapshot, so the
 * file resolver reports why (03 §5.1). Staged paths outside the drafts root are never moved.
 */
export async function snapshotInputs(inputs: readonly SourceInput[], o: SnapshotOptions): Promise<SourceInput[]> {
  const dir = path.join(o.stagingDir, 'inputs');
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  const drafts = draftsRoot(o.userData);
  const out: SourceInput[] = [];
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
        try {
          await copyFile(input.path, copyPath, fsConst.COPYFILE_FICLONE);
          out.push({ ...input, snapshot: { ...snapshot, copyPath } });
        } catch {
          out.push({ ...input, snapshot });
        }
        break;
      }
      case 'text':
      case 'image': {
        if (!within(drafts, input.stagedPath)) {
          out.push(input); // not ours to move; the clipboard resolver refuses it (03 §6.4)
          break;
        }
        const target = path.join(dir, snapshotName(index, input.stagedPath));
        try {
          await rename(input.stagedPath, target);
        } catch {
          await copyFile(input.stagedPath, target).catch(() => undefined);
        }
        out.push({ ...input, stagedPath: target });
        break;
      }
    }
  }
  if (o.draftId) {
    await rm(draftDir(o.userData, o.draftId), { recursive: true, force: true }).catch(() => undefined);
  }
  return out;
}
