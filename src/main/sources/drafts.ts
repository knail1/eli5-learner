/**
 * Pre-job draft staging (03 §6.1, §13; HOOK-SRC-04 public default). Clipboard and dragged-text
 * content is snapshotted at paste time under <userData>/staging/drafts/<draftId>/<inputId>/, one
 * directory per chip so discarding a chip removes exactly its files. Every path is derived here
 * from validated ids; nothing path-like is accepted from the renderer.
 *
 * Lifecycle: a job start copies the staged files into the job (06 §9.2) and leaves the draft alone,
 * because the input zone keeps its draft for Start again or Restart (11 §5.4). A chip's folder goes
 * when the chip is removed, the whole draft when it is cleared (Clear, Cmd+N). The draft itself lives
 * only in the window's memory and never survives a restart, so a draft left on disk by a quit or a
 * crash is an orphan; the startup sweep removes every draft older than this launch.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SourceInput } from './types';

/** 03 §13: draftId and inputId pattern. */
export const DRAFT_ID_RE = /^[a-z0-9-]{1,64}$/;
/** 03 §6.1 step 6: the sweep's default age when no launch time is given. */
export const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Characters of text shown on a paste chip (03 §6.2). */
export const PREVIEW_CHARS = 40;

export class InvalidDraftId extends Error {
  constructor(which: 'draftId' | 'inputId') {
    super(`Invalid ${which}`);
    this.name = 'InvalidDraftId';
  }
}

function assertId(id: string, which: 'draftId' | 'inputId'): void {
  if (typeof id !== 'string' || !DRAFT_ID_RE.test(id)) throw new InvalidDraftId(which);
}

export function draftsRoot(userData: string): string {
  return path.join(userData, 'staging', 'drafts');
}

export function draftDir(userData: string, draftId: string): string {
  assertId(draftId, 'draftId');
  return path.join(draftsRoot(userData), draftId);
}

/** "in-" + 8 hex (03 §2). Main mints ids for inputs it creates (clipboard reads). */
export function mintInputId(): string {
  return `in-${randomBytes(4).toString('hex')}`;
}

/** `Pasted text: <first 40 chars>…` (03 §6.2), whitespace collapsed. */
export function textPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const cut = Array.from(flat);
  return cut.length > PREVIEW_CHARS ? `Pasted text: ${cut.slice(0, PREVIEW_CHARS).join('')}…` : `Pasted text: ${flat}`;
}

/** `Pasted image HH:MM` in local time (03 §6.2). */
export function imagePreview(now: Date): string {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `Pasted image ${hh}:${mm}`;
}

/**
 * Write one staged item as <draft>/<inputId>/pasted-<n>.<ext>, n = 1 + items already in the draft.
 * Returns the absolute staged path.
 */
export async function stageDraftItem(
  userData: string,
  draftId: string,
  inputId: string,
  ext: 'txt' | 'html' | 'png',
  data: string | Buffer,
): Promise<string> {
  assertId(inputId, 'inputId');
  const dir = draftDir(userData, draftId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const n = (await readdir(dir)).length + 1;
  const itemDir = path.join(dir, inputId);
  await mkdir(itemDir, { recursive: true, mode: 0o700 });
  const file = path.join(itemDir, `pasted-${n}.${ext}`);
  await writeFile(file, data, { mode: 0o600 });
  return file;
}

export interface StageTextRequest {
  draftId: string;
  text: string;
  markup: 'plain' | 'html';
  /** Visible text for the chip preview when `text` is HTML; defaults to tag-stripped `text`. */
  previewText?: string;
}

/** eli5:sources:stage-text (03 §6.3, §13): stage dragged or pasted text as a `text` input. */
export async function stageText(
  userData: string,
  req: StageTextRequest,
  opts: { inputId?: string } = {},
): Promise<Extract<SourceInput, { kind: 'text' }>> {
  const id = opts.inputId ?? mintInputId();
  const stagedPath = await stageDraftItem(userData, req.draftId, id, req.markup === 'html' ? 'html' : 'txt', req.text);
  const visible = req.previewText ?? (req.markup === 'html' ? req.text.replace(/<[^>]*>/g, ' ') : req.text);
  return { id, kind: 'text', origin: 'paste', stagedPath, markup: req.markup, preview: textPreview(visible) };
}

/** Stage a PNG from the clipboard image branch (03 §6.2 step 3). */
export async function stageImage(
  userData: string,
  draftId: string,
  png: Buffer,
  opts: { inputId?: string; now?: Date } = {},
): Promise<Extract<SourceInput, { kind: 'image' }>> {
  const id = opts.inputId ?? mintInputId();
  const stagedPath = await stageDraftItem(userData, draftId, id, 'png', png);
  return {
    id,
    kind: 'image',
    origin: 'paste',
    stagedPath,
    mediaType: 'image/png',
    preview: imagePreview(opts.now ?? new Date()),
  };
}

/** eli5:sources:discard: delete one chip's staged files. Missing is fine (idempotent). */
export async function discardInput(userData: string, draftId: string, inputId: string): Promise<void> {
  assertId(inputId, 'inputId');
  await rm(path.join(draftDir(userData, draftId), inputId), { recursive: true, force: true });
}

/** eli5:sources:discard-draft: delete a whole draft (input zone cleared with Clear or Cmd+N). */
export async function discardDraft(userData: string, draftId: string): Promise<void> {
  await rm(draftDir(userData, draftId), { recursive: true, force: true });
}

/**
 * Startup sweep (03 §6.1 step 6): delete every drafts/* directory whose mtime is before `before`
 * (default: `maxAgeMs`, 24 h, before `now`). Main passes the process start time, because drafts never
 * outlive the window session: anything older is an orphan, and the live draft, created after launch,
 * is never touched. Returns the count removed.
 */
export async function sweepStaleDrafts(
  userData: string,
  opts: { now?: number; maxAgeMs?: number; before?: number } = {},
): Promise<number> {
  const root = draftsRoot(userData);
  const cutoff = opts.before ?? (opts.now ?? Date.now()) - (opts.maxAgeMs ?? DRAFT_MAX_AGE_MS);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return 0; // no drafts root yet
  }
  let removed = 0;
  for (const name of names) {
    const full = path.join(root, name);
    try {
      const st = await stat(full);
      if (!st.isDirectory() || st.mtimeMs >= cutoff) continue;
      await rm(full, { recursive: true, force: true });
      removed++;
    } catch {
      // Raced with another deletion; nothing to do.
    }
  }
  return removed;
}
