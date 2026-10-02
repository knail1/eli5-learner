import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, vi } from 'vitest';
import type { Eli5Api } from '../../../src/preload/api';
import type { EditionInfo, IpcResult, Settings } from '../../../src/preload/contract';
import { DEFAULTS } from '../../../src/main/config/schema';

/**
 * Renderer test harness: react-dom/client + jsdom (React Testing Library is not installed), and a
 * fake `window.eli5` whose invokes resolve to IpcResult envelopes.
 *
 * Components are .tsx, which config/tsconfig.node.json (it typechecks test/**) cannot compile, so they
 * are loaded with a runtime specifier that TypeScript does not follow.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Props are checked by config/tsconfig.web.json where the components compile. */
type AnyProps = Record<string, unknown>;
export type Component = ComponentType<AnyProps>;

/** Loads a renderer module by path relative to src/renderer/src (e.g. "input/InputZone.tsx"). */
export async function loadRenderer<T>(rel: string): Promise<T> {
  const spec = `../../../src/renderer/src/${rel}`;
  return (await import(/* @vite-ignore */ spec)) as T;
}

export const ok = <T>(value: T): IpcResult<T> => ({ ok: true, value });
export const notImplemented: IpcResult<never> = {
  ok: false,
  error: { code: 'E_INTERNAL', message: 'Not implemented yet' },
};

export const PUBLIC_EDITION: EditionInfo = {
  edition: 'public',
  version: '0.1.0',
  overlayLoaded: false,
  llmProviders: [
    { id: 'claude', available: true },
    { id: 'openai', available: true },
    { id: 'bedrock', available: false },
  ],
  publishers: [{ id: 'local', available: true }],
  uiFeatures: [],
  authAvailable: false,
};

export const settings = (): Settings => structuredClone(DEFAULTS);

type Listener = (payload: never) => void;

export interface FakeApi {
  api: Eli5Api;
  /** Emit a main → renderer event, e.g. emit('jobs', snapshot). */
  emit(
    event:
      | 'jobs'
      | 'library'
      | 'organization'
      | 'moved'
      | 'suggestions'
      | 'settings'
      | 'navigate'
      | 'cycle-region'
      | 'find-result'
      | 'find-command'
      | 'auth'
      | 'doc'
      | 'doc-history'
      | 'publish',
    payload: unknown,
  ): void;
}

const resolved = <T>(v: IpcResult<T>) => vi.fn(async () => v);

