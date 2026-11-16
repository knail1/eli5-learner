import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessibleText, fakeBridge, loadGolden, loadRuntime, menuParts, selectText, type Runtime } from './dom';

/** Ask deeper and the Ask tooltips in the selection menu (08 §5.1, §5.4, §6.10). */

/** 08 §5.1: the exact tooltip and description texts (the runtime's ASK_TOOLTIPS). */
const ASK_TOOLTIPS = {
  ask: 'Answers from this section and the sections around it. Fastest. (Enter)',
  'ask-deep': 'Also searches every tab and the original source text. (⌘ Enter or Ctrl+Enter)',
  'ask-deeper':
    "Searches every tab and the original sources first, then the web, then the AI's general knowledge. Anything from outside the document is marked. (⌘ ⇧ Enter or Ctrl+Shift+Enter)",
} as const;

let rt: Runtime;
beforeAll(async () => {
  rt = await loadRuntime();
});
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type Win = Window & typeof globalThis;

function openOn(win: Win, doc: Document): void {
  selectText(doc, '#tab-indepth > section p', 'judges every channel');
  doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
  vi.advanceTimersByTime(200);
}

const type = (win: Win, input: HTMLInputElement | null, value: string): void => {
  if (!input) throw new Error('no input');
  input.value = value;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
};

const enter = (win: Win, el: Element | null, mods: KeyboardEventInit = {}): boolean =>
  el?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...mods })) ??
  false;

function setup(bridge = fakeBridge()) {
  const { win, doc } = loadGolden('with-tab', { bridge });
  const h = rt.boot(win, doc);
  const section = doc.querySelector<HTMLElement>('#tab-indepth > section');
  openOn(win, doc);
  return { bridge, win, doc, h, section, m: menuParts(h.selection?.root) };
}

/** Stub a layout box (jsdom has none). */
function box(el: Element | null | undefined, r: { left: number; top: number; width: number; height: number }): void {
  if (!el) throw new Error('no element');
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top }),
  });
}

