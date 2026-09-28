/**
 * The single prior version of a document (09 §4.1): `<slug>/.prev/` holds index.html, meta.json
 * and state.json. It is staged in a `.prev.tmp-*` folder and swapped in with two renames, always
 * under the document's lock. A crash between the renames leaves no slot (nothing to undo), never
 * a half-written one; reconcile's housekeeping removes the leftover staging folder.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DIR_MODE, fsyncDir, isErrno, tmpPathFor, writeFileAtomic, writeJsonAtomic } from './fs-atomic';
import type { DocHistoryState, PriorVersionState } from './types';

export const PREV_DIR = '.prev';
export const PREV_STATE_FILE = 'state.json';
/** Undo tooltip text when a change supplies no label. */
export const DEFAULT_CHANGE_LABEL = 'last change';
export const MAX_CHANGE_LABEL_CHARS = 200;

const PriorStateSchema = z.object({
  schemaVersion: z.literal(1),
  slot: z.enum(['undo', 'redo']),
  label: z.string().min(1).max(MAX_CHANGE_LABEL_CHARS),
  pairedUpdatedAt: z.string().min(1),
});

/** One line, bounded, never empty. */
export function cleanChangeLabel(label: string | undefined): string {
  const one = (label ?? '').replace(/\s+/g, ' ').trim();
  if (one === '') return DEFAULT_CHANGE_LABEL;
  return one.length > MAX_CHANGE_LABEL_CHARS ? `${one.slice(0, MAX_CHANGE_LABEL_CHARS - 1)}…` : one;
}

/** A heading or title inside a change label: one line, at most `max` characters ("The particular…"). */
export function quoteLabel(name: string, max = 32): string {
  const one = name.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** Writes the version to keep into a fresh `.prev.tmp-*` folder next to `.prev/`. Not installed yet. */
export async function stagePrior(
  docDir: string,
  files: { html: string | Uint8Array; meta: unknown },
  state: PriorVersionState,
): Promise<string> {
  const dir = tmpPathFor(path.join(docDir, PREV_DIR));
  await fsp.mkdir(dir, { mode: DIR_MODE });
  try {
    await writeFileAtomic(path.join(dir, 'index.html'), files.html);
    await writeJsonAtomic(path.join(dir, 'meta.json'), files.meta);
    await writeJsonAtomic(path.join(dir, PREV_STATE_FILE), state);
  } catch (err) {
    await discardStaged(dir);
    throw err;
  }
  return dir;
}

/** Replaces `.prev/` with a staged folder: rename the old one aside, rename the new one in, drop the old. */
export async function installPrior(docDir: string, staged: string): Promise<void> {
  const target = path.join(docDir, PREV_DIR);
  const old = tmpPathFor(target);
  let moved = false;
  try {
    await fsp.rename(target, old);
    moved = true;
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err;
  }
  await fsp.rename(staged, target);
  await fsyncDir(docDir);
  if (moved) await fsp.rm(old, { recursive: true, force: true }).catch(() => {});
}

export function discardStaged(dir: string): Promise<void> {
  return fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** The slot's state when `.prev/` holds a valid state.json and both files; else undefined. */
export async function readPriorState(docDir: string): Promise<PriorVersionState | undefined> {
  const dir = path.join(docDir, PREV_DIR);
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(path.join(dir, PREV_STATE_FILE), 'utf8'));
  } catch {
    return undefined;
  }
  const parsed = PriorStateSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  for (const f of ['index.html', 'meta.json']) {
    const st = await fsp.lstat(path.join(dir, f)).catch(() => undefined);
    if (!st?.isFile()) return undefined;
  }
  return parsed.data;
}

/** The history a slot offers for a live meta with `liveUpdatedAt` (09 §4.1 pairing rule). */
export function historyOf(state: PriorVersionState | undefined, liveUpdatedAt: string): DocHistoryState {
  if (!state || state.pairedUpdatedAt !== liveUpdatedAt) return { canUndo: false, canRedo: false };
  return state.slot === 'undo'
    ? { canUndo: true, canRedo: false, undoLabel: state.label }
    : { canUndo: false, canRedo: true, redoLabel: state.label };
}

/** `.prev.tmp-<pid>-<8 hex>` staging or retired folders (housekeeping, 09 §7 step 8). */
export const PREV_TMP_RE = /^\.prev\.tmp-\d+-[0-9a-f]{8}$/;
