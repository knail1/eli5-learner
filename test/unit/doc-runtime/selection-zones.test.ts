import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBridge, loadGolden, loadRuntime, selectText, type Runtime, type TestWindow } from './dom';

/** Selection zones (08 §5.6): body selections skip glossary notes; a note selection stays in its note. */

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

const FIRST = '#tab-indepth > section:nth-of-type(1)';
const NOTE = `${FIRST} details.gl-note`;

function mousedown(win: TestWindow, el: Element | null): void {
  el?.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, button: 0 }));
}

function selectionChange(win: TestWindow, doc: Document): void {
  doc.dispatchEvent(new win.Event('selectionchange'));
}

/** A copy event whose clipboardData records what the handler wrote. */
function copy(win: TestWindow, doc: Document): { event: Event; data: Record<string, string> } {
  const data: Record<string, string> = {};
  const event = new win.Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { setData: (t: string, v: string) => (data[t] = v), getData: (t: string) => data[t] ?? '' },
  });
  doc.dispatchEvent(event);
  return { event, data };
}

describe('selection zones (08 §5.6)', () => {
  it('runs in a plain browser too and defaults to the body zone', () => {
    const { win, doc } = loadGolden('with-tab');
    rt.boot(win, doc);
    const root = doc.documentElement;
    expect(root.classList.contains('eli5-sel-note')).toBe(false);
    mousedown(win, doc.querySelector(`${NOTE} p`));
    expect(root.classList.contains('eli5-sel-note')).toBe(true);
    expect(doc.querySelector(NOTE)?.hasAttribute('data-eli5-sel')).toBe(true);
    mousedown(win, doc.querySelector(`${FIRST} p`));
    expect(root.classList.contains('eli5-sel-note')).toBe(false);
    expect(doc.querySelector('[data-eli5-sel]')).toBeNull();
  });

  it('a mousedown on an inline glossary term stays in the body zone', () => {
    const { win, doc } = loadGolden('with-tab');
    rt.boot(win, doc);
    mousedown(win, doc.querySelector(`${FIRST} dfn.gl-term`));
    expect(doc.documentElement.classList.contains('eli5-sel-note')).toBe(false);
  });

  it('clamps a selection that starts in a note to that note', () => {
    const { win, doc } = loadGolden('with-tab');
    rt.boot(win, doc);
    const note = doc.querySelector(NOTE);
    mousedown(win, note?.querySelector('p') ?? null);
    selectText(doc, `${NOTE} p`, 'Revenue earned', `${FIRST} ul li`);
    selectionChange(win, doc);
    const sel = doc.getSelection();
    const range = sel?.getRangeAt(0);
    expect(note?.contains(range?.startContainer ?? null)).toBe(true);
    expect(note?.contains(range?.endContainer ?? null) || range?.endContainer === note).toBe(true);
    expect(sel?.toString()).not.toContain('Paid search');
    expect(sel?.toString()).toContain('per $1 spent.');
  });

  it('moves the end of a body selection out of a note it lands in', () => {
    const { win, doc } = loadGolden('with-tab');
    rt.boot(win, doc);
    mousedown(win, doc.querySelector(`${FIRST} p`));
    selectText(doc, `${FIRST} p`, 'judges every channel', `${NOTE} p`);
    selectionChange(win, doc);
    const range = doc.getSelection()?.getRangeAt(0);
    const note = doc.querySelector(NOTE);
    expect(note?.contains(range?.endContainer ?? null)).toBe(false);
    expect(range?.toString()).toContain('judges every channel');
  });

  it('keeps glossary notes out of copied body text', () => {
    const { win, doc } = loadGolden('with-tab');
    rt.boot(win, doc);
    selectText(doc, `${FIRST} p`, 'judges every channel', `${FIRST} ul li`);
    const { event, data } = copy(win, doc);
    expect(event.defaultPrevented).toBe(true);
    expect(data['text/plain']).toContain('judges every channel');
    expect(data['text/plain']).toMatch(/every dollar\. See the pricing page\.\n\nPaid$/);
    expect(data['text/plain']).not.toContain('Revenue earned for each dollar spent on ads');
    expect(data['text/plain']).not.toContain('return on ad spend');
    expect(data['text/html']).not.toContain('gl-note');
  });

  it('leaves a copy without notes to the browser', () => {
    const { win, doc } = loadGolden('with-tab');
    rt.boot(win, doc);
    selectText(doc, `${FIRST} p`, 'judges every channel');
    expect(copy(win, doc).event.defaultPrevented).toBe(false);
  });

  it('Select All takes the visible tab in the body zone, and only the note in the note zone', () => {
    const { win, doc } = loadGolden('with-tab');
    rt.boot(win, doc);
    const key = (): KeyboardEvent => {
      const e = new win.KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true });
      doc.body.dispatchEvent(e);
      return e;
    };
    expect(key().defaultPrevented).toBe(true);
    let range = doc.getSelection()?.getRangeAt(0);
    const panel = doc.getElementById('tab-indepth');
    expect(range?.startContainer).toBe(panel);
    expect(range?.endContainer).toBe(panel);

    const note = doc.querySelector(NOTE);
    mousedown(win, note?.querySelector('p') ?? null);
    expect(key().defaultPrevented).toBe(true);
    range = doc.getSelection()?.getRangeAt(0);
    expect(range?.startContainer).toBe(note);
    expect(doc.getSelection()?.toString()).toContain('Revenue earned');
    expect(doc.getSelection()?.toString()).not.toContain('judges every channel');
  });

  it('Select All inside a text field is left alone', () => {
    const { win, doc } = loadGolden('with-tab');
    rt.boot(win, doc);
    const input = doc.createElement('input');
    doc.body.appendChild(input);
    const e = new win.KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('the stylesheet gates the zones on html.js and never touches print', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../../src/doc-runtime/index.css'), 'utf8');
    expect(css).toMatch(/html\.js:not\(\.eli5-sel-note\) \.gl-note \{[^}]*user-select: none/);
    expect(css).toMatch(/html\.js\.eli5-sel-note body \{[^}]*user-select: none/);
    expect(css).toMatch(/\.gl-note\[data-eli5-sel\][^{]*\{[^}]*user-select: text/);
    const print = css.slice(css.indexOf('@media print'));
    expect(print).not.toContain('user-select');
  });
});

describe('menu text with glossary notes (08 §5.3)', () => {
  it('a body selection across a note sends text without the note', () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    const h = rt.boot(win, doc);
    selectText(doc, `${FIRST} p`, 'judges every channel', `${FIRST} ul li`);
    doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    vi.advanceTimersByTime(200);
    const text = h.selection?.current()?.text ?? '';
    expect(text).toContain('judges every channel');
    expect(text).toContain('Paid');
    expect(text).not.toContain('return on ad spend');
    expect(text).not.toContain('Revenue earned for each dollar spent on ads');
  });

  it('a selection inside a note opens no menu', () => {
    const bridge = fakeBridge();
    const { win, doc } = loadGolden('with-tab', { bridge });
    const h = rt.boot(win, doc);
    mousedown(win, doc.querySelector(`${NOTE} p`));
    selectText(doc, `${NOTE} p`, 'Revenue earned');
    doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    vi.advanceTimersByTime(200);
    expect(h.selection?.current()).toBeNull();
  });
});
