import type { WebContents } from 'electron';
import { z } from 'zod';
import {
  IPC,
  VIEWER_CHANNELS,
  type AuthStatus,
  type EditionInfo,
  type IpcChannel,
  type ModelsResult,
  type TestConnectionResult,
} from '../../preload/contract';
import { ProviderIdSchema } from '../config';
import type { SettingsStore } from '../config';
import { account, type KeyStore } from '../config';
import type { Registry } from '../editions';
import { suggestedModels } from '../llm';
import { ContextMenuRequest, handleContextMenu } from '../shell';
import { safeOpenExternal } from '../security';
import type { ClipboardPort } from '../sources';
import { DropRegistry } from './drops';
import { fail, makeHandle, NoPayload, type HandlerRegistrar, type Register, type SenderIdentity } from './handle';
import { registerJobsIpc, type JobsPort } from './jobs';
import { registerLibraryIpc, type DocumentActions, type LibraryPort } from './library';
import { registerSettingsIpc } from './settings';
import { registerSourcesIpc } from './sources';

export { assertSender, toIpcError, IpcFailure, fail, makeHandle, NO_API_KEY } from './handle';
export type { SenderIdentity, HandlerRegistrar } from './handle';
export { DropRegistry } from './drops';
export { authorizeInputs } from './jobs';
export type { JobsPort } from './jobs';
export { docUrl, openInViewer } from './library';
export { snapshotClipboard } from './clipboard';
export { createQuitHandler, QUIT_BOUND_MS } from './quit';
export type { QuitStep } from './quit';
export type { AsyncClipboard } from './clipboard';
export type { LibraryPort, DocumentActions } from './library';

export interface IpcDeps {
  ipc: HandlerRegistrar;
  ids: SenderIdentity;
  settings: SettingsStore;
  keyStore: KeyStore;
  registry: Registry;
  viewer: {
    setBounds(b: { x: number; y: number; width: number; height: number }): void;
    setVisible(v: boolean): void;
  };
  /** Push an event to the app renderer. */
  sendToApp(channel: IpcChannel, payload: unknown): void;
  /** 06 JobQueue (M2). */
  jobs: JobsPort;
  /** 09 FsLibrary. */
  library: LibraryPort;
  /** Viewer load and Finder reveal for `eli5:library:open` / `reveal`. */
  documents: DocumentActions;
  /** 03 §13 draft staging root and the clipboard; `drops` defaults to a fresh registry. */
  sources: { userData: string; clipboard: () => ClipboardPort | Promise<ClipboardPort>; drops?: DropRegistry };
  /** 01 §6.2 pre-check for `eli5:jobs:start`: false yields E_NO_API_KEY. */
  apiKeyReady(): Promise<boolean>;
}

/** 01 §6.2: the Keychain holds a key for `provider`; providers without a Keychain key need none. */
export async function providerKeyPresent(provider: string, keyStore: Pick<KeyStore, 'has'>): Promise<boolean> {
  if (provider !== 'claude' && provider !== 'openai') return true;
  return keyStore.has(account(provider));
}

const Bounds = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(0),
  height: z.number().finite().min(0),
});

/**
 * Registers every channel in 01 §5.2 and the M→R pushes. Channels owned by later milestones answer
 * "not implemented". Returns a function that detaches the event subscriptions.
 */
