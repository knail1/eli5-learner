import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBridge, loadGolden, loadRuntime, selectText, type Runtime, type TestWindow } from './dom';

/** Inline action menu behavior beyond the M1 basics (08 §5.2-§5.5, §9) and the bridge envelope (08 §4.2). */

const SRC = '../../../src/doc-runtime/';

interface Placement {
  left: number;
  top: number;
  width?: number;
  below: boolean;
}
interface MenuModule {
  placeMenu(o: {
    anchor: { left: number; top: number; bottom: number; width: number };
    menu: { width: number; height: number };
    viewport: { width: number; height: number };
    scroll: { x: number; y: number };
    tabbarBottom: number;
  }): Placement;
}
interface ProtocolModule {
  docMessage(type: string, payload: unknown): { source: string; v: number; type: string; payload: unknown };
  isDocMessage(v: unknown): boolean;
}

let rt: Runtime;
let menu: MenuModule;
let protocol: ProtocolModule;
beforeAll(async () => {
  rt = await loadRuntime();
  menu = (await import(/* @vite-ignore */ `${SRC}selection/menu`)) as MenuModule;
  protocol = (await import(/* @vite-ignore */ `${SRC}selection/protocol`)) as ProtocolModule;
});
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function open(win: TestWindow, doc: Document, sel = '#tab-indepth > section p', text = 'judges every channel') {
  selectText(doc, sel, text);
  doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
  vi.advanceTimersByTime(200);
}

const menuEl = (root: ShadowRoot | undefined): HTMLElement | null => root?.querySelector('[role="toolbar"]') ?? null;
const buttons = (root: ShadowRoot | undefined): HTMLButtonElement[] =>
  Array.from(root?.querySelectorAll<HTMLButtonElement>('button') ?? []);

describe('placeMenu (08 §5.2 step 6)', () => {
  const base = {
    menu: { width: 320, height: 90 },
    viewport: { width: 1000, height: 800 },
    scroll: { x: 0, y: 500 },
    tabbarBottom: 44,
  };

  it('centres the menu 8 px above the last selection rect, in document coordinates', () => {
    const p = menu.placeMenu({ ...base, anchor: { left: 400, top: 300, bottom: 320, width: 100 } });
    expect(p).toEqual({ left: 290, top: 500 + 300 - 8 - 90, below: false });
  });

  it('flips below the selection when it would overlap the sticky tab bar', () => {
    const p = menu.placeMenu({ ...base, anchor: { left: 400, top: 100, bottom: 120, width: 100 } });
    expect(p).toEqual({ left: 290, top: 500 + 120 + 8, below: true });
  });

  it('clamps horizontally with 8 px margins', () => {
    expect(menu.placeMenu({ ...base, anchor: { left: 0, top: 300, bottom: 320, width: 10 } }).left).toBe(8);
    expect(menu.placeMenu({ ...base, anchor: { left: 990, top: 300, bottom: 320, width: 10 } }).left).toBe(
      1000 - 8 - 320,
    );
  });

  it('is full width minus 16 px on narrow viewports', () => {
    const p = menu.placeMenu({
      ...base,
      viewport: { width: 360, height: 700 },
      anchor: { left: 100, top: 300, bottom: 320, width: 50 },
    });
    expect(p).toMatchObject({ left: 8, width: 344 });
  });
});