/** Every invoke answers like the M1b main process: M2-owned handlers return E_INTERNAL. */
export function installFakeApi(edition: EditionInfo = PUBLIC_EDITION): FakeApi {
  const listeners = new Map<string, Set<Listener>>();
  const on = (name: string) =>
    vi.fn((cb: Listener) => {
      const set = listeners.get(name) ?? new Set();
      set.add(cb);
      listeners.set(name, set);
      return () => set.delete(cb);
    });
  const api = {
    jobs: {
      start: resolved(notImplemented),
      list: resolved(notImplemented),
      cancel: resolved(ok(undefined)),
      retry: resolved(ok(undefined)),
      dismiss: resolved(ok(undefined)),
      onChanged: on('jobs'),
    },
    sources: {
      readClipboard: resolved(notImplemented),
      stageText: resolved(notImplemented),
      discard: resolved(ok(undefined)),
      discardDraft: resolved(ok(undefined)),
      release: resolved(ok(undefined)),
      classifyText: vi.fn(async (text: string) => ok({ kind: 'invalid', label: text })),
    },
    library: {
      list: resolved(notImplemented),
      open: resolved(notImplemented),
      reveal: resolved(notImplemented),
      info: resolved(notImplemented),
      revealRoot: resolved(ok(undefined)),
      onChanged: on('library'),
      organization: resolved(ok({ folders: [], placement: {}, trash: [], trashRetentionDays: 30 })),
      createFolder: resolved(notImplemented),
      renameFolder: resolved(notImplemented),
      deleteFolder: resolved(notImplemented),
      move: resolved(notImplemented),
      putBack: resolved(notImplemented),
      deletePermanently: resolved(notImplemented),
      emptyTrash: resolved(notImplemented),
      onOrganizationChanged: on('organization'),
      onMoved: on('moved'),
    },
    suggestions: {
      list: resolved(notImplemented),
      accept: resolved(notImplemented),
      dismiss: resolved(notImplemented),
      onChanged: on('suggestions'),
    },
    doc: {
      onUpdated: on('doc'),
      history: resolved(ok({ canUndo: false, canRedo: false, busy: false })),
      undo: resolved(notImplemented),
      redo: resolved(notImplemented),
      onHistoryChanged: on('doc-history'),
    },
    viewer: {
      setBounds: resolved(ok(undefined)),
      setVisible: resolved(ok(undefined)),
      focus: resolved(ok(undefined)),
      find: resolved(ok(undefined)),
      stopFind: resolved(ok(undefined)),
      onFindResult: on('find-result'),
    },
    llm: {
      testConnection: resolved(ok({ ok: true, model: 'model-x' })),
      models: resolved(ok({ suggested: ['model-x'], default: 'model-x' })),
    },
    settings: {
      get: resolved(ok(settings())),
      set: vi.fn(async () => ok(settings())),
      describe: resolved(notImplemented),
      setApiKey: resolved(ok(undefined)),
      hasApiKey: resolved(ok(false)),
      clearApiKey: resolved(ok(undefined)),
      chooseFolder: resolved(notImplemented),
      openHelp: resolved(notImplemented),
      onChanged: on('settings'),
    },
    edition: { info: resolved(ok(edition)) },
    publish: {
      targets: resolved(notImplemented),
      run: resolved(notImplemented),
      history: resolved(notImplemented),
      cancel: resolved(notImplemented),
      copyLink: resolved(notImplemented),
      openLink: resolved(notImplemented),
      reveal: resolved(notImplemented),
      onProgress: on('publish'),
    },
    auth: {
      status: resolved(ok({ state: 'unavailable', updatedAt: '2026-01-01T00:00:00.000Z' })),
      signIn: resolved(notImplemented),
      signOut: resolved(notImplemented),
      onChanged: on('auth'),
    },
    app: {
      onNavigate: on('navigate'),
      onCycleRegion: on('cycle-region'),
      onFindCommand: on('find-command'),
      contextMenu: resolved(notImplemented),
      testNotification: resolved(notImplemented),
      openNotificationSettings: resolved(notImplemented),
    },
    files: { pathFor: vi.fn((f: File) => `/tmp/${f.name}`) },
  } as unknown as Eli5Api;
  window.eli5 = api;
  return {
    api,
    emit(event, payload) {
      act(() => listeners.get(event)?.forEach((l) => l(payload as never)));
    },
  };
}

let mounted: { root: Root; host: HTMLElement }[] = [];

afterEach(() => {
  for (const m of mounted) {
    act(() => m.root.unmount());
    m.host.remove();
  }
  mounted = [];
  vi.restoreAllMocks();
});

export async function render(c: Component, props: AnyProps = {}): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(createElement(c, props)));
  await flush();
  return host;
}

/** Lets pending IPC promises and the effects they trigger settle. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}

export async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('element not found');
  await act(async () => (el as HTMLElement).click());
  await flush();
}

export async function key(el: Element | null | undefined, k: string, init: KeyboardEventInit = {}): Promise<void> {
  if (!el) throw new Error('element not found');
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await flush();
}

/** Sets a controlled input's value the way React observes it. */
export async function type(el: Element | null | undefined, value: string): Promise<void> {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error('not a text field');
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

export const byText = (root: ParentNode, text: string | RegExp): HTMLElement | undefined =>
  Array.from(root.querySelectorAll<HTMLElement>('*')).find(
    (e) =>
      e.children.length === 0 && (typeof text === 'string' ? e.textContent === text : text.test(e.textContent ?? '')),
  );

/** Accessible-ish name: aria-label, else text without aria-hidden parts. */
function nameOf(b: HTMLElement): string {
  const label = b.getAttribute('aria-label');
  if (label) return label;
  const clone = b.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[aria-hidden="true"]').forEach((e) => e.remove());
  return (clone.textContent ?? '').trim();
}

export const button = (root: ParentNode, name: string): HTMLButtonElement | undefined =>
  Array.from(root.querySelectorAll('button')).find((b) => nameOf(b) === name);