describe('the three Ask buttons (08 §5.1)', () => {
  it('are Ask, Ask deep and Ask deeper, each with an aria-hidden ⓘ marker, a description and shortcuts', () => {
    const { m, h } = setup();
    const names = ['Ask', 'Ask deep', 'Ask deeper'];
    const ids = ['ask-desc', 'deep-desc', 'deeper-desc'];
    const keys = ['Enter', 'Meta+Enter Control+Enter', 'Meta+Shift+Enter Control+Shift+Enter'];
    const texts = [ASK_TOOLTIPS.ask, ASK_TOOLTIPS['ask-deep'], ASK_TOOLTIPS['ask-deeper']];
    names.forEach((name, i) => {
      const b = m.button(name);
      expect(b, name).toBeDefined();
      expect(accessibleText(b as Element)).toBe(name);
      const info = b?.querySelector('.info');
      expect(info?.getAttribute('aria-hidden')).toBe('true');
      expect(info?.textContent).toBe('i');
      expect(b?.getAttribute('aria-describedby')).toBe(ids[i]);
      expect(b?.getAttribute('aria-keyshortcuts')).toBe(keys[i]);
      expect(b?.hasAttribute('title')).toBe(false);
      expect(h.selection?.root.getElementById(ids[i] ?? '')?.textContent).toBe(texts[i]);
    });
    expect(texts).toEqual([
      'Answers from this section and the sections around it. Fastest. (Enter)',
      'Also searches every tab and the original source text. (⌘ Enter or Ctrl+Enter)',
      "Searches every tab and the original sources first, then the web, then the AI's general knowledge. Anything from outside the document is marked. (⌘ ⇧ Enter or Ctrl+Shift+Enter)",
    ]);
  });

  it('Ask deeper follows the Ask enable rules', async () => {
    const { bridge, win, m, h, section } = setup();
    const deeper = m.button('Ask deeper');
    expect(deeper?.disabled).toBe(true);
    type(win, m.question, ' a b ');
    expect(deeper?.disabled).toBe(true);
    await h.selection?.submit('ask-deeper', 'a b');
    expect(bridge.askDeeper).not.toHaveBeenCalled();
    type(win, m.question, 'Why every channel?');
    expect(deeper?.disabled).toBe(false);
    bridge.busyCb?.({ busy: [{ sectionId: section?.id ?? '', action: 'expand' }] });
    expect(deeper?.disabled).toBe(true);
  });

  it('a click sends {question} through askDeeper, never the note; busy reads "Searching further…"', async () => {
    const { bridge, win, m, section } = setup();
    type(win, m.note, 'a note');
    type(win, m.question, '  How long do\n they last?  ');
    m.button('Ask deeper')?.click();
    expect(section?.getAttribute('data-eli5-busy')).toBe('ask-deeper');
    expect(section?.querySelector('.eli5-busy-label')?.textContent).toBe('Searching further…');
    await vi.runAllTimersAsync();
    expect(bridge.askDeeper).toHaveBeenCalledWith({
      tabKey: 'indepth',
      sectionId: section?.id,
      selectionText: 'judges every channel',
      question: 'How long do they last?',
    });
    expect(bridge.askDeep).not.toHaveBeenCalled();
    expect(bridge.askQuestion).not.toHaveBeenCalled();
    expect(m.question?.value).toBe('');
  });

  it('Cmd+Shift+Enter and Ctrl+Shift+Enter send Ask deeper; Cmd+Enter stays Ask deep; Shift+Enter stays Ask', async () => {
    for (const mod of [
      { metaKey: true, shiftKey: true },
      { ctrlKey: true, shiftKey: true },
    ]) {
      const { bridge, win, m } = setup();
      type(win, m.question, 'Why every channel?');
      expect(enter(win, m.question, mod)).toBe(false); // handled
      await vi.runAllTimersAsync();
      expect(bridge.askDeeper).toHaveBeenCalledTimes(1);
      expect(bridge.askDeep).not.toHaveBeenCalled();
      expect(bridge.askQuestion).not.toHaveBeenCalled();
    }
    {
      const { bridge, win, m } = setup();
      type(win, m.question, 'Why every channel?');
      enter(win, m.question, { metaKey: true });
      await vi.runAllTimersAsync();
      expect(bridge.askDeep).toHaveBeenCalledTimes(1);
      expect(bridge.askDeeper).not.toHaveBeenCalled();
    }
    const { bridge, win, m } = setup();
    type(win, m.question, 'Why every channel?');
    enter(win, m.question, { shiftKey: true });
    await vi.runAllTimersAsync();
    expect(bridge.askQuestion).toHaveBeenCalledTimes(1);
    expect(bridge.askDeeper).not.toHaveBeenCalled();
  });

  it("maps a busy item {action: 'ask', depth: 'deeper'} to its own label", () => {
    const { bridge, section } = setup();
    bridge.busyCb?.({ busy: [{ sectionId: section?.id ?? '', action: 'ask', depth: 'deeper' }] });
    expect(section?.getAttribute('data-eli5-busy')).toBe('ask-deeper');
    expect(section?.querySelector('.eli5-busy-label')?.textContent).toBe('Searching further…');
  });

  it('an app without askDeeper hides Ask deeper; its shortcut does nothing; a direct submit is refused', async () => {
    const partial: Partial<ReturnType<typeof fakeBridge>> = fakeBridge();
    delete partial.askDeeper;
    const bridge = partial as ReturnType<typeof fakeBridge>;
    const { win, doc, h, m } = setup(bridge);
    expect(m.button('Ask')?.hidden).toBe(false);
    expect(m.button('Ask deep')?.hidden).toBe(false);
    expect(m.button('Ask deeper')?.hidden).toBe(true);
    type(win, m.question, 'Why every channel?');
    enter(win, m.question, { metaKey: true, shiftKey: true });
    enter(win, m.question, { ctrlKey: true, shiftKey: true });
    await vi.runAllTimersAsync();
    expect(bridge.askQuestion).not.toHaveBeenCalled();
    expect(bridge.askDeep).not.toHaveBeenCalled();
    openOn(win, doc);
    await h.selection?.submit('ask-deeper');
    expect(doc.querySelector('#tab-indepth > section .eli5-notice')?.textContent).toBe('Update the app to ask deeper');
  });
});

