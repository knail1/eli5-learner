import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DocHistoryState } from '../../../src/preload/contract';
import { button, click, flush, installFakeApi, key, loadRenderer, ok, render, type FakeApi } from './harness';

/** Undo / Redo in the document header (11 §5.3, §9; 09 §4.1). */

const { HistoryButtons } = await loadRenderer<{ HistoryButtons: (p: { slug: string }) => unknown }>(
  'viewer/HistoryButtons.tsx',
);
const { matchHistoryKey, isTextEntry } = await loadRenderer<{
  matchHistoryKey(e: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }): 'undo' | 'redo' | null;
  isTextEntry(el: Element | null): boolean;
}>('a11y/shortcuts.ts');
const { DocHeader } = await loadRenderer<{ DocHeader: (p: { slug: string; entry: unknown }) => unknown }>(
  'viewer/DocHeader.tsx',
);

const SLUG = 'widget-pricing';
const NONE: DocHistoryState = { canUndo: false, canRedo: false, busy: false };
const UNDO: DocHistoryState = {
  canUndo: true,
  canRedo: false,
  undoLabel: "re-explained 'The particular…'",
  busy: false,
};
const REDO: DocHistoryState = {
  canUndo: false,
  canRedo: true,
  redoLabel: "re-explained 'The particular…'",
  busy: false,
};

let fake: FakeApi;
const historyMock = () => fake.api.doc.history as unknown as { mockResolvedValue(v: unknown): void };
const undoMock = () =>
  fake.api.doc.undo as unknown as { mock: { calls: unknown[][] }; mockResolvedValue(v: unknown): void };
const redoMock = () =>
  fake.api.doc.redo as unknown as { mock: { calls: unknown[][] }; mockResolvedValue(v: unknown): void };

async function mount(state: DocHistoryState): Promise<HTMLElement> {
  historyMock().mockResolvedValue(ok(state));
  return render(HistoryButtons as never, { slug: SLUG });
}

beforeEach(() => {
  fake = installFakeApi();
});

