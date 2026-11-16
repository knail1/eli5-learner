import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBridge, loadGolden, loadRuntime, menuParts, selectText, type Runtime } from './dom';

let rt: Runtime;
const boot: Runtime['boot'] = (win, doc) => rt.boot(win, doc);
beforeAll(async () => {
  rt = await loadRuntime();
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('plain browser (07 §6.3, 08 §2 item 6)', () => {
  it('installs no menu, keeps close buttons hidden, and never touches a bridge', () => {
    const { win, doc } = loadGolden('with-tab');
    const h = boot(win, doc);
    expect(h.inApp).toBe(false);
    expect(h.selection).toBeUndefined();
    expect(doc.querySelector('body > div[data-eli5-noact]:not(.viz-tip)')).toBeNull();
    expect(doc.querySelector<HTMLButtonElement>('button.tab-close')?.hidden).toBe(true);
    selectText(doc, '#tab-indepth > section p', 'judges every channel');
    doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    vi.advanceTimersByTime(200);
  });
});

function openOn(win: Window & typeof globalThis, doc: Document, sel: string, text?: string, end?: string): void {
  selectText(doc, sel, text, end);
  doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
  vi.advanceTimersByTime(200);
}

const type = (win: Window & typeof globalThis, input: HTMLInputElement | null, value: string): void => {
  if (!input) throw new Error('no input');
  input.value = value;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
};

describe('selection bridge (08 §5)', () => {
  it('shows the grouped menu: Ask, the note, a toolbar of three and six popup items (08 §5.1)', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    const h = boot(win, doc);
    openOn(win, doc, '#tab-indepth > section p', 'judges every channel');
    const m = menuParts(h.selection?.root);
    expect(m.menu?.getAttribute('aria-label')).toBe('Selection actions');
    expect(m.toolbar?.getAttribute('aria-label')).toBe('Section actions');
    expect(m.tools().map((b) => b.textContent)).toEqual(['Explain', 'ELI5', 'Edit with my note']);
    expect(m.button('Ask')).toBeDefined();
    expect(m.question?.getAttribute('aria-label')).toBe('Your question about this passage');
    expect(m.question?.maxLength).toBe(500);
    expect(m.question?.getAttribute('autocomplete')).toBe('off');
    expect(m.question?.placeholder).toBe('Ask a question about this…');
    expect(m.note?.getAttribute('aria-label')).toBe('Note for this action');
    expect(m.note?.maxLength).toBe(200);
    expect(m.items().map((b) => b.textContent)).toEqual([
      'Expand this',
      "This isn't clear, re-explain it",
      'Give me an analogy',
      'Go deeper',
      'Create a separate ELI5 for this section',
      'ELI5 this selection',
    ]);
    const [explain, eli5] = m.tools();
    for (const [t, id] of [
      [explain, 'pm-explain'],
      [eli5, 'pm-eli5'],
    ] as const) {
      expect(t?.getAttribute('aria-haspopup')).toBe('menu');
      expect(t?.getAttribute('aria-expanded')).toBe('false');
      expect(t?.getAttribute('aria-controls')).toBe(id);
      expect(h.selection?.root.getElementById(id)?.getAttribute('role')).toBe('menu');
    }
    // Popups are closed until a trigger opens one; no native <select>.
    expect(m.pops().every((p) => p.hidden)).toBe(true);
    expect(h.selection?.root.querySelector('select')).toBeNull();
  });

  it('posts {tabKey, sectionId, text, note} when a popup item is clicked', async () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    const h = boot(win, doc);
    const section = doc.querySelector<HTMLElement>('#tab-indepth > section');
    openOn(win, doc, '#tab-indepth > section p', 'judges every channel');
    expect(h.selection?.current()).toMatchObject({
      tabKey: 'indepth',
      sectionId: section?.id,
      text: 'judges every channel',
      clipped: false,
    });
    const m = menuParts(h.selection?.root);
    type(win, m.note, '  shorter please  ');
    m.button('Explain')?.click();
    expect(m.button('Explain')?.getAttribute('aria-expanded')).toBe('true');
    m.button('Expand this')?.click();
    await vi.runAllTimersAsync();
    expect(bridge.regenerateSection).toHaveBeenCalledWith({
      tabKey: 'indepth',
      sectionId: section?.id,
      action: 'expand',
      selectionText: 'judges every channel',
      note: 'shorter please',
    });
    expect(section?.getAttribute('data-eli5-busy')).toBe('expand');
    expect(m.menu?.hidden).toBe(true);
  });

  it('"Edit with my note" is disabled until the note has text, then sends revise with the note (08 §5.1)', async () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    const h = boot(win, doc);
    const section = doc.querySelector('#tab-indepth > section');
    openOn(win, doc, '#tab-indepth > section p');
    const m = menuParts(h.selection?.root);
    const revise = m.button('Edit with my note');
    expect(revise?.disabled).toBe(true);
    // Whitespace is not a note.
    type(win, m.note, '   ');
    expect(revise?.disabled).toBe(true);
    await h.selection?.submit('revise', '   ');
    expect(bridge.regenerateSection).not.toHaveBeenCalled();
    type(win, m.note, '  The average is twelve weeks, not eight  ');
    expect(revise?.disabled).toBe(false);
    revise?.click();
    await vi.runAllTimersAsync();
    expect(bridge.regenerateSection).toHaveBeenCalledWith(
      expect.objectContaining({
        sectionId: section?.id,
        action: 'revise',
        note: 'The average is twelve weeks, not eight',
      }),
    );
    expect(section?.getAttribute('data-eli5-busy')).toBe('revise');
  });

  it('creates a section ELI5 tab from the ELI5 popup', async () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    const h = boot(win, doc);
    openOn(win, doc, '#tab-eli5 > section p', 'pays for ads');
    const m = menuParts(h.selection?.root);
    m.button('ELI5')?.click();
    m.button('Create a separate ELI5 for this section')?.click();
    await vi.runAllTimersAsync();
    expect(bridge.createSectionEli5).toHaveBeenCalledWith(
      expect.objectContaining({ tabKey: 'eli5', selectionText: 'pays for ads' }),
    );
  });

  it('ELI5 this selection sends the whole selection across sections, anchored to the first', async () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    const h = boot(win, doc);
    const first = doc.querySelector<HTMLElement>('#tab-indepth > section:nth-of-type(1)');
    const second = doc.querySelector<HTMLElement>('#tab-indepth > section:nth-of-type(2)');
    openOn(
      win,
      doc,
      '#tab-indepth > section:nth-of-type(1) p',
      'judges every channel',
      '#tab-indepth > section:nth-of-type(2) p',
    );
    expect(menuParts(h.selection?.root).hint?.textContent).toMatch(/^Applies to: /);
    await h.selection?.submit('eli5-selection', 'keep it short');
    const call = bridge.createSectionEli5.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(call).toMatchObject({
      tabKey: 'indepth',
      sectionId: first?.id,
      scope: 'selection',
      sectionIds: [first?.id, second?.id],
      note: 'keep it short',
    });
    const text = String(call?.selectionText);
    expect(text.startsWith('judges every channel')).toBe(true);
    // Unclipped: it reaches into the second section, keeps paragraph breaks and skips glossary notes.
    expect(text).toContain('How the budget moved');
    expect(text).toContain('\n\n');
    expect(text).not.toContain('return on ad spend');
    expect(first?.getAttribute('data-eli5-busy')).toBe('eli5-selection');
    expect(first?.querySelector('.eli5-busy-label')?.textContent).toBe('Creating ELI5 tab…');
  });

  it('disables ELI5 this selection past 12,000 characters and says why', () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    const h = boot(win, doc);
    const p = doc.querySelector('#tab-indepth > section p');
    if (p) p.textContent = 'word '.repeat(2600);
    openOn(win, doc, '#tab-indepth > section p');
    const m = menuParts(h.selection?.root);
    const eli5Sel = m.button('ELI5 this selection');
    expect(eli5Sel?.disabled).toBe(true);
    // Every other popup item stays available, so both triggers do too.
    expect(
      m
        .items()
        .filter((b) => b !== eli5Sel)
        .every((b) => !b.disabled),
    ).toBe(true);
    expect(m.button('Explain')?.disabled).toBe(false);
    expect(m.button('ELI5')?.disabled).toBe(false);
    expect(m.cap?.textContent).toBe('Too long to ELI5 as a selection (12,000 characters max)');
  });

  it('opens nothing outside a section or in excluded regions', () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    const h = boot(win, doc);
    for (const [sel, text] of [
      ['header.doc-head h1', 'Example Widgets'],
      ['section[data-kind="references"] .ref-label', 'widget'],
      ['details.gl-note p', 'Revenue'],
      ['footer.doc-foot', 'Made'],
    ] as const) {
      selectText(doc, sel, text);
      doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
      vi.advanceTimersByTime(200);
      expect(h.selection?.current()).toBeNull();
    }
    expect(bridge.regenerateSection).not.toHaveBeenCalled();
  });

  it('clips a cross-section selection to the start section and says so', () => {
    const { doc } = loadGolden('with-tab');
    selectText(
      doc,
      '#tab-indepth > section:nth-of-type(1) p',
      'Example Widgets',
      '#tab-indepth > section:nth-of-type(2) p',
    );
    const snap = rt.snapshotSelection(doc.getSelection());
    expect(snap?.clipped).toBe(true);
    expect(snap?.sectionId).toBe(doc.querySelector('#tab-indepth > section')?.id);
    const range = doc.getSelection()?.getRangeAt(0);
    expect(range && rt.enclosing(range)?.clipped).toBe(true);
  });

  it('ignores selections shorter than 3 non-space characters and normalizes long ones', () => {
    const { doc } = loadGolden('with-tab');
    selectText(doc, '#tab-indepth > section p', 'Ex');
    expect(rt.snapshotSelection(doc.getSelection())).toBeNull();
    const long = rt.normalizeSelection('word '.repeat(1200));
    expect(long.length).toBeLessThanOrEqual(4000);
    expect(long.endsWith('…')).toBe(true);
  });

  it('disables actions on busy sections and syncs busy marks from main', () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    const h = boot(win, doc);
    const id = doc.querySelector('#tab-indepth > section')?.id ?? '';
    bridge.busyCb?.({ busy: [{ sectionId: id, action: 'deeper' }] });
    expect(doc.getElementById(id)?.getAttribute('data-eli5-busy')).toBe('deeper');
    selectText(doc, '#tab-indepth > section p', 'judges every channel');
    doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    vi.advanceTimersByTime(200);
    const m = menuParts(h.selection?.root);
    type(win, m.question, 'Why every channel?');
    type(win, m.note, 'shorter');
    // Busy disables everything: the three Asks, both triggers, every item, Edit; the fields are read-only.
    expect(m.buttons().length).toBe(12);
    expect(m.buttons().every((b) => b.disabled)).toBe(true);
    expect(m.question?.readOnly).toBe(true);
    expect(m.note?.readOnly).toBe(true);
    bridge.busyCb?.({ busy: [] });
    expect(doc.getElementById(id)?.hasAttribute('data-eli5-busy')).toBe(false);
    // Busy changes refresh the open menu.
    expect(m.button('Ask')?.disabled).toBe(false);
    expect(m.button('Edit with my note')?.disabled).toBe(false);
    expect(m.question?.readOnly).toBe(false);
  });

  it('a busy change while a popup item has focus closes the popup and keeps focus in the menu', () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    const h = boot(win, doc);
    const id = doc.querySelector('#tab-indepth > section')?.id ?? '';
    selectText(doc, '#tab-indepth > section p', 'judges every channel');
    doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    vi.advanceTimersByTime(200);
    const m = menuParts(h.selection?.root);
    m.button('Explain')?.click();
    expect(m.active()).toBe(m.button('Expand this'));
    bridge.busyCb?.({ busy: [{ sectionId: id, action: 'deeper' }] });
    expect(m.pops()[0]?.hidden).toBe(true);
    expect(m.active()).toBe(m.note);
    expect(m.menu?.hidden).toBe(false);
  });

  it('removes the busy mark and shows an inline notice when the app refuses', async () => {
    const bridge = fakeBridge();
    bridge.regenerateSection.mockImplementation(() =>
      Promise.resolve({ ok: false, error: { message: 'This section is already being updated' } }),
    );
    const { win, doc } = loadGolden('with-tab', { bridge });
    const h = boot(win, doc);
    selectText(doc, '#tab-indepth > section p', 'judges every channel');
    doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    vi.advanceTimersByTime(200);
    await h.selection?.submit('deeper');
    const section = doc.querySelector('#tab-indepth > section');
    expect(section?.hasAttribute('data-eli5-busy')).toBe(false);
    expect(section?.querySelector('.eli5-notice')?.textContent).toBe('This section is already being updated');
    vi.advanceTimersByTime(6000);
    expect(section?.querySelector('.eli5-notice')).toBeNull();
  });
});

