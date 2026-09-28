import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { onTestFinished, vi } from 'vitest';
import type { KeyStore, SettingsStore } from '../../../../src/main/config';
import type { Registry } from '../../../../src/main/editions';
import type { IpcServices } from '../../../../src/main/ipc';
import type {
  CatalogEntry,
  IpcResult,
  JobSnapshot,
  LibraryInfo,
  StartJobRequest,
} from '../../../../src/preload/contract';

/** Fakes for registerIpc (01 §5, 06 §11, 09 §11, 03 §13). Import after mocking 'electron'. */

type Listener = (event: unknown, payload: unknown) => Promise<unknown>;

export const APP_ORIGIN = 'http://localhost:5173';

export function snapshot(id: string, status: JobSnapshot['status'] = 'queued'): JobSnapshot {
  return {
    id,
    kind: 'create',
    status,
    statusLine: status === 'queued' ? 'Queued' : 'Reading sources',
    createdAt: '2026-01-02T03:04:05.000Z',
    skippedCount: 0,
    canCancel: true,
    canRetry: false,
    canDismiss: false,
  };
}

export function entry(slug: string): CatalogEntry {
  return {
    id: `id-${slug}`,
    title: slug,
    topicSlug: slug,
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
    summary: 'A summary',
    summarySource: 'llm',
    tabCount: 2,
    mergedFromCount: 0,
  };
}

export class FakeJobs {
  started: StartJobRequest[] = [];
  snapshots: JobSnapshot[] = [];
  private listeners = new Set<(s: JobSnapshot) => void>();
  startImpl: (r: StartJobRequest) => Promise<{ jobId: string }> = async () => ({ jobId: 'job-1' });
  cancel = vi.fn(async (_id: string) => {});
  retry = vi.fn(async (_id: string) => {});
  dismiss = vi.fn(async (_id: string) => {});

  start(r: StartJobRequest): Promise<{ jobId: string }> {
    this.started.push(r);
    return this.startImpl(r);
  }
  list(): JobSnapshot[] {
    return this.snapshots;
  }
  on(_event: 'changed', cb: (s: JobSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(s: JobSnapshot): void {
    for (const cb of this.listeners) cb(s);
  }
  listenerCount(): number {
    return this.listeners.size;
  }
}

export class FakeLibrary {
  entries: CatalogEntry[] = [entry('solar-power'), entry('tax-basics')];
  private listeners = new Set<(e: { reason: 'created'; slugs: string[] }) => void>();
  info(): LibraryInfo {
    return { root: '/tmp/lib', readOnly: false, count: this.entries.length };
  }
  list(): CatalogEntry[] {
    return this.entries;
  }
  hasSlug(slug: string): boolean {
    return this.entries.some((e) => e.topicSlug === slug);
  }
  on(_event: 'changed', cb: (e: { reason: 'created'; slugs: string[] }) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(slugs: string[]): void {
    for (const cb of this.listeners) cb({ reason: 'created', slugs });
  }
}

export class FakeClipboard {
  formats: string[] = [];
  data: Record<string, string> = {};
  text = '';
  html = '';
  availableFormats(): string[] {
    return this.formats;
  }
  read(format: string): string {
    return this.data[format] ?? '';
  }
  readText(): string {
    return this.text;
  }
  readHTML(): string {
    return this.html;
  }
  readImage(): { isEmpty(): boolean; toPNG(): Buffer } {
    return { isEmpty: () => true, toPNG: () => Buffer.alloc(0) };
  }
  readBuffer(): Buffer {
    return Buffer.alloc(0);
  }
}

export async function tmpUserData(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'eli5-ipc-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export interface Harness {
  call<T = unknown>(channel: string, payload?: unknown, from?: 'app' | 'viewer'): Promise<IpcResult<T>>;
  sent: { channel: string; payload: unknown }[];
  /** Pushes to the document viewer (M→D). */
  viewerSent: { channel: string; payload: unknown }[];
  jobs: FakeJobs;
  library: FakeLibrary;
  clipboard: FakeClipboard;
  opened: string[];
  revealed: string[];
  rootRevealed: { count: number };
  keyReady: { value: boolean };
  userData: string;
  dispose: () => void;
  handlers: Map<string, Listener>;
  settings: SettingsStore;
  keyStore: KeyStore;
  registry: Registry;
}

export interface SetupOptions {
  /** Default: a fresh MemoryKeyStore. */
  keyStore?: KeyStore;
  /** M3 service slots; missing ones use the "not implemented" defaults. */
  services?: Partial<IpcServices>;
}

export async function setup(o: SetupOptions = {}): Promise<Harness> {
  const { registerIpc } = await import('../../../../src/main/ipc');
  const { SettingsStore } = await import('../../../../src/main/config');
  const { MemoryKeyStore } = await import('../../../../src/main/config');
  const { Registry } = await import('../../../../src/main/editions');
  const userData = await tmpUserData();
  const handlers = new Map<string, Listener>();
  const app = { id: 1, mainFrame: { url: `${APP_ORIGIN}/` } };
  const viewer = { id: 2, mainFrame: { url: 'eli5doc://doc/solar-power/index.html' } };
  const settings = new SettingsStore({ dir: userData });
  await settings.load();
  const registry = new Registry({ edition: 'public', getSettings: () => settings.get() });
  const keyStore = o.keyStore ?? new MemoryKeyStore();
  const h: Omit<Harness, 'call' | 'dispose'> = {
    settings,
    keyStore,
    registry,
    sent: [],
    viewerSent: [],
    jobs: new FakeJobs(),
    library: new FakeLibrary(),
    clipboard: new FakeClipboard(),
    opened: [],
    revealed: [],
    rootRevealed: { count: 0 },
    keyReady: { value: true },
    userData,
    handlers,
  };
  const dispose = registerIpc({
    ipc: { handle: (ch, fn) => handlers.set(ch, fn as Listener) },
    ids: {
      appWebContents: () => app as never,
      viewerWebContents: () => viewer as never,
      isAppUrl: (u) => u.origin === APP_ORIGIN,
    },
    settings,
    keyStore,
    registry,
    viewer: { setBounds: () => {}, setVisible: () => {} },
    sendToApp: (channel, payload) => h.sent.push({ channel, payload }),
    sendToViewer: (channel, payload) => h.viewerSent.push({ channel, payload }),
    jobs: h.jobs,
    library: h.library,
    documents: {
      open: (slug) => h.opened.push(slug),
      reveal: (slug) => h.revealed.push(slug),
      revealRoot: () => {
        h.rootRevealed.count++;
      },
    },
    sources: { userData, clipboard: () => h.clipboard },
    apiKeyReady: async () => h.keyReady.value,
    ...(o.services ? { services: o.services } : {}),
  });
  const call = <T>(channel: string, payload?: unknown, from: 'app' | 'viewer' = 'app') => {
    const sender = from === 'app' ? app : viewer;
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`no handler for ${channel}`);
    return fn({ sender, senderFrame: sender.mainFrame }, payload) as Promise<IpcResult<T>>;
  };
  return { ...h, call, dispose };
}