describe('HistoryButtons (11 §5.3)', () => {
  it('shows two icon buttons, disabled with "Nothing to …" tooltips when there is no prior version', async () => {
    const host = await mount(NONE);
    const undo = button(host, 'Undo');
    const redo = button(host, 'Redo');
    expect(undo?.disabled).toBe(true);
    expect(redo?.disabled).toBe(true);
    expect(undo?.title).toBe('Nothing to undo');
    expect(redo?.title).toBe('Nothing to redo');
    // Inline SVG icons, hidden from assistive tech; no emoji or text glyphs.
    expect(undo?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(redo?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(undo?.textContent).toBe('');
    expect(fake.api.doc.history).toHaveBeenCalledWith(SLUG);
  });

  it('enables Undo with the change label and shortcut in its tooltip', async () => {
    const host = await mount(UNDO);
    expect(button(host, 'Undo')?.disabled).toBe(false);
    expect(button(host, 'Undo')?.title).toBe("Undo: re-explained 'The particular…' (⌘Z)");
    expect(button(host, 'Redo')?.disabled).toBe(true);
  });

  it('disables both while the document has a busy section', async () => {
    const host = await mount({ ...UNDO, busy: true });
    expect(button(host, 'Undo')?.disabled).toBe(true);
    expect(button(host, 'Redo')?.disabled).toBe(true);
    expect(button(host, 'Undo')?.title).toBe('Wait for the section update to finish');
  });

  it('Undo calls main and shows the returned state; Redo swaps back', async () => {
    const host = await mount(UNDO);
    undoMock().mockResolvedValue(ok(REDO));
    await click(button(host, 'Undo'));
    expect(undoMock().mock.calls).toEqual([[SLUG]]);
    expect(button(host, 'Undo')?.disabled).toBe(true);
    expect(button(host, 'Redo')?.title).toBe("Redo: re-explained 'The particular…' (⇧⌘Z)");
    redoMock().mockResolvedValue(ok(UNDO));
    await click(button(host, 'Redo'));
    expect(redoMock().mock.calls).toEqual([[SLUG]]);
    expect(button(host, 'Undo')?.disabled).toBe(false);
  });

  it('shows a refusal inline', async () => {
    const host = await mount(UNDO);
    undoMock().mockResolvedValue({
      ok: false,
      error: { code: 'E_CONFLICT', message: 'Wait for the section update to finish' },
    });
    await click(button(host, 'Undo'));
    expect(host.querySelector('.inline-error')?.textContent).toBe('Wait for the section update to finish');
  });

  it('follows eli5:doc:history-changed for its own document only', async () => {
    const host = await mount(NONE);
    fake.emit('doc-history', { slug: 'other-doc', state: UNDO });
    expect(button(host, 'Undo')?.disabled).toBe(true);
    fake.emit('doc-history', { slug: SLUG, state: UNDO });
    expect(button(host, 'Undo')?.disabled).toBe(false);
    fake.emit('doc-history', { slug: SLUG, state: { ...UNDO, busy: true } });
    expect(button(host, 'Undo')?.disabled).toBe(true);
  });
});

describe('Cmd+Z / Shift+Cmd+Z (11 §9)', () => {
  it('matchHistoryKey maps Cmd+Z to undo and Shift+Cmd+Z to redo, in either case', () => {
    const k = (
      key: string,
      shiftKey = false,
      extra: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {},
    ) => ({
      key,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey,
      ...extra,
    });
    expect(matchHistoryKey(k('z'))).toBe('undo');
    expect(matchHistoryKey(k('Z', true))).toBe('redo');
    expect(matchHistoryKey(k('z', true))).toBe('redo');
    expect(matchHistoryKey(k('z', false, { metaKey: false }))).toBeNull();
    expect(matchHistoryKey(k('z', false, { altKey: true }))).toBeNull();
    expect(matchHistoryKey(k('z', false, { ctrlKey: true }))).toBeNull();
    expect(matchHistoryKey(k('y'))).toBeNull();
  });

  it('isTextEntry is true for text inputs, textareas and contenteditable, false for buttons and the body', () => {
    const text = document.createElement('input');
    const box = document.createElement('input');
    box.type = 'checkbox';
    const area = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inner = document.createElement('span');
    editable.append(inner);
    expect(isTextEntry(text)).toBe(true);
    expect(isTextEntry(area)).toBe(true);
    expect(isTextEntry(inner)).toBe(true);
    expect(isTextEntry(box)).toBe(false);
    expect(isTextEntry(document.createElement('button'))).toBe(false);
    expect(isTextEntry(document.body)).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });

  it('Cmd+Z outside text fields undoes and Shift+Cmd+Z redoes the document', async () => {
    await mount(UNDO);
    undoMock().mockResolvedValue(ok(REDO));
    await key(document.body, 'z', { metaKey: true });
    expect(undoMock().mock.calls).toEqual([[SLUG]]);
    redoMock().mockResolvedValue(ok(UNDO));
    await key(document.body, 'Z', { metaKey: true, shiftKey: true });
    expect(redoMock().mock.calls).toEqual([[SLUG]]);
  });

  it('leaves Cmd+Z to the text field when focus is in an input, textarea or contenteditable', async () => {
    await mount(UNDO);
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.append(input, area, editable);
    const prevented: boolean[] = [];
    for (const el of [input, area, editable]) {
      const e = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true });
      await act(async () => {
        el.dispatchEvent(e);
      });
      prevented.push(e.defaultPrevented);
    }
    await flush();
    expect(prevented).toEqual([false, false, false]);
    expect(undoMock().mock.calls).toEqual([]);
    input.remove();
    area.remove();
    editable.remove();
  });

  it('does nothing on Cmd+Z when there is nothing to undo', async () => {
    await mount(NONE);
    await key(document.body, 'z', { metaKey: true });
    expect(undoMock().mock.calls).toEqual([]);
  });
});

describe('DocHeader (11 §5.3)', () => {
  it('puts Undo and Redo left of Reveal in Finder', async () => {
    historyMock().mockResolvedValue(ok(UNDO));
    const host = await render(DocHeader as never, { slug: SLUG, entry: undefined });
    const names = Array.from(host.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names.slice(0, 3)).toEqual(['Undo', 'Redo', 'Reveal in Finder']);
  });
});
