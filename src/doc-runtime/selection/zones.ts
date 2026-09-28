// Selection zones (08 §5.6). Glossary margin notes sit between the body's blocks in the DOM, so a
// plain drag through the body would select them too. Two zones keep them apart:
// - body (default): notes are `user-select: none`, clamped out of the selection and out of copies;
// - note: a selection that starts in a note stays inside that note; the rest of the page is
//   `user-select: none` until the next selection starts elsewhere.
// The zone follows where the selection starts: set on mousedown (before the browser starts the
// selection) and kept in sync on selectionchange for keyboard selections. Runs with or without the
// app; without JS the CSS rules (gated on html.js) do nothing.
import { NOTE_SELECTOR, blockText, filteredContents } from './text';

export const NOTE_ZONE_CLASS = 'eli5-sel-note';
export const ACTIVE_NOTE_ATTR = 'data-eli5-sel';

export type SelectionZone = 'body' | 'note';

export interface ZonesApi {
  zone(): SelectionZone;
}

function elementOf(n: Node | null): Element | null {
  if (!n) return null;
  return n.nodeType === 1 ? (n as Element) : n.parentElement;
}

const noteOf = (n: Node | null): HTMLElement | null =>
  (elementOf(n)?.closest(NOTE_SELECTOR) as HTMLElement | null) ?? null;

/** Text fields and editable regions keep the browser's own Select All. */
function editable(el: Element | null): boolean {
  if (!el) return false;
  if (el.closest('[data-eli5-noact]')) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable === true;
}

export function initSelectionZones(doc: Document): ZonesApi {
  const root = doc.documentElement;
  let active: HTMLElement | null = null;

  const enter = (note: HTMLElement | null): void => {
    if (note === active) return;
    active?.removeAttribute(ACTIVE_NOTE_ATTR);
    active = note;
    if (note) note.setAttribute(ACTIVE_NOTE_ATTR, '');
    root.classList.toggle(NOTE_ZONE_CLASS, note !== null);
  };

  doc.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0) return;
      enter(noteOf(e.target as Node | null));
    },
    true,
  );

  /** Keeps the selection inside its zone; each fix fires one more (no-op) selectionchange. */
  const clamp = (): void => {
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return;
    const anchorNote = noteOf(sel.anchorNode);
    enter(anchorNote);
    if (sel.isCollapsed || !sel.focusNode) return;
    const focusNote = noteOf(sel.focusNode);
    if (anchorNote) {
      if (focusNote === anchorNote) return;
      // Forward past the note: stop at its end; backward: at its start.
      const forward = (anchorNote.compareDocumentPosition(sel.focusNode) & 4) !== 0; // FOLLOWING
      sel.setBaseAndExtent(sel.anchorNode, sel.anchorOffset, anchorNote, forward ? anchorNote.childNodes.length : 0);
      return;
    }
    if (focusNote) {
      const parent = focusNote.parentNode;
      if (!parent) return;
      const index = Array.prototype.indexOf.call(parent.childNodes, focusNote) as number;
      const forward = (sel.anchorNode.compareDocumentPosition(focusNote) & 4) !== 0;
      // Just before the note when moving forward, just after it when moving backward.
      sel.setBaseAndExtent(sel.anchorNode, sel.anchorOffset, parent, forward ? index : index + 1);
    }
  };
  doc.addEventListener('selectionchange', clamp);

  // Copy of a body selection: the notes it spans stay off the clipboard (08 §5.6).
  doc.addEventListener('copy', (e) => {
    const sel = doc.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || noteOf(sel.anchorNode)) return;
    const range = sel.getRangeAt(0);
    const notes = Array.from(doc.querySelectorAll(NOTE_SELECTOR));
    if (!notes.some((n) => range.intersectsNode(n))) return;
    const data = (e as ClipboardEvent).clipboardData;
    if (!data) return;
    const frag = filteredContents(range, NOTE_SELECTOR);
    const box = doc.createElement('div');
    box.appendChild(frag.cloneNode(true));
    data.setData('text/plain', blockText(frag));
    data.setData('text/html', box.innerHTML);
    e.preventDefault();
  });

  // Select All: the visible tab in the body zone, the note alone in the note zone.
  doc.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'a' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    if (editable(e.target as Element | null)) return;
    const target =
      active && active.isConnected
        ? active
        : (doc.querySelector<HTMLElement>('.tabpanel[data-tab-key]:not([hidden])') ?? doc.querySelector('main'));
    if (!target) return;
    const sel = doc.getSelection();
    if (!sel) return;
    e.preventDefault();
    const range = doc.createRange();
    range.selectNodeContents(target);
    sel.removeAllRanges();
    sel.addRange(range);
  });

  return { zone: () => (active ? 'note' : 'body') };
}
