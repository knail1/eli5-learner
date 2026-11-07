/**
 * Change labels, and the legacy single prior version (09 §4.1.1). Earlier builds kept one prior
 * version in `<slug>/.prev/` (index.html, meta.json, state.json). The version tree (./versions)
 * reads it once to seed a document's tree, then removes it; nothing writes `.prev/` any more.
 * Reconcile's housekeeping still removes `.prev.tmp-*` folders an older build left behind.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
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
