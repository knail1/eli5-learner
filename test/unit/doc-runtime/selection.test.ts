import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBridge, loadGolden, selectText, loadRuntime, type Runtime } from './dom';

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

describe('selection bridge (08 §5)', () => {
  it('posts {tabKey, sectionId, text} for a selection inside a section', async () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    const h = boot(win, doc);
    const section = doc.querySelector<HTMLElement>('#tab-indepth > section');
    selectText(doc, '#tab-indepth > section p', 'judges every channel');
    doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    vi.advanceTimersByTime(200);
    expect(h.selection?.current()).toMatchObject({
      tabKey: 'indepth',
      sectionId: section?.id,
      text: 'judges every channel',
      clipped: false,
    });
    const buttons = Array.from(h.selection?.root.querySelectorAll('button') ?? []);
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Expand this',
      "This isn't clear, re-explain it",
      'Give me an analogy',
      'Go deeper',
      'Create a separate ELI5 for this section',
      'ELI5 this selection',
    ]);
    const note = h.selection?.root.querySelector('input');
    if (note) note.value = '  shorter please  ';
    buttons[0]?.click();
    await vi.runAllTimersAsync();
    expect(bridge.regenerateSection).toHaveBeenCalledWith({
      tabKey: 'indepth',
      sectionId: section?.id,
      action: 'expand',
      selectionText: 'judges every channel',
      note: 'shorter please',
    });
    expect(section?.getAttribute('data-eli5-busy')).toBe('expand');
  });

  it('creates a section ELI5 tab from the fifth action', async () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    const h = boot(win, doc);
    selectText(doc, '#tab-eli5 > section p', 'pays for ads');
    doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    vi.advanceTimersByTime(200);
    await h.selection?.submit('eli5-tab');
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
    selectText(
      doc,
      '#tab-indepth > section:nth-of-type(1) p',
      'judges every channel',
      '#tab-indepth > section:nth-of-type(2) p',
    );
    doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    vi.advanceTimersByTime(200);
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
    selectText(doc, '#tab-indepth > section p');
    doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    vi.advanceTimersByTime(200);
    const buttons = Array.from(h.selection?.root.querySelectorAll('button') ?? []);
    const eli5Sel = buttons.find((b) => b.textContent === 'ELI5 this selection');
    expect(eli5Sel?.disabled).toBe(true);
    expect(buttons.filter((b) => b !== eli5Sel).every((b) => !b.disabled)).toBe(true);
    expect(h.selection?.root.querySelector('.cap')?.textContent).toBe(
      'Too long to ELI5 as a selection (12,000 characters max)',
    );
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
    expect(Array.from(h.selection?.root.querySelectorAll('button') ?? []).every((b) => b.disabled)).toBe(true);
    bridge.busyCb?.({ busy: [] });
    expect(doc.getElementById(id)?.hasAttribute('data-eli5-busy')).toBe(false);
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