describe('Ask a question (08 §5.1, §5.5, §6.8)', () => {
  const setup = () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    const h = boot(win, doc);
    const section = doc.querySelector<HTMLElement>('#tab-indepth > section');
    openOn(win, doc, '#tab-indepth > section p', 'judges every channel');
    return { bridge, win, doc, h, section, m: menuParts(h.selection?.root) };
  };
  const enter = (win: Window & typeof globalThis, el: Element | null): void => {
    el?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  };

  it('Enter in the question field sends {question} without the note and shows "Answering…"', async () => {
    const { bridge, win, m, section } = setup();
    type(win, m.note, 'a note');
    type(win, m.question, '  Why does it\n judge   every channel?  ');
    expect(m.button('Ask')?.disabled).toBe(false);
    enter(win, m.question);
    expect(section?.getAttribute('data-eli5-busy')).toBe('ask');
    expect(section?.querySelector('.eli5-busy-label')?.textContent).toBe('Answering…');
    await vi.runAllTimersAsync();
    expect(bridge.askQuestion).toHaveBeenCalledWith({
      tabKey: 'indepth',
      sectionId: section?.id,
      selectionText: 'judges every channel',
      question: 'Why does it judge every channel?',
    });
    expect(bridge.regenerateSection).not.toHaveBeenCalled();
    // Cleared after a successful dispatch.
    expect(m.question?.value).toBe('');
  });

  it('the Ask button sends the question too; the question is cut to 500 characters', async () => {
    const { bridge, win, m } = setup();
    type(win, m.question, 'why '.repeat(200));
    m.button('Ask')?.click();
    await vi.runAllTimersAsync();
    const call = bridge.askQuestion.mock.calls[0]?.[0] as { question: string } | undefined;
    expect(call?.question.length).toBe(500);
  });

  it('is disabled while empty or under 3 non-space characters, and Enter then does nothing', async () => {
    const { bridge, win, m, h } = setup();
    const ask = m.button('Ask');
    expect(ask?.disabled).toBe(true);
    type(win, m.question, ' a b ');
    expect(ask?.disabled).toBe(true);
    enter(win, m.question);
    await h.selection?.submit('ask', 'a b');
    await vi.runAllTimersAsync();
    expect(bridge.askQuestion).not.toHaveBeenCalled();
    type(win, m.question, 'a b c');
    expect(ask?.disabled).toBe(false);
  });

  it('is disabled while the section is busy', async () => {
    const { bridge, win, m, h, section } = setup();
    type(win, m.question, 'Why every channel?');
    bridge.busyCb?.({ busy: [{ sectionId: section?.id ?? '', action: 'deeper' }] });
    expect(m.button('Ask')?.disabled).toBe(true);
    await h.selection?.submit('ask');
    expect(bridge.askQuestion).not.toHaveBeenCalled();
  });

  it('keeps the question and shows an inline notice when the app refuses', async () => {
    const { bridge, win, m, h, doc, section } = setup();
    bridge.askQuestion.mockImplementation(() =>
      Promise.resolve({ ok: false, error: { message: 'This section is already being updated' } }),
    );
    type(win, m.question, 'Why every channel?');
    m.button('Ask')?.click();
    await vi.advanceTimersByTimeAsync(10);
    expect(section?.hasAttribute('data-eli5-busy')).toBe(false);
    expect(section?.querySelector('.eli5-notice')?.textContent).toBe('This section is already being updated');
    expect(m.question?.value).toBe('Why every channel?');
    // Re-opening the menu keeps it, ready to send again.
    openOn(win, doc, '#tab-indepth > section p:not(.eli5-notice)', 'every channel');
    expect(m.question?.value).toBe('Why every channel?');
    expect(m.button('Ask')?.disabled).toBe(false);
    expect(h.selection?.current()).not.toBeNull();
  });

  it('hides the Ask row when the app bridge cannot ask (an older app)', () => {
    const bridge: Partial<ReturnType<typeof fakeBridge>> = fakeBridge();
    delete bridge.askQuestion;
    const { win, doc } = loadGolden('with-tab', { bridge: bridge as ReturnType<typeof fakeBridge> });
    const h = boot(win, doc);
    const m = menuParts(h.selection?.root);
    expect(m.question?.parentElement?.hidden).toBe(true);
    // Shift+Tab from the note is left to the browser: the question field is hidden.
    openOn(win, doc, '#tab-indepth > section p', 'judges every channel');
    m.note?.focus();
    const ev = new win.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    expect(m.note?.dispatchEvent(ev)).toBe(true);
  });

  it('an Enter that commits an IME composition does not submit', async () => {
    const { bridge, win, m } = setup();
    type(win, m.question, 'Why every channel?');
    const ev = new win.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    m.question?.dispatchEvent(ev);
    await vi.runAllTimersAsync();
    expect(bridge.askQuestion).not.toHaveBeenCalled();
    expect(m.question?.value).toBe('Why every channel?');
  });

  it('a bridge that throws is a refusal: busy mark removed, notice shown', async () => {
    const { bridge, win, m, section } = setup();
    bridge.askQuestion.mockImplementation(() => Promise.reject(new Error('Bridge gone')));
    type(win, m.question, 'Why every channel?');
    m.button('Ask')?.click();
    await vi.advanceTimersByTimeAsync(10);
    expect(section?.hasAttribute('data-eli5-busy')).toBe(false);
    expect(section?.querySelector('.eli5-notice')?.textContent).toBe('Bridge gone');
    expect(m.question?.value).toBe('Why every channel?');
  });

  it('opens no menu inside an answer box question, but does inside the answer (a follow-up)', () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('asked', { bridge });
    const h = boot(win, doc);
    const details = doc.querySelector('details.qa-q');
    if (details) (details as HTMLDetailsElement).open = true;
    openOn(win, doc, 'details.qa-q .qa-q-about');
    expect(h.selection?.current()).toBeNull();
    openOn(win, doc, '.qa-a p');
    const snap = h.selection?.current();
    expect(snap?.text.length).toBeGreaterThan(3);
    expect(snap?.text).not.toContain('You asked');
  });
});