describe('menu interaction (08 §5.2, §5.4)', () => {
  it('opens on selectionchange, debounced by 150 ms', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    const h = rt.boot(win, doc);
    selectText(doc, '#tab-indepth > section p', 'judges every channel');
    doc.dispatchEvent(new win.Event('selectionchange'));
    vi.advanceTimersByTime(100);
    expect(h.selection?.current()).toBeNull();
    vi.advanceTimersByTime(60);
    expect(h.selection?.current()).toMatchObject({ text: 'judges every channel' });
  });

  it('is a toolbar with roving tabindex; arrows move between actions', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    const h = rt.boot(win, doc);
    open(win, doc);
    const bs = buttons(h.selection?.root);
    expect(bs.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    bs[0]?.focus();
    bs[0]?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(bs.map((b) => b.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1]);
    bs[1]?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    bs[0]?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(bs.map((b) => b.tabIndex)).toEqual([-1, -1, -1, -1, -1, 0]);
    expect(h.selection?.root.querySelector('input')?.getAttribute('aria-label')).toBe('Note for this action');
  });

  it('Esc closes the menu and restores the selection from the snapshot', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    const h = rt.boot(win, doc);
    open(win, doc);
    doc.getSelection()?.removeAllRanges(); // clicking the note field clears the live selection
    const note = h.selection?.root.querySelector('input');
    note?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menuEl(h.selection?.root)?.hidden).toBe(true);
    expect(doc.getSelection()?.toString()).toBe('judges every channel');
    // The restore fires selectionchange; the menu must stay closed past the debounce.
    doc.dispatchEvent(new win.Event('selectionchange'));
    vi.advanceTimersByTime(200);
    expect(menuEl(h.selection?.root)?.hidden).toBe(true);
    doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    vi.advanceTimersByTime(200);
    expect(menuEl(h.selection?.root)?.hidden).toBe(true);
  });

  it('opens again after Esc once the user makes a different selection', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    const h = rt.boot(win, doc);
    open(win, doc);
    menuEl(h.selection?.root)?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menuEl(h.selection?.root)?.hidden).toBe(true);
    open(win, doc, '#tab-indepth > section p', 'every channel');
    expect(menuEl(h.selection?.root)?.hidden).toBe(false);
  });

  it('Cmd+. moves focus into the open menu', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    const h = rt.boot(win, doc);
    open(win, doc);
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: '.', metaKey: true, bubbles: true }));
    expect(h.selection?.root.activeElement).toBe(h.selection?.root.querySelector('input'));
  });

  it('marks the passage with boxes over its own line boxes while open (08 §5.2 step 5)', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    // jsdom has no layout: every text run reports one 40 x 18 line box.
    const proto = win.Range.prototype as unknown as { getClientRects: () => unknown };
    proto.getClientRects = () => [{ left: 10, top: 20, width: 40, height: 18 }];
    const h = rt.boot(win, doc);
    const layer = doc.querySelector<HTMLElement>('body > div.eli5-pending');
    expect(layer?.hidden).toBe(true);
    expect(layer?.getAttribute('aria-hidden')).toBe('true');
    open(win, doc);
    const boxes = Array.from(layer?.children ?? []) as HTMLElement[];
    expect(layer?.hidden).toBe(false);
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes[0]?.style.cssText).toBe('left: 10px; top: 20px; width: 40px; height: 18px;');
    h.selection?.close();
    expect(layer?.hidden).toBe(true);
    expect(layer?.children.length).toBe(0);
  });

  it('closes on a tab switch', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    const h = rt.boot(win, doc);
    open(win, doc);
    h.tabs?.activateTab('eli5');
    expect(h.selection?.current()).toBeNull();
  });

  it('closes on scroll when the anchor leaves the viewport', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    let top = 300;
    Object.defineProperty(win.Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [{ left: 100, top, bottom: top + 20, width: 50, height: 20, right: 150 }],
    });
    const h = rt.boot(win, doc);
    open(win, doc);
    win.dispatchEvent(new win.Event('scroll'));
    expect(h.selection?.current()).not.toBeNull();
    top = -100;
    win.dispatchEvent(new win.Event('scroll'));
    expect(h.selection?.current()).toBeNull();
  });
});

describe('busy marks and notices (08 §5.5, §8.3, §9)', () => {
  it('shows "Updating…" or "Creating ELI5 tab…" in an aria-live label while busy', async () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    const h = rt.boot(win, doc);
    open(win, doc);
    await h.selection?.submit('expand');
    const section = doc.querySelector('#tab-indepth > section');
    const label = section?.querySelector('.eli5-busy-label');
    expect(label?.textContent).toBe('Updating…');
    expect(label?.getAttribute('aria-live')).toBe('polite');
    bridge.busyCb?.({ busy: [{ sectionId: section?.id ?? '', action: 'eli5-tab' }] });
    expect(section?.querySelector('.eli5-busy-label')?.textContent).toBe('Creating ELI5 tab…');
    bridge.busyCb?.({ busy: [] });
    expect(section?.querySelector('.eli5-busy-label')).toBeNull();
  });

  it('shows notices for failed jobs sent with the busy list', () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    rt.boot(win, doc);
    const section = doc.querySelector('#tab-indepth > section');
    const busy = { busy: [], notices: [{ sectionId: section?.id ?? '', message: 'This section changed. Try again' }] };
    (bridge.busyCb as unknown as (e: typeof busy) => void)(busy);
    expect(section?.querySelector('.eli5-notice')?.textContent).toBe('This section changed. Try again');
  });

  it('keeps the busy hint and disabled actions while main says the section is busy', () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    const h = rt.boot(win, doc);
    const id = doc.querySelector('#tab-indepth > section')?.id ?? '';
    bridge.busyCb?.({ busy: [{ sectionId: id, action: 'expand' }] });
    open(win, doc);
    expect(h.selection?.root.querySelector('.hint')?.textContent).toBe('This section is being updated');
    expect(buttons(h.selection?.root).every((b) => b.disabled)).toBe(true);
  });
});

describe('bridge message envelope (08 §4.2)', () => {
  it('wraps payloads in a versioned eli5-doc envelope and recognises only those', () => {
    const m = protocol.docMessage('close-tab', { tabKey: 'sx0a1b2c' });
    expect(m).toEqual({ source: 'eli5-doc', v: 1, type: 'close-tab', payload: { tabKey: 'sx0a1b2c' } });
    expect(protocol.isDocMessage(m)).toBe(true);
    for (const bad of [null, 'x', { ...m, source: 'other' }, { ...m, v: 2 }, { ...m, type: 'nope' }]) {
      expect(protocol.isDocMessage(bad)).toBe(false);
    }
  });
});
