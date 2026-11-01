import type { IpcError, SourceInput, SourceOrigin, StartJobRequest } from '../../../preload/contract';
import { newDraftId, newInputId } from '../ids';
import type { InputDraft } from './types';

/** Pure input-zone helpers (11 §5.4). */

export function newDraft(glossary: boolean): InputDraft {
  return { draftId: newDraftId(), inputs: [], lastRun: [], urlText: '', clarifying: '', glossary };
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

/**
 * The primary button (11 §5.4): **Start** sends the chips when there are chips or typed text;
 * otherwise **Run again** re-sends the last run's URLs; otherwise Start, which shows the usual hint.
 */
export function primaryAction(d: InputDraft): 'start' | 'run-again' {
  if (d.inputs.length > 0 || d.urlText.trim() !== '') return 'start';
  return d.lastRun.length > 0 ? 'run-again' : 'start';
}

export const RUN_AGAIN_TOOLTIP = "Send the last run's links again";

/** URL inputs only, each with a fresh id, so a re-sent link is a new input (11 §5.4). */
export function freshUrls(inputs: readonly SourceInput[]): SourceInput[] {
  return inputs.flatMap((i) => (i.kind === 'url' ? [{ ...i, id: newInputId() }] : []));
}

/**
 * The draft after a successful start (11 §5.4 step 5). Every sent input leaves the chips, and
 * anything added while the start was in flight stays. The sent URLs become the last run (when none
 * were URLs, the previous last run is kept). Specifics and the glossary choice stay. Unsent staged
 * pastes keep the old draft id so their staging folder stays valid; otherwise a new id is taken.
 */
export function draftAfterStart(cur: InputDraft, sent: readonly SourceInput[]): InputDraft {
  const sentIds = new Set(sent.map((i) => i.id));
  const inputs = cur.inputs.filter((i) => !sentIds.has(i.id));
  const urls = sent.filter((i) => i.kind === 'url');
  return {
    ...cur,
    inputs,
    lastRun: urls.length > 0 ? urls : cur.lastRun,
    draftId: inputs.some(isStaged) ? cur.draftId : newDraftId(),
  };
}

/** True when Clear has something to clear. */
export function draftHasContent(d: InputDraft): boolean {
  return d.inputs.length > 0 || d.lastRun.length > 0 || d.urlText.trim() !== '' || d.clarifying.trim() !== '';
}

/**
 * Copies text from the renderer, which has no clipboard permission (12 §7): a one-shot `copy`
 * handler fills the event's clipboardData while execCommand fires it. False when refused.
 */
export function copyText(text: string, doc: Document = document): boolean {
  let done = false;
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
    done = true;
  };
  doc.addEventListener('copy', onCopy, true);
  try {
    doc.execCommand('copy');
  } catch {
    // reported by the return value
  } finally {
    doc.removeEventListener('copy', onCopy, true);
  }
  return done;
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