describe('Ask deep (08 §6.9)', () => {
  const setup = (name = 'with-tab') => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden(name, { bridge });
    const h = boot(win, doc);
    const section = doc.querySelector<HTMLElement>('#tab-indepth > section');
    openOn(win, doc, '#tab-indepth > section p', 'judges every channel');
    return { bridge, win, doc, h, section, m: menuParts(h.selection?.root) };
  };
  const enter = (win: Window & typeof globalThis, el: Element | null, mods: KeyboardEventInit = {}): boolean =>
    el?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...mods })) ??
    false;

  it('sits after Ask in the Ask row, with a screen-reader description', () => {
    const { m, h } = setup();
    const deep = m.button('Ask deep');
    expect(deep).toBeDefined();
    expect(deep?.hidden).toBe(false);
    const row = m.question?.parentElement;
    expect(row?.contains(deep ?? null)).toBe(true);
    // DOM (= Tab) order: question -> Ask -> Ask deep -> Ask deeper -> note.
    const order = Array.from(row?.querySelectorAll('input, button') ?? []);
    expect(order).toEqual([m.question, m.button('Ask'), deep, m.button('Ask deeper')]);
    expect(row?.nextElementSibling).toBe(m.note);
    const id = deep?.getAttribute('aria-describedby') ?? '';
    expect(id).toBe('deep-desc');
    // 08 §5.4: the Cmd/Ctrl+Enter shortcut is announced; the tooltip (not a native title) shows it.
    expect(deep?.getAttribute('aria-keyshortcuts')).toBe('Meta+Enter Control+Enter');
    expect(deep?.hasAttribute('title')).toBe(false);
    const desc = h.selection?.root.getElementById(id);
    expect(desc?.textContent).toBe('Also searches every tab and the original source text. (⌘ Enter or Ctrl+Enter)');
    expect(desc?.classList.contains('sr')).toBe(true);
    // The visually hidden class exists in the menu's shadow stylesheet.
    expect(h.selection?.root.querySelector('style')?.textContent).toMatch(/\.sr\{position:absolute;width:1px/);
  });

  it('follows the Ask enable rules: under 3 non-space characters, and while busy', async () => {
    const { bridge, win, m, h, section } = setup();
    const deep = m.button('Ask deep');
    expect(deep?.disabled).toBe(true);
    type(win, m.question, ' a b ');
    expect(deep?.disabled).toBe(true);
    await h.selection?.submit('ask-deep', 'a b');
    expect(bridge.askDeep).not.toHaveBeenCalled();
    type(win, m.question, 'Why every channel?');
    expect(deep?.disabled).toBe(false);
    bridge.busyCb?.({ busy: [{ sectionId: section?.id ?? '', action: 'expand' }] });
    expect(deep?.disabled).toBe(true);
    await h.selection?.submit('ask-deep');
    expect(bridge.askDeep).not.toHaveBeenCalled();
  });

  it('a click sends {question} through askDeep, never the note; busy reads "Answering in depth…"', async () => {
    const { bridge, win, m, section } = setup();
    type(win, m.note, 'a note');
    type(win, m.question, '  Why does it\n judge   every channel?  ');
    m.button('Ask deep')?.click();
    expect(section?.querySelector('.eli5-busy-label')?.textContent).toBe('Answering in depth…');
    await vi.runAllTimersAsync();
    expect(bridge.askDeep).toHaveBeenCalledWith({
      tabKey: 'indepth',
      sectionId: section?.id,
      selectionText: 'judges every channel',
      question: 'Why does it judge every channel?',
    });
    expect(bridge.askQuestion).not.toHaveBeenCalled();
    expect(bridge.regenerateSection).not.toHaveBeenCalled();
    expect(m.question?.value).toBe('');
  });

  it('Cmd+Enter and Ctrl+Enter in the question field send Ask deep; plain Enter stays Ask', async () => {
    for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
      const { bridge, win, m } = setup();
      type(win, m.question, 'Why every channel?');
      expect(enter(win, m.question, mod)).toBe(false); // handled
      await vi.runAllTimersAsync();
      expect(bridge.askDeep).toHaveBeenCalledTimes(1);
      expect(bridge.askQuestion).not.toHaveBeenCalled();
    }
    const { bridge, win, m } = setup();
    type(win, m.question, 'Why every channel?');
    enter(win, m.question);
    await vi.runAllTimersAsync();
    expect(bridge.askQuestion).toHaveBeenCalledTimes(1);
    expect(bridge.askDeep).not.toHaveBeenCalled();
  });

  it('Cmd+Enter does nothing while the question is too short', async () => {
    const { bridge, win, m } = setup();
    type(win, m.question, 'ab');
    enter(win, m.question, { metaKey: true });
    await vi.runAllTimersAsync();
    expect(bridge.askDeep).not.toHaveBeenCalled();
    expect(bridge.askQuestion).not.toHaveBeenCalled();
  });

  it('keeps the question and shows the notice when the app refuses', async () => {
    const { bridge, win, m, section } = setup();
    bridge.askDeep.mockImplementation(() =>
      Promise.resolve({ ok: false, error: { message: 'Too many deep questions; try again in a minute' } }),
    );
    type(win, m.question, 'Why every channel?');
    m.button('Ask deep')?.click();
    await vi.advanceTimersByTimeAsync(10);
    expect(section?.hasAttribute('data-eli5-busy')).toBe(false);
    expect(section?.querySelector('.eli5-notice')?.textContent).toBe('Too many deep questions; try again in a minute');
    expect(m.question?.value).toBe('Why every channel?');
  });

  it("maps a busy item {action: 'ask', depth: 'deep'} to its own label", () => {
    const { bridge, section } = setup();
    bridge.busyCb?.({ busy: [{ sectionId: section?.id ?? '', action: 'ask', depth: 'deep' }] });
    expect(section?.getAttribute('data-eli5-busy')).toBe('ask-deep');
    expect(section?.querySelector('.eli5-busy-label')?.textContent).toBe('Answering in depth…');
    bridge.busyCb?.({ busy: [{ sectionId: section?.id ?? '', action: 'ask' }] });
    expect(section?.getAttribute('data-eli5-busy')).toBe('ask');
    expect(section?.querySelector('.eli5-busy-label')?.textContent).toBe('Answering…');
  });

  it('an older app (askQuestion but no askDeep) shows Ask only; Cmd/Ctrl+Enter does nothing, Enter asks', async () => {
    const bridge: Partial<ReturnType<typeof fakeBridge>> = fakeBridge();
    delete bridge.askDeep;
    const full = bridge as ReturnType<typeof fakeBridge>;
    const { win, doc } = loadGolden('with-tab', { bridge: full });
    const h = boot(win, doc);
    openOn(win, doc, '#tab-indepth > section p', 'judges every channel');
    const m = menuParts(h.selection?.root);
    expect(m.question?.parentElement?.hidden).toBe(false);
    expect(m.button('Ask')?.hidden).toBe(false);
    expect(m.button('Ask deep')?.hidden).toBe(true);
    type(win, m.question, 'Why every channel?');
    enter(win, m.question, { metaKey: true });
    enter(win, m.question, { ctrlKey: true });
    await vi.runAllTimersAsync();
    expect(full.askQuestion).not.toHaveBeenCalled();
    enter(win, m.question);
    await vi.runAllTimersAsync();
    expect(full.askQuestion).toHaveBeenCalledTimes(1);
    // A direct submit cannot reach a missing method: it is a refusal with a notice.
    type(win, m.question, 'Why every channel?');
    openOn(win, doc, '#tab-indepth > section p', 'judges every channel');
    await h.selection?.submit('ask-deep');
    expect(doc.querySelector('#tab-indepth > section .eli5-notice')?.textContent).toBe(
      'Update the app to ask in depth',
    );
  });

  it('a selection inside a deep answer box never includes the badge', () => {
    const { win, doc, h } = setup('deep-asked');
    const box = doc.querySelector('aside.qa.qa-deep');
    const badge = box?.querySelector('.qa-badge');
    expect(badge?.textContent).toMatch(/^Deep answer · /);
    expect(badge?.hasAttribute('data-eli5-noact')).toBe(true);
    // Badge sits before .qa-a, outside it.
    expect(badge?.nextElementSibling?.classList.contains('qa-a')).toBe(true);
    // A selection from the badge into the answer opens no menu (it starts in an excluded region).
    const range = doc.createRange();
    const badgeText = badge?.firstChild;
    const answer = box?.querySelector('.qa-a p')?.firstChild;
    if (!badgeText || !answer) throw new Error('fixture');
    range.setStart(badgeText, 0);
    range.setEnd(answer, 10);
    const sel = doc.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    vi.advanceTimersByTime(200);
    expect(h.selection?.current()).toBeNull();
    // A selection across the whole box (from the section text before it) skips the badge text.
    const section = box?.closest('section');
    const before = section?.querySelector(':scope > p, :scope > h2')?.firstChild;
    if (!before) throw new Error('fixture');
    const r2 = doc.createRange();
    r2.setStart(before, 0);
    r2.setEnd(answer, 10);
    sel?.removeAllRanges();
    sel?.addRange(r2);
    doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    vi.advanceTimersByTime(200);
    const snap = h.selection?.current();
    expect(snap).not.toBeNull();
    expect(snap?.text).not.toContain('Deep answer');
    expect(snap?.text).not.toContain('checked against');
  });
});

