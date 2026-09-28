/// <reference lib="dom" />
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { IPC, type DropRegistration, type IpcChannel, type IpcResult, type StartJobRequest } from './contract';
import type { Eli5Api } from './api';

/** Marshalling only; no logic (01 §2). */
const invoke = (ch: IpcChannel, payload?: unknown) => ipcRenderer.invoke(ch, payload);
const on =
  <T>(ch: IpcChannel) =>
  (cb: (e: T) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
    ipcRenderer.on(ch, listener);
    return () => ipcRenderer.removeListener(ch, listener);
  };

/**
 * 06 §11: main's opaque id for each path of a trusted drop, keyed by path. The renderer keeps
 * working with paths; jobs.start swaps in the id main minted, and main reads only its own path.
 */
const dropIds = new Map<string, string>();
let pendingDrops: Promise<void> = Promise.resolve();

function withDropIds(r: StartJobRequest): StartJobRequest {
  return {
    ...r,
    inputs: r.inputs.map((i) => {
      const id = i.kind === 'file' && i.origin === 'drop' ? dropIds.get(i.path) : undefined;
      return id === undefined ? i : { ...i, id };
    }),
  };
}

const api: Eli5Api = {
  jobs: {
    start: async (r) => {
      await pendingDrops;
      return invoke(IPC.jobs.start, withDropIds(r));
    },
    list: () => invoke(IPC.jobs.list),
    cancel: (jobId) => invoke(IPC.jobs.cancel, { jobId }),
    retry: (jobId) => invoke(IPC.jobs.retry, { jobId }),
    dismiss: (jobId) => invoke(IPC.jobs.dismiss, { jobId }),
    onChanged: on(IPC.jobs.changed),
  },
  sources: {
    readClipboard: (draftId) => invoke(IPC.sources.readClipboard, { draftId }),
    stageText: (draftId, text, markup) => invoke(IPC.sources.stageText, { draftId, text, markup }),
    discard: (draftId, inputId) => invoke(IPC.sources.discard, { draftId, inputId }),
    discardDraft: (draftId) => invoke(IPC.sources.discardDraft, { draftId }),
  },
  library: {
    list: () => invoke(IPC.library.list),
    open: (slug) => invoke(IPC.library.open, { slug }),
    reveal: (slug) => invoke(IPC.library.reveal, { slug }),
    info: () => invoke(IPC.library.info),
    onChanged: on(IPC.library.changed),
  },
  suggestions: {
    list: () => invoke(IPC.suggestions.list),
    accept: (suggestionId) => invoke(IPC.suggestions.accept, { suggestionId }),
    dismiss: (suggestionId) => invoke(IPC.suggestions.dismiss, { suggestionId }),
    onChanged: on(IPC.suggestions.changed),
  },
  doc: { onUpdated: on(IPC.doc.updated) },
  viewer: {
    setBounds: (r) => invoke(IPC.viewer.setBounds, r),
    setVisible: (visible) => invoke(IPC.viewer.setVisible, { visible }),
  },
  llm: {
    testConnection: (provider) => invoke(IPC.llm.testConnection, provider ? { provider } : undefined),
    models: (provider) => invoke(IPC.llm.models, { provider }),
  },
  settings: {
    get: () => invoke(IPC.settings.get),
    set: (p) => invoke(IPC.settings.set, p),
    describe: () => invoke(IPC.settings.describe),
    setApiKey: (provider, key) => invoke(IPC.settings.setApiKey, { provider, key }),
    hasApiKey: (provider) => invoke(IPC.settings.hasApiKey, { provider }),
    clearApiKey: (provider) => invoke(IPC.settings.clearApiKey, { provider }),
    onChanged: on(IPC.settings.changed),
  },
  edition: { info: () => invoke(IPC.edition.info) },
  publish: {
    targets: (slug) => invoke(IPC.publish.targets, { slug }),
    run: (slug, targetId) => invoke(IPC.publish.run, { slug, targetId }),
    history: (slug) => invoke(IPC.publish.history, { slug }),
    cancel: (slug, targetId) => invoke(IPC.publish.cancel, { slug, targetId }),
    copyLink: (url) => invoke(IPC.publish.copyLink, { url }),
    openLink: (url) => invoke(IPC.publish.openLink, { url }),
    reveal: (url) => invoke(IPC.publish.reveal, { url }),
    onProgress: on(IPC.publish.progress),
  },
  auth: {
    status: () => invoke(IPC.auth.status),
    signIn: () => invoke(IPC.auth.signIn),
    signOut: () => invoke(IPC.auth.signOut),
    onChanged: on(IPC.auth.changed),
  },
  app: {
    onNavigate: on(IPC.app.navigate),
    contextMenu: (r) => invoke(IPC.app.contextMenu, r),
  },
  files: { pathFor: (file) => webUtils.getPathForFile(file) },
};

contextBridge.exposeInMainWorld('eli5', api);

/**
 * 06 §11, 03 §6.3: main never trusts a raw path from the page. This capture-phase listener runs in
 * the isolated world before the renderer's own drop handler, ignores synthetic events, and tells
 * main which paths a real drop produced; main answers with the ids `eli5:jobs:start` must carry.
 */
window.addEventListener(
  'drop',
  (e: DragEvent) => {
    if (!e.isTrusted) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    const paths = files.map((f) => webUtils.getPathForFile(f)).filter((p) => p !== '');
    if (paths.length === 0) return;
    const registered = (invoke(IPC.sources.registerDrop, { paths }) as Promise<IpcResult<DropRegistration[]>>).then(
      (res) => {
        if (res.ok) for (const reg of res.value) dropIds.set(reg.path, reg.inputId);
      },
      () => undefined,
    );
    pendingDrops = pendingDrops.then(() => registered);
  },
  true,
);