describe('Ask tooltips (08 §5.1, §5.4)', () => {
  it('show on keyboard focus with the button text, and hide on blur', () => {
    const { m } = setup();
    expect(m.tip?.hidden).toBe(true);
    expect(m.tip?.getAttribute('aria-hidden')).toBe('true');
    for (const [name, key] of [
      ['Ask', 'ask'],
      ['Ask deep', 'ask-deep'],
      ['Ask deeper', 'ask-deeper'],
    ] as const) {
      // Disabled buttons cannot take focus; give them a question first.
      m.button(name)?.removeAttribute('disabled');
      m.button(name)?.focus();
      expect(m.tip?.hidden, name).toBe(false);
      expect(m.tip?.textContent).toBe(ASK_TOOLTIPS[key]);
      expect(m.tip?.dataset.for).toBe(key);
    }
    m.button('Ask deeper')?.blur();
    expect(m.tip?.hidden).toBe(true);
  });

  it('show on hover, also over a disabled button (hover is tracked on the group), and hide on leave', () => {
    const { win, m } = setup();
    const deeper = m.button('Ask deeper');
    expect(deeper?.disabled).toBe(true);
    box(m.button('Ask'), { left: 20, top: 100, width: 50, height: 28 });
    box(m.button('Ask deep'), { left: 74, top: 100, width: 80, height: 28 });
    box(deeper, { left: 158, top: 100, width: 100, height: 28 });
    const group = deeper?.parentElement;
    group?.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 200, clientY: 110 }));
    expect(m.tip?.hidden).toBe(false);
    expect(m.tip?.dataset.for).toBe('ask-deeper');
    group?.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 30, clientY: 110 }));
    expect(m.tip?.dataset.for).toBe('ask');
    group?.dispatchEvent(new win.MouseEvent('mouseleave'));
    expect(m.tip?.hidden).toBe(true);
    // mouseenter on an enabled button works too.
    m.button('Ask deep')?.dispatchEvent(new win.MouseEvent('mouseenter'));
    expect(m.tip?.dataset.for).toBe('ask-deep');
  });

  it('stays inside the viewport: clamped 8 px from the right edge, flipped above near the bottom', () => {
    const { win, m } = setup();
    Object.defineProperty(win, 'innerWidth', { configurable: true, value: 320 });
    Object.defineProperty(win, 'innerHeight', { configurable: true, value: 600 });
    box(m.menu, { left: 8, top: 400, width: 304, height: 180 });
    const deeper = m.button('Ask deeper');
    box(deeper, { left: 220, top: 540, width: 90, height: 28 });
    Object.defineProperty(m.tip, 'offsetWidth', { configurable: true, get: () => 240 });
    Object.defineProperty(m.tip, 'offsetHeight', { configurable: true, get: () => 60 });
    deeper?.removeAttribute('disabled');
    deeper?.focus();
    // Right edge: 320 - 8 - 240 = 72 in the viewport, 64 in the menu (menu left 8, no border in jsdom).
    expect(m.tip?.style.left).toBe('64px');
    // Below would end at 540 + 28 + 6 + 60 = 634 > 592: above, 540 - 6 - 60 = 474 -> 74 in the menu.
    expect(m.tip?.style.top).toBe('74px');
    expect(Number.parseInt(m.tip?.style.maxWidth ?? '0', 10)).toBeLessThanOrEqual(260);
  });

  it('Esc hides an open tooltip first; the next Esc closes the menu', () => {
    const { win, m } = setup();
    const deep = m.button('Ask deep');
    deep?.removeAttribute('disabled');
    deep?.focus();
    expect(m.tip?.hidden).toBe(false);
    deep?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(m.tip?.hidden).toBe(true);
    expect(m.menu?.hidden).toBe(false);
    deep?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(m.menu?.hidden).toBe(true);
  });

  it('closing the menu hides the tooltip', () => {
    const { m, h } = setup();
    m.button('Ask')?.removeAttribute('disabled');
    m.button('Ask')?.focus();
    expect(m.tip?.hidden).toBe(false);
    h.selection?.close();
    expect(m.tip?.hidden).toBe(true);
  });
});
