/// <reference lib="dom" />
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type IpcChannel, type IpcResult, type ScrollToEvent } from './contract';
import type { Eli5DocApi } from './api';

/**
 * window.eli5Doc for the document viewer (01 §5.3, 08 §4.3). The slug is taken from the loaded
 * eli5doc://doc/<slug>/ URL, so the page cannot target a different document. Paid actions need
 * transient user activation, and requests are shape-checked before any IPC; main re-validates.
 */
function currentSlug(): string {
  const m = /^\/([^/]+)\//.exec(location.pathname);
  return m ? decodeURIComponent(m[1]!) : '';
}

// 08 §3 / 07 §4: the same bounds main's zod schemas enforce (src/main/ipc/doc.ts).
const SECTION_ID_RE = /^sec-([a-z][a-z0-9]{1,15})-[0-9a-f]{8}$/;
const TAB_KEY_RE = /^(indepth|eli5|sx[0-9a-f]{6})$/;
const SECTION_ELI5_TAB_KEY_RE = /^sx[0-9a-f]{6}$/;
const ACTIONS = ['expand', 'reexplain', 'analogy', 'deeper'];
/** 08 §4.3 item 4. */
const SCROLL_BUFFER_MS = 5000;

type Result = Promise<IpcResult<never>>;
const refuse = (code: 'E_FORBIDDEN' | 'E_BAD_REQUEST', message: string): Result =>
  Promise.resolve({ ok: false, error: { code, message } });
const forbidden = (): Result => refuse('E_FORBIDDEN', 'Forbidden');
const badRequest = (): Result => refuse('E_BAD_REQUEST', 'Invalid request');

/** 08 §4.3 item 2: a script in the document cannot trigger paid LLM calls on its own. */
function activated(): boolean {
  return (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive === true;
}

interface ActFields {
  tabKey?: unknown;
  sectionId?: unknown;
  selectionText?: unknown;
  note?: unknown;
  action?: unknown;
}

function validAct(r: ActFields, needsAction: boolean): boolean {
  if (typeof r.tabKey !== 'string' || !TAB_KEY_RE.test(r.tabKey)) return false;
  const m = typeof r.sectionId === 'string' ? SECTION_ID_RE.exec(r.sectionId) : null;
  if (!m || m[1] !== r.tabKey) return false;
  if (typeof r.selectionText !== 'string' || r.selectionText.length > 4000 || r.selectionText.trim().length < 3)
    return false;
  if (r.note !== undefined && (typeof r.note !== 'string' || r.note.length > 200 || /[\r\n]/.test(r.note)))
    return false;
  return !needsAction || (typeof r.action === 'string' && ACTIONS.includes(r.action));
}

const invoke = (ch: IpcChannel, payload?: unknown) => ipcRenderer.invoke(ch, payload);
const on =
  <T>(ch: IpcChannel) =>
  (cb: (e: T) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
    ipcRenderer.on(ch, listener);
    return () => ipcRenderer.removeListener(ch, listener);
  };

// 08 §4.3 item 4: main may send scroll-to before the runtime subscribes; keep the latest for 5 s.
// Each page load gets a fresh preload, so a buffered event always belongs to the current load.
const scrollSubs = new Set<(e: ScrollToEvent) => void>();
let buffered: { e: ScrollToEvent; at: number } | undefined;
ipcRenderer.on(IPC.doc.scrollTo, (_e: IpcRendererEvent, payload: ScrollToEvent) => {
  if (scrollSubs.size === 0) buffered = { e: payload, at: Date.now() };
  for (const cb of [...scrollSubs]) cb(payload);
});

/** Copies only the known fields, so page objects never cross the bridge as-is. */
function actPayload(r: ActFields, withAction: boolean): Record<string, unknown> {
  return {
    tabKey: r.tabKey,
    sectionId: r.sectionId,
    ...(withAction ? { action: r.action } : {}),
    selectionText: r.selectionText,
    ...(r.note !== undefined ? { note: r.note } : {}),
    slug: currentSlug(),
  };
}

const api: Eli5DocApi = {
  regenerateSection: (r) => {
    if (!activated()) return forbidden();
    if (!validAct(r, true)) return badRequest();
    return invoke(IPC.doc.regenerateSection, actPayload(r, true));
  },
  createSectionEli5: (r) => {
    if (!activated()) return forbidden();
    if (!validAct(r, false)) return badRequest();
    return invoke(IPC.doc.createSectionEli5, actPayload(r, false));
  },
  closeTab: (tabKey) => {
    if (!activated()) return forbidden();
    if (typeof tabKey !== 'string' || !SECTION_ELI5_TAB_KEY_RE.test(tabKey)) return badRequest();
    return invoke(IPC.doc.closeTab, { slug: currentSlug(), tabKey });
  },
  openExternal: (url) => invoke(IPC.viewer.openExternal, { url }),
  onScrollTo: (cb) => {
    scrollSubs.add(cb);
    const b = buffered;
    buffered = undefined;
    if (b && Date.now() - b.at <= SCROLL_BUFFER_MS) cb(b.e);
    return () => scrollSubs.delete(cb);
  },
  onSectionBusy: on(IPC.doc.sectionBusy),
};

if (location.protocol === 'eli5doc:' && location.hostname === 'doc') {
  contextBridge.exposeInMainWorld('eli5Doc', api);
}