describe('in-app tab close buttons and links (07 §12 item 5)', () => {
  it('shows close buttons only on section ELI5 tabs, with a two-step confirm', () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    boot(win, doc);
    const closes = Array.from(doc.querySelectorAll<HTMLButtonElement>('button.tab-close'));
    expect(closes).toHaveLength(1);
    const btn = closes[0];
    expect(btn?.hidden).toBe(false);
    expect(doc.querySelector('#tabbtn-indepth + .tab-close, #tabbtn-eli5 + .tab-close')).toBeNull();
    btn?.click();
    expect(btn?.textContent).toBe('Delete?');
    expect(bridge.closeTab).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3100);
    expect(btn?.textContent).toBe('×');
    btn?.click();
    btn?.click();
    expect(bridge.closeTab).toHaveBeenCalledWith(btn?.dataset.closeTab);
  });

  it('routes external links to openExternal', () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    boot(win, doc);
    const a = doc.querySelector<HTMLAnchorElement>('a[href^="https://"]');
    const ev = new win.MouseEvent('click', { bubbles: true, cancelable: true });
    a?.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(bridge.openExternal).toHaveBeenCalledWith(a?.getAttribute('href'));
  });

  it('handles onScrollTo: activates the tab and flashes the section', () => {
    const bridge = fakeBridge();
    let cb: ((e: { sectionId?: string; tabKey?: string; flash: boolean; loadSeq: number }) => void) | undefined;
    bridge.onScrollTo.mockImplementation((f) => {
      cb = f;
      return () => undefined;
    });
    const { win, doc } = loadGolden('with-tab', { bridge });
    const h = boot(win, doc);
    const target = doc.querySelector('#tab-eli5 > section');
    cb?.({ sectionId: target?.id, flash: true, loadSeq: 1 });
    expect(h.tabs?.active()).toBe('eli5');
    vi.advanceTimersByTime(50);
    expect(target?.classList.contains('eli5-flash')).toBe(true);
    vi.advanceTimersByTime(1600);
    expect(target?.classList.contains('eli5-flash')).toBe(false);
    cb?.({ sectionId: 'sec-sx000000-00000000', flash: true, loadSeq: 2 });
    expect(h.tabs?.active()).toBe('indepth');
  });
});
