/** Loads a golden document into its own jsdom window, so every test boots the runtime fresh. */
import { JSDOM } from 'jsdom';
import { vi } from 'vitest';
import { readGolden } from '../../fixtures/documents/runtime';

// src/doc-runtime/ is outside config/tsconfig.node.json's file list (it belongs to config/tsconfig.web.json), so
// tests load it through a computed specifier that Vite resolves and tsc does not follow, and
// describe the surface they use structurally.
const SRC = '../../../src/doc-runtime/';

type BridgeResult = { ok: boolean; error?: { message?: string } };
type ScrollTo = { sectionId?: string; tabKey?: string; flash: boolean; loadSeq: number };
type Busy = { busy: { sectionId: string; action: string }[] };
export interface DocBridge {
  regenerateSection(r: object): Promise<BridgeResult>;
  createSectionEli5(r: object): Promise<BridgeResult>;
  closeTab(tabKey: string): Promise<BridgeResult>;
  openExternal(url: string): Promise<BridgeResult>;
  onScrollTo(cb: (e: ScrollTo) => void): () => void;
  onSectionBusy(cb: (e: Busy) => void): () => void;
}
export interface Snapshot {
  tabKey: string;
  sectionId: string;
  heading: string;
  text: string;
  clipped: boolean;
}
export interface RuntimeHandle {
  inApp: boolean;
  tabs?: {
    keys(): string[];
    active(): string | undefined;
    activateTab(key: string, opts?: { history?: boolean; focus?: boolean }): boolean;
    tabOfSection(id: string): string | undefined;
  };
  glossary?: { isWide(): boolean; layout(): void };
  selection?: {
    root: ShadowRoot;
    current(): Snapshot | null;
    close(): void;
    submit(action: string, note?: string): Promise<void>;
  };
}
export interface Runtime {
  boot(win: Window, doc: Document): RuntimeHandle;
  enclosing(range: Range): { section: HTMLElement; range: Range; clipped: boolean } | null;
  normalizeSelection(s: string): string;
  snapshotSelection(sel: Selection | null): Snapshot | null;
  THEME_KEY: string;
}

export async function loadRuntime(): Promise<Runtime> {
  const [index, selection, theme] = (await Promise.all([
    import(/* @vite-ignore */ `${SRC}index`),
    import(/* @vite-ignore */ `${SRC}selection`),
    import(/* @vite-ignore */ `${SRC}theme`),
  ])) as [
    Pick<Runtime, 'boot'>,
    Pick<Runtime, 'enclosing' | 'normalizeSelection' | 'snapshotSelection'>,
    Pick<Runtime, 'THEME_KEY'>,
  ];
  return {
    boot: index.boot,
    enclosing: selection.enclosing,
    normalizeSelection: selection.normalizeSelection,
    snapshotSelection: selection.snapshotSelection,
    THEME_KEY: theme.THEME_KEY,
  };
}

/** A jsdom window: also carries its own event constructors (MouseEvent, FocusEvent, …). */
export type TestWindow = Window & typeof globalThis;

export interface Loaded {
  win: TestWindow;
  doc: Document;
  /** Flips the (min-width: 1100px) media query and notifies listeners. */
  setWide(on: boolean): void;
}

export function loadGolden(name: string, opts: { url?: string; wide?: boolean; bridge?: DocBridge } = {}): Loaded {
  const dom = new JSDOM(readGolden(name), {
    url: opts.url ?? 'https://example.test/doc/index.html',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as TestWindow;
  let wide = opts.wide ?? false;
  const listeners: ((e: { matches: boolean }) => void)[] = [];
  Object.defineProperty(win, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({
      media: q,
      get matches() {
        return wide;
      },
      addEventListener: (_t: string, cb: (e: { matches: boolean }) => void) => listeners.push(cb),
      removeEventListener: () => undefined,
    }),
  });
  if (opts.bridge) Object.defineProperty(win, 'eli5Doc', { configurable: true, value: opts.bridge });
  return {
    win,
    doc: win.document,
    setWide(on) {
      wide = on;
      for (const cb of listeners) cb({ matches: on });
    },
  };
}

export function fakeBridge() {
  const calls: Record<string, unknown[][]> = {};
  const rec =
    (name: string) =>
    (...args: unknown[]): Promise<{ ok: boolean }> => {
      (calls[name] ??= []).push(args);
      return Promise.resolve({ ok: true });
    };
  const b = {
    calls,
    regenerateSection: vi.fn(rec('regenerateSection')),
    createSectionEli5: vi.fn(rec('createSectionEli5')),
    closeTab: vi.fn(rec('closeTab')),
    openExternal: vi.fn(rec('openExternal')),
    onScrollTo: vi.fn((_cb: (e: ScrollTo) => void) => () => undefined),
    onSectionBusy: vi.fn((cb: (e: { busy: { sectionId: string; action: string }[] }) => void) => {
      b.busyCb = cb;
      return () => undefined;
    }),
    busyCb: undefined as ((e: { busy: { sectionId: string; action: string }[] }) => void) | undefined,
  };
  return b;
}

/** Selects `text` inside the first element matching `selector`. */
export function selectText(doc: Document, selector: string, text?: string, endSelector?: string): void {
  const el = doc.querySelector(selector);
  if (!el) throw new Error(`no element ${selector}`);
  const walker = doc.createTreeWalker(el, 4);
  let node = walker.nextNode() as Text | null;
  while (node && text && !node.data.includes(text)) node = walker.nextNode() as Text | null;
  if (!node) throw new Error(`no text in ${selector}`);
  const range = doc.createRange();
  const at = text ? node.data.indexOf(text) : 0;
  range.setStart(node, at);
  if (endSelector) {
    const endEl = doc.querySelector(endSelector);
    const endNode = endEl ? (doc.createTreeWalker(endEl, 4).nextNode() as Text | null) : null;
    if (!endNode) throw new Error(`no end ${endSelector}`);
    range.setEnd(endNode, Math.min(5, endNode.data.length));
  } else {
    range.setEnd(node, at + (text ?? node.data).length);
  }
  const sel = doc.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}
