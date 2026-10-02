import type { IpcError, JobStatus, SourceInput, SourceOrigin, StartJobRequest } from '../../../preload/contract';
import { newDraftId, newInputId } from '../ids';
import type { InputDraft } from './types';

/** Pure input-zone helpers (11 §5.4). */

export function newDraft(glossary: boolean): InputDraft {
  return { draftId: newDraftId(), inputs: [], urlText: '', clarifying: '', glossary };
}

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}

/** Whitespace-separated tokens, so pasting several URLs commits each one. */
export function splitTokens(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * The renderer commits http/https URLs directly. Everything else is classified by main
 * (`eli5:sources:classify-text`); in the public build no bare-identifier resolver exists, so any
 * other token is invalid (HOOK-SRC-02, HOOK-SRC-03).
 */
export function commitUrlText(
  text: string,
  origin: SourceOrigin = 'url-field',
): { added: SourceInput[]; invalid: string[] } {
  const added: SourceInput[] = [];
  const invalid: string[] = [];
  for (const t of splitTokens(text)) {
    if (isHttpUrl(t)) added.push({ id: newInputId(), kind: 'url', origin, url: t });
    else invalid.push(t);
  }
  return { added, invalid };
}

export const URL_INVALID_MESSAGE = 'Enter a web address that starts with http:// or https://';

export function fileInput(path: string, origin: SourceOrigin = 'drop'): SourceInput {
  return { id: newInputId(), kind: 'file', origin, path };
}

/**
 * Resolves dropped files to paths with `files.pathFor` (11 §5.4 step 1). A file the preload cannot
 * resolve (it throws or returns '') is reported by name instead of failing the whole drop.
 */
export function resolveDropPaths<F extends { name: string }>(
  files: readonly F[],
  pathFor: (f: F) => string,
): { paths: string[]; failed: string[] } {
  const paths: string[] = [];
  const failed: string[] = [];
  for (const f of files) {
    let p = '';
    try {
      p = pathFor(f);
    } catch {
      // reported below
    }
    if (p) paths.push(p);
    else failed.push(f.name || 'a file');
  }
  return { paths, failed };
}

export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function chipLabel(i: SourceInput): string {
  switch (i.kind) {
    case 'file':
      return baseName(i.path);
    case 'url': {
      try {
        const u = new URL(i.url);
        const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}`;
        return `${u.hostname}${rest}`;
      } catch {
        return i.url;
      }
    }
    case 'text':
    case 'image':
      return i.preview;
  }
}

export function chipIcon(i: SourceInput): string {
  switch (i.kind) {
    case 'file':
      return '▤';
    case 'url':
      return '↗';
    case 'text':
      return '¶';
    case 'image':
      return '▣';
  }
}

/** Staged pastes live under the draft's staging folder and must be discarded when removed (03 §13). */
export const isStaged = (i: SourceInput): boolean => i.kind === 'text' || i.kind === 'image';

/** `eli5:jobs:start` payload: `{inputs, options: {clarifyingInput, glossary}}` (11 §5.4 step 4). */
export function startRequest(d: InputDraft, inputs: SourceInput[]): StartJobRequest {
  const req: StartJobRequest = { inputs, options: { clarifyingInput: d.clarifying.trim(), glossary: d.glossary } };
  if (inputs.some(isStaged)) req.draftId = d.draftId;
  return req;
}

/** A job that can still be cancelled: Restart applies while the draft's last run is one of these. */
export function isRunning(status: JobStatus): boolean {
  return status !== 'done' && status !== 'failed';
}

/** The job last started from the draft and its newest known status (11 §5.4). */
export interface DraftRun {
  jobId: string;
  status: JobStatus;
}

/**
 * The draft survives Start (11 §5.4 step 5), so the primary button either starts another document
 * or, while the run started from this draft is queued or running, restarts it: that run is
 * cancelled and a new one starts with the current inputs.
 */
export function startMode(run: DraftRun | null): 'start' | 'restart' {
  return run && isRunning(run.status) ? 'restart' : 'start';
}

export const RESTART_TOOLTIP = 'Cancel the current run and start again with these inputs';

/** True when Clear has something to clear. */
export function draftHasContent(d: InputDraft): boolean {
  return d.inputs.length > 0 || d.urlText.trim() !== '' || d.clarifying.trim() !== '';
}

/**
 * File chips leaving the draft whose path no remaining chip still names: main may forget their
 * registrations (`sources.release`, 06 §11). Two chips for one dropped path share one registration.
 */
export function filesToRelease(leaving: readonly SourceInput[], remaining: readonly SourceInput[]): SourceInput[] {
  const kept = new Set(remaining.flatMap((i) => (i.kind === 'file' ? [i.path] : [])));
  return leaving.filter((i) => i.kind === 'file' && !kept.has(i.path));
}

/** Inline message for a failed start (11 §5.4 step 6, 01 §6.4). */
export function startErrorMessage(e: IpcError): string {
  return e.code === 'E_NOT_AVAILABLE_IN_EDITION' ? 'Requires the enterprise edition' : e.message;
}

/** Text fields keep native paste (03 §6); anywhere else Cmd+V becomes a clipboard source. */
export function isTextField(el: EventTarget | null): boolean {
  if (!el || typeof (el as Element).tagName !== 'string') return false;
  const e = el as HTMLElement;
  if (e.isContentEditable) return true;
  if (e.tagName === 'TEXTAREA') return true;
  if (e.tagName !== 'INPUT') return false;
  const type = (e as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
}

/** Visible rows for the auto-growing specifics field: 1 to 6. */
export function clarifyRows(text: string): number {
  return Math.min(6, Math.max(1, text.split('\n').length));
}