export function registerIpc(d: IpcDeps): () => void {
  const handle = makeHandle(d.ipc, d.ids);
  const implemented = new Set<string>();
  const on: Register = (channel, schema, fn) => {
    implemented.add(channel);
    handle(channel, VIEWER_CHANNELS.includes(channel) ? 'viewer' : 'app', schema, fn);
  };
  const drops = d.sources.drops ?? new DropRegistry();

  // ---- jobs (06 §11), sources (03 §13), library (09 §11) ----
  registerJobsIpc(on, { jobs: d.jobs, drops, userData: d.sources.userData, apiKeyReady: d.apiKeyReady });
  registerSourcesIpc(on, { userData: d.sources.userData, clipboard: d.sources.clipboard, drops });
  registerLibraryIpc(on, { library: d.library, documents: d.documents });

  // ---- settings (12 §5) ----
  registerSettingsIpc(on, { settings: d.settings, keyStore: d.keyStore, registry: d.registry });

  // ---- edition (01 §6.2) ----
  on(IPC.edition.info, NoPayload, (): EditionInfo => d.registry.info());

  // ---- auth (03 §12): public broker reports 'unavailable'; sign-in throws NotAvailableInEdition ----
  on(IPC.auth.status, NoPayload, (): AuthStatus => d.registry.auth().status());
  on(IPC.auth.signIn, NoPayload, (): Promise<AuthStatus> => d.registry.auth().signIn());
  on(IPC.auth.signOut, NoPayload, (): Promise<AuthStatus> => d.registry.auth().signOut());

  // ---- llm (02 §14) ----
  on(IPC.llm.testConnection, z.object({ provider: ProviderIdSchema.optional() }).optional(), async () => {
    const provider = d.settings.get().llm.provider;
    if (provider !== 'bedrock' && !(await d.keyStore.has(account(provider)))) {
      fail('E_NO_API_KEY', 'Add an API key in Settings');
    }
    const r = await d.registry.llm().testConnection();
    const out: TestConnectionResult = r.ok ? { ok: true, model: r.model } : { ok: false, message: r.error.message };
    return out;
  });
  on(IPC.llm.models, z.object({ provider: ProviderIdSchema }), (p): ModelsResult => suggestedModels(p.provider));

  // ---- viewer (11) ----
  on(IPC.viewer.setBounds, Bounds, (b) => d.viewer.setBounds(b));
  on(IPC.viewer.setVisible, z.object({ visible: z.boolean() }), (p) => d.viewer.setVisible(p.visible));
  on(IPC.viewer.openExternal, z.object({ url: z.string().max(2048) }), async (p, e) => {
    if (!(await safeOpenExternal(p.url, e.sender.id))) fail('E_RATE_LIMITED', 'Link not opened');
  });

  // ---- app (11 §10): the Library item menu; Open/Reveal go through the shell hooks ----
  on(IPC.app.contextMenu, ContextMenuRequest, (r) => handleContextMenu(r));

  // ---- test-only channel, compiled out of packaged builds (01 §8.1) ----
  if (__ELI5_TEST__) {
    implemented.add(IPC.test.trayClick);
  }

  // ---- everything else: owned by M1+ modules, registered so the preload API is total ----
  for (const channel of invokableChannels()) {
    if (implemented.has(channel)) continue;
    handle(channel, VIEWER_CHANNELS.includes(channel) ? 'viewer' : 'app', z.unknown(), () =>
      fail('E_INTERNAL', 'Not implemented yet'),
    );
  }

  // ---- M→R pushes: only ever sent to the app renderer (sendToApp) ----
  const subs = [
    d.jobs.on('changed', (s) => d.sendToApp(IPC.jobs.changed, s)),
    d.library.on('changed', () => d.sendToApp(IPC.library.changed, { entries: d.library.list() })),
    d.settings.onChanged((settings, changed) => d.sendToApp(IPC.settings.changed, { changed, settings })),
  ];
  return () => {
    for (const off of subs.splice(0)) off();
  };
}

/** Event channels (M→R, M→D) are not invokable. */
const EVENT_CHANNELS = new Set<string>([
  IPC.jobs.changed,
  IPC.auth.changed,
  IPC.library.changed,
  IPC.suggestions.changed,
  IPC.doc.updated,
  IPC.doc.scrollTo,
  IPC.doc.sectionBusy,
  IPC.app.navigate,
  IPC.settings.changed,
  IPC.publish.progress,
  IPC.test.trayClick,
]);

export function invokableChannels(): IpcChannel[] {
  const all: IpcChannel[] = [];
  for (const group of Object.values(IPC)) for (const ch of Object.values(group)) all.push(ch as IpcChannel);
  return all.filter((c) => !EVENT_CHANNELS.has(c));
}

/** Convenience for SenderIdentity implementations. */
export function sameContents(a: WebContents | undefined, b: WebContents | undefined): boolean {
  return !!a && !!b && a.id === b.id;
}
