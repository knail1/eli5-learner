/// <reference lib="dom" />
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type IpcChannel } from './contract';
import type { Eli5DocApi } from './api';

/**
 * window.eli5Doc for the document viewer (01 §5.3). The slug is taken from the loaded
 * eli5doc://doc/<slug>/ URL, so the page cannot target a different document.
 */
function currentSlug(): string {
  const m = /^\/([^/]+)\//.exec(location.pathname);
  return m ? decodeURIComponent(m[1]!) : '';
}

const invoke = (ch: IpcChannel, payload?: unknown) => ipcRenderer.invoke(ch, payload);
const on =
  <T>(ch: IpcChannel) =>
  (cb: (e: T) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
    ipcRenderer.on(ch, listener);
    return () => ipcRenderer.removeListener(ch, listener);
  };

const api: Eli5DocApi = {
  regenerateSection: (r) => invoke(IPC.doc.regenerateSection, { ...r, slug: currentSlug() }),
  createSectionEli5: (r) => invoke(IPC.doc.createSectionEli5, { ...r, slug: currentSlug() }),
  closeTab: (tabKey) => invoke(IPC.doc.closeTab, { slug: currentSlug(), tabKey }),
  openExternal: (url) => invoke(IPC.viewer.openExternal, { url }),
  onScrollTo: on(IPC.doc.scrollTo),
  onSectionBusy: on(IPC.doc.sectionBusy),
};

if (location.protocol === 'eli5doc:' && location.hostname === 'doc') {
  contextBridge.exposeInMainWorld('eli5Doc', api);
}
