import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBridge, loadGolden, loadRuntime, menuParts, selectText, type Runtime, type TestWindow } from './dom';

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
    prefer?: 'above' | 'below';
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

const menuEl = (root: ShadowRoot | undefined): HTMLElement | null => root?.querySelector('[role="group"]') ?? null;
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

  it('at 320 px the Ask row (question, Ask, Ask deep, Ask deeper) wraps only as a group (08 §5.1)', () => {
    const p = menu.placeMenu({
      ...base,
      viewport: { width: 320, height: 640 },
      anchor: { left: 100, top: 300, bottom: 320, width: 50 },
    });
    expect(p).toMatchObject({ left: 8, width: 304 });
    // jsdom has no layout, so the wrapping contract is pinned on the menu stylesheet (the real
    // geometry is in the narrow-selection-menu visual test): the row may wrap, but the three buttons
    // sit in one non-wrapping group that moves under the field as a whole; the field keeps 120 px.
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    const h = rt.boot(win, doc);
    const css = h.selection?.root.querySelector('style')?.textContent ?? '';
    expect(css).toMatch(/\.ask\{display:flex;flex-wrap:wrap;gap:4px\}/);
    expect(css).toMatch(/input\{font:inherit;min-width:0;/);
    expect(css).toMatch(/input\.q\{flex:1 1 120px\}/);
    expect(css).toMatch(/\.askb\{display:flex;gap:4px;flex:1 0 auto\}/);
    expect(css).not.toMatch(/\.askb\{[^}]*flex-wrap/);
    expect(css).toMatch(/\.go\{flex:none;white-space:nowrap\}/);
    // 304 - 16 padding leaves room for the three short labels and their markers on one line.
    const m = menuParts(h.selection?.root);
    const group = m.button('Ask')?.parentElement;
    expect(group?.classList.contains('askb')).toBe(true);
    const labels = Array.from(group?.querySelectorAll('button') ?? []).map((b) => b.querySelector('.lbl')?.textContent);
    expect(labels).toEqual(['Ask', 'Ask deep', 'Ask deeper']);
  });

  it('prefer: above stays above and grows upward; it flips only off the viewport top', () => {
    // 260 tall at anchor top 300: above would reach 32, under the 44 px tab bar.
    const tall = {
      ...base,
      menu: { width: 320, height: 260 },
      anchor: { left: 400, top: 300, bottom: 320, width: 100 },
    };
    expect(menu.placeMenu(tall).below).toBe(true);
    expect(menu.placeMenu({ ...tall, prefer: 'above' })).toEqual({ left: 290, top: 500 + 300 - 8 - 260, below: false });
    expect(menu.placeMenu({ ...tall, prefer: 'above', anchor: { ...tall.anchor, top: 200 } }).below).toBe(true);
  });

  it('prefer: below stays below even when the menu would fit above', () => {
    const p = menu.placeMenu({ ...base, prefer: 'below', anchor: { left: 400, top: 300, bottom: 320, width: 100 } });
    expect(p).toEqual({ left: 290, top: 500 + 320 + 8, below: true });
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

  const key = (win: TestWindow, el: Element | null | undefined, k: string, init: KeyboardEventInit = {}): boolean =>
    el?.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })) ?? false;

  it('the toolbar is one roving stop over Explain, ELI5 and Edit, wrapping and skipping disabled', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    const h = rt.boot(win, doc);
    open(win, doc);
    const m = menuParts(h.selection?.root);
    const tools = m.tools();
    expect(tools.map((b) => b.tabIndex)).toEqual([0, -1, -1]);
    tools[0]?.focus();
    key(win, tools[0], 'ArrowRight');
    expect(m.active()).toBe(tools[1]);
    expect(tools.map((b) => b.tabIndex)).toEqual([-1, 0, -1]);
    // "Edit with my note" is disabled while the note is empty: Right wraps past it.
    key(win, tools[1], 'ArrowRight');
    expect(m.active()).toBe(tools[0]);
    key(win, tools[0], 'ArrowLeft');
    expect(m.active()).toBe(tools[1]);
    key(win, tools[1], 'Home');
    expect(m.active()).toBe(tools[0]);
    key(win, tools[0], 'End');
    expect(m.active()).toBe(tools[1]);
    // With a note, Edit joins the ring.
    if (m.note) m.note.value = 'shorter';
    m.note?.dispatchEvent(new win.Event('input', { bubbles: true }));
    key(win, tools[1], 'End');
    expect(m.active()).toBe(tools[2]);
    key(win, tools[2], 'ArrowRight');
    expect(m.active()).toBe(tools[0]);
  });

  it('a trigger opens its popup on Enter, Space or Down (first item) and Up (last item)', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    const h = rt.boot(win, doc);
    open(win, doc);
    const m = menuParts(h.selection?.root);
    const [explain, eli5] = m.tools();
    const [pExplain, pEli5] = m.pops();
    for (const k of ['Enter', ' ', 'ArrowDown']) {
      explain?.focus();
      expect(key(win, explain, k)).toBe(false); // handled, so no native click as well
      expect(pExplain?.hidden).toBe(false);
      expect(explain?.getAttribute('aria-expanded')).toBe('true');
      expect(m.active()).toBe(m.button('Expand this'));
      key(win, m.active(), 'Escape');
      expect(pExplain?.hidden).toBe(true);
    }
    eli5?.focus();
    key(win, eli5, 'ArrowUp');
    expect(m.active()).toBe(m.button('ELI5 this selection'));
    // Only one popup is open at a time.
    explain?.click();
    expect(pExplain?.hidden).toBe(false);
    expect(pEli5?.hidden).toBe(true);
    expect(eli5?.getAttribute('aria-expanded')).toBe('false');
    explain?.click();
    expect(pExplain?.hidden).toBe(true);
  });

  it('in a popup: Up/Down wrap, Home/End, skip disabled; Enter activates', async () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    const p = doc.querySelector('#tab-indepth > section p');
    if (p) p.textContent = 'word '.repeat(2600); // too long: "ELI5 this selection" is disabled
    const h = rt.boot(win, doc);
    selectText(doc, '#tab-indepth > section p');
    doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    vi.advanceTimersByTime(200);
    const m = menuParts(h.selection?.root);
    const [explain, eli5] = m.tools();
    explain?.focus();
    key(win, explain, 'Enter');
    const item = (label: string) => m.button(label);
    key(win, m.active(), 'ArrowUp');
    expect(m.active()).toBe(item('Go deeper'));
    key(win, m.active(), 'ArrowDown');
    expect(m.active()).toBe(item('Expand this'));
    key(win, m.active(), 'End');
    expect(m.active()).toBe(item('Go deeper'));
    key(win, m.active(), 'Home');
    expect(m.active()).toBe(item('Expand this'));
    key(win, m.active(), 'ArrowDown');
    expect(m.active()).toBe(item("This isn't clear, re-explain it"));
    // The ELI5 popup has one enabled item: Down and Up both stay on it.
    key(win, m.active(), 'ArrowRight');
    expect(m.active()).toBe(eli5);
    key(win, eli5, 'ArrowDown');
    expect(m.active()).toBe(item('Create a separate ELI5 for this section'));
    key(win, m.active(), 'ArrowDown');
    expect(m.active()).toBe(item('Create a separate ELI5 for this section'));
    key(win, m.active(), 'Enter');
    await vi.runAllTimersAsync();
    expect(bridge.createSectionEli5).toHaveBeenCalledTimes(1);
    expect(bridge.createSectionEli5.mock.calls[0]?.[0]).not.toHaveProperty('scope');
  });

  it('Left/Right in a popup close it and move to the adjacent trigger; Tab closes it', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    const h = rt.boot(win, doc);
    open(win, doc);
    const m = menuParts(h.selection?.root);
    const [explain, eli5] = m.tools();
    const [pExplain, pEli5] = m.pops();
    explain?.focus();
    key(win, explain, 'ArrowDown');
    key(win, m.active(), 'ArrowRight');
    expect(pExplain?.hidden).toBe(true);
    expect(m.active()).toBe(eli5);
    expect(eli5?.tabIndex).toBe(0);
    key(win, eli5, 'ArrowDown');
    expect(pEli5?.hidden).toBe(false);
    key(win, m.active(), 'ArrowLeft');
    expect(pEli5?.hidden).toBe(true);
    expect(m.active()).toBe(explain);
    key(win, explain, 'ArrowDown');
    key(win, m.active(), 'Tab');
    expect(pExplain?.hidden).toBe(true);
    expect(m.active()).toBe(explain);
  });

  it('Enter in the note opens Explain on "Expand this" and never submits; Enter again expands', async () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    const h = rt.boot(win, doc);
    open(win, doc);
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: '.', metaKey: true, bubbles: true }));
    const m = menuParts(h.selection?.root);
    expect(m.active()).toBe(m.note);
    if (m.note) m.note.value = 'half a no';
    key(win, m.note, 'Enter');
    expect(bridge.regenerateSection).not.toHaveBeenCalled();
    expect(m.pops()[0]?.hidden).toBe(false);
    expect(m.active()).toBe(m.button('Expand this'));
    key(win, m.active(), 'Enter');
    await vi.runAllTimersAsync();
    expect(bridge.regenerateSection).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'expand', note: 'half a no' }),
    );
  });

  it('Shift+Tab in the note goes to the question field', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    const h = rt.boot(win, doc);
    open(win, doc);
    const m = menuParts(h.selection?.root);
    m.note?.focus();
    expect(key(win, m.note, 'Tab', { shiftKey: true })).toBe(false);
    expect(m.active()).toBe(m.question);
  });

  it('Tab order in the Ask row: question -> Ask -> Ask deep -> Ask deeper -> note; Shift+Tab from the note still lands on the question', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    const h = rt.boot(win, doc);
    open(win, doc);
    const m = menuParts(h.selection?.root);
    const focusables = Array.from(
      h.selection?.root.querySelectorAll<HTMLElement>('input, button:not([role="menuitem"])') ?? [],
    ).filter((e) => e.tabIndex >= 0 && !e.closest('[hidden]'));
    expect(focusables.slice(0, 5)).toEqual([
      m.question,
      m.button('Ask'),
      m.button('Ask deep'),
      m.button('Ask deeper'),
      m.note,
    ]);
    m.note?.focus();
    expect(key(win, m.note, 'Tab', { shiftKey: true })).toBe(false);
    expect(m.active()).toBe(m.question);
  });

  it('places the menu again when a popup opens or closes, growing away from the selection', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    Object.defineProperty(win.Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [{ left: 100, top: 400, bottom: 420, width: 50, height: 20, right: 150 }],
    });
    // jsdom has no layout: the panel is 150 px tall, 260 px with a popup open.
    Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (!this.classList.contains('m')) return 0;
        return this.querySelector('[role="menu"]:not([hidden])') ? 260 : 150;
      },
    });
    const h = rt.boot(win, doc);
    open(win, doc);
    const m = menuParts(h.selection?.root);
    expect(m.menu?.style.top).toBe(`${String(400 - 8 - 150)}px`);
    m.button('Explain')?.click();
    expect(m.menu?.style.top).toBe(`${String(400 - 8 - 260)}px`);
    m.button('Explain')?.click();
    expect(m.menu?.style.top).toBe(`${String(400 - 8 - 150)}px`);
  });

  it('Esc closes the menu and restores the selection from the snapshot', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    const h = rt.boot(win, doc);
    open(win, doc);
    doc.getSelection()?.removeAllRanges(); // clicking the note field clears the live selection
    const note = menuParts(h.selection?.root).note;
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

  it('Esc layering: the first Esc closes the open popup onto its trigger, the second closes the menu', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    const h = rt.boot(win, doc);
    open(win, doc);
    const m = menuParts(h.selection?.root);
    const eli5 = m.tools()[1];
    eli5?.focus();
    key(win, eli5, 'ArrowDown');
    key(win, m.active(), 'Escape');
    expect(m.pops()[1]?.hidden).toBe(true);
    expect(eli5?.getAttribute('aria-expanded')).toBe('false');
    expect(m.active()).toBe(eli5);
    expect(m.menu?.hidden).toBe(false);
    key(win, eli5, 'Escape');
    expect(m.menu?.hidden).toBe(true);
    expect(doc.getSelection()?.toString()).toBe('judges every channel');
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

  it('Cmd+. (or Ctrl+.) focuses the note; opening the menu does not move focus', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    const h = rt.boot(win, doc);
    open(win, doc);
    const m = menuParts(h.selection?.root);
    expect(m.active()).toBeNull();
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: '.', metaKey: true, bubbles: true }));
    expect(m.active()).toBe(m.note);
    m.question?.focus();
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: '.', ctrlKey: true, bubbles: true }));
    expect(m.active()).toBe(m.note);
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
  it('shows "Updating…", "Answering…" or "Creating ELI5 tab…" in an aria-live label while busy', async () => {
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
    bridge.busyCb?.({ busy: [{ sectionId: section?.id ?? '', action: 'ask' }] });
    expect(section?.querySelector('.eli5-busy-label')?.textContent).toBe('Answering…');
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
    for (const t of ['act', 'ask', 'close-tab', 'open-external', 'scroll-to', 'section-busy']) {
      expect(protocol.isDocMessage(protocol.docMessage(t, {}))).toBe(true);
    }
    for (const bad of [null, 'x', { ...m, source: 'other' }, { ...m, v: 2 }, { ...m, type: 'nope' }]) {
      expect(protocol.isDocMessage(bad)).toBe(false);
    }
  });
});
