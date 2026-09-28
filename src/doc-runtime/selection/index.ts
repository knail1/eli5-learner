// Selection bridge and inline action menu (08 §5). Installed only when window.eli5Doc exists
// (08 §2 item 6): snapshot, six actions + note, submit, busy marks and inline notices.
import type { DocBridge } from '../bridge';
import type { TabsApi } from '../tabs';
import { placeMenu } from './menu';
import { rangeText } from './text';

export const MENU_ACTIONS = [
  ['expand', 'Expand this'],
  ['reexplain', "This isn't clear, re-explain it"],
  ['analogy', 'Give me an analogy'],
  ['deeper', 'Go deeper'],
  ['eli5-tab', 'Create a separate ELI5 for this section'],
  ['eli5-selection', 'ELI5 this selection'],
] as const;
export type MenuActionId = (typeof MENU_ACTIONS)[number][0];

export const MAX_SELECTION_CHARS = 4000;
export const MAX_NOTE_CHARS = 200;
/** 08 §7.5: "ELI5 this selection" takes the whole selection up to this length. */
export const MAX_SELECTION_ELI5_CHARS = 12000;
export const TOO_LONG_NOTE = 'Too long to ELI5 as a selection (12,000 characters max)';
const DEBOUNCE_MS = 150;
const NOTICE_MS = 6000;
const EXCLUDED =
  "[data-eli5-noact], nav.tabbar, details.gl-note, section[data-eli5-actionable='false'], header.doc-head, footer.doc-foot";
/** Never part of the text the menu sends: glossary notes (08 §5.6) and the other excluded regions. */
const TEXT_EXCLUDED = EXCLUDED;

/** The whole selection for "ELI5 this selection" (08 §7.5): unclipped, paragraph breaks kept. */
export interface SelectionScope {
  text: string;
  /** Sections with selected text, in document order; the first is the snapshot's section. */
  sectionIds: string[];
  /** Longer than MAX_SELECTION_ELI5_CHARS: the action is disabled. */
  tooLong: boolean;
}

export interface SelectionSnapshot {
  tabKey: string;
  sectionId: string;
  heading: string;
  text: string;
  /** The selection spanned sections and was clipped to the start section (08 §5.3). */
  clipped: boolean;
  selection: SelectionScope;
}

function elementOf(n: Node): Element | null {
  return n.nodeType === 1 ? (n as Element) : n.parentElement;
}

function closestSection(n: Node): HTMLElement | null {
  return (elementOf(n)?.closest('section[data-section-id]') as HTMLElement | null) ?? null;
}

/** 08 §5.3 `enclosing(range)`. */
export function enclosing(range: Range): { section: HTMLElement; range: Range; clipped: boolean } | null {
  const a = closestSection(range.startContainer);
  if (!a) return null;
  if (elementOf(range.startContainer)?.closest(EXCLUDED)) return null;
  const b = closestSection(range.endContainer);
  if (b === a) return { section: a, range, clipped: false };
  const clipped = range.cloneRange();
  clipped.setEnd(a, a.childNodes.length);
  return { section: a, range: clipped, clipped: true };
}

/** 08 §5.3 text normalization: collapse whitespace, trim, cut at 4000 on a word boundary. */
export function normalizeSelection(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_SELECTION_CHARS) return t;
  const cut = t.slice(0, MAX_SELECTION_CHARS - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > 0 ? cut.slice(0, sp) : cut) + '…';
}

export function normalizeNote(s: string): string {
  return s
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, MAX_NOTE_CHARS);
}

const hasText = (s: string): boolean => s.replace(/\s/g, '').length > 0;

/** The part of `range` inside `el`, or null when they do not overlap. */
function within(range: Range, el: Element): Range | null {
  const doc = el.ownerDocument;
  const box = doc.createRange();
  box.selectNodeContents(el);
  // Range.START_TO_START 0, START_TO_END 1, END_TO_END 2, END_TO_START 3 (no global Range in tests).
  if (range.compareBoundaryPoints(3, box) >= 0) return null; // range starts at or after el's end
  if (range.compareBoundaryPoints(1, box) <= 0) return null; // range ends at or before el's start
  const r = range.cloneRange();
  if (range.compareBoundaryPoints(0, box) < 0) r.setStart(box.startContainer, box.startOffset);
  if (range.compareBoundaryPoints(2, box) > 0) r.setEnd(box.endContainer, box.endOffset);
  return r;
}

/** 08 §7.5: every actionable section of the start section's tab with selected text, start first. */
function selectionScope(range: Range, start: HTMLElement): SelectionScope {
  const panel = start.closest('.tabpanel') ?? start.parentElement;
  const ids: string[] = [start.dataset.sectionId ?? ''];
  for (const s of Array.from(panel?.querySelectorAll<HTMLElement>('section[data-section-id]') ?? [])) {
    if (s === start || s.matches("[data-eli5-actionable='false']")) continue;
    if (start.compareDocumentPosition(s) & 2) continue; // PRECEDING: before the start section
    const part = within(range, s);
    if (part && hasText(rangeText(part, TEXT_EXCLUDED))) ids.push(s.dataset.sectionId ?? '');
  }
  const text = rangeText(range, TEXT_EXCLUDED);
  return { text, sectionIds: ids, tooLong: text.length > MAX_SELECTION_ELI5_CHARS };
}

/** Snapshot of the current selection, or null when no menu should open (08 §5.2 steps 1-4). */
export function snapshotSelection(sel: Selection | null): SelectionSnapshot | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const full = sel.getRangeAt(0);
  const hit = enclosing(full);
  if (!hit) return null;
  const text = normalizeSelection(rangeText(hit.range, TEXT_EXCLUDED));
  if (text.replace(/\s/g, '').length < 3) return null;
  const panel = hit.section.closest<HTMLElement>('.tabpanel[data-tab-key]');
  const tabKey = panel?.dataset.tabKey ?? '';
  const sectionId = hit.section.dataset.sectionId ?? '';
  if (sectionId.slice(4, sectionId.lastIndexOf('-')) !== tabKey) return null;
  const heading = hit.section.querySelector(':scope > h2')?.textContent?.trim() ?? '';
  return { tabKey, sectionId, heading, text, clipped: hit.clipped, selection: selectionScope(full, hit.section) };
}

const MENU_CSS = `
:host{all:initial}
.m{position:absolute;z-index:30;display:flex;flex-direction:column;gap:6px;max-width:420px;padding:8px;border-radius:10px;
background:#1f2125;color:#f3f1ec;font:13px/1.3 -apple-system,'Helvetica Neue',Arial,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25)}
.m[hidden]{display:none}
input{font:inherit;padding:6px 8px;border-radius:6px;border:1px solid #555;background:#2b2e33;color:inherit}
.acts{display:flex;flex-wrap:wrap;gap:4px}
button{font:inherit;font-weight:600;color:inherit;background:#34373d;border:0;border-radius:6px;padding:6px 8px;cursor:pointer}
button:focus-visible,button:hover{background:#4a4e56;outline:none}
button:disabled{opacity:.45;cursor:default}
.hint,.cap{color:#c9c5bd}
.hint:empty,.cap:empty{display:none}
@media print{.m{display:none}}`;

/** 08 §5.5 step 2: the label under the heading while a section is busy. */
const BUSY_LABEL: Record<string, string> = { 'eli5-tab': 'Creating ELI5 tab…', 'eli5-selection': 'Creating ELI5 tab…' };
const busyLabel = (action: string): string => BUSY_LABEL[action] ?? 'Updating…';

export interface SelectionController {
  /** For tests: the menu's (closed) shadow root. */
  readonly root: ShadowRoot;
  current(): SelectionSnapshot | null;
  open(s: SelectionSnapshot, range?: Range): void;
  close(): void;
  submit(action: MenuActionId, note?: string): Promise<void>;
  setBusy(busy: { sectionId: string; action: string }[]): void;
}

interface HighlightHost {
  CSS?: { highlights?: { set(k: string, v: unknown): void; delete(k: string): void } };
  Highlight?: new (r: Range) => unknown;
}

function lastRect(range: Range | null): { left: number; top: number; bottom: number; width: number } | undefined {
  if (!range || typeof range.getClientRects !== 'function') return undefined;
  const rects = range.getClientRects();
  return rects.length > 0 ? rects[rects.length - 1] : undefined;
}

export function initSelection(doc: Document, win: Window, bridge: DocBridge, tabs?: TabsApi): SelectionController {
  const host = doc.createElement('div');
  host.setAttribute('data-eli5-noact', '');
  doc.body.appendChild(host);
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = MENU_CSS;
  const menu = doc.createElement('div');
  menu.className = 'm';
  menu.setAttribute('role', 'toolbar');
  menu.setAttribute('aria-label', 'Section actions');
  menu.hidden = true;
  const hint = doc.createElement('div');
  hint.className = 'hint';
  hint.setAttribute('aria-live', 'polite');
  const note = doc.createElement('input');
  note.type = 'text';
  note.placeholder = 'Add a note (optional)';
  note.maxLength = MAX_NOTE_CHARS;
  note.setAttribute('aria-label', 'Note for this action');
  const acts = doc.createElement('div');
  acts.className = 'acts';
  const buttons = MENU_ACTIONS.map(([id, label], i) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.action = id;
    b.tabIndex = i === 0 ? 0 : -1;
    acts.appendChild(b);
    return b;
  });
  const cap = doc.createElement('div');
  cap.className = 'cap';
  menu.append(hint, note, acts, cap);
  root.append(style, menu);

  let snap: SelectionSnapshot | null = null;
  let snapRange: Range | null = null;
  const busy = new Set<string>();
  const hl = win as unknown as HighlightHost;

  const setHighlight = (range: Range | null): void => {
    const reg = hl.CSS?.highlights;
    if (!reg) return;
    if (range && hl.Highlight) reg.set('eli5-pending', new hl.Highlight(range));
    else reg.delete('eli5-pending');
  };

  const place = (): void => {
    const r = lastRect(snapRange);
    const bar = doc.querySelector('nav.tabbar');
    const p = placeMenu({
      anchor: r ?? { left: 0, top: 0, bottom: 0, width: 0 },
      menu: { width: menu.offsetWidth || 320, height: menu.offsetHeight || 90 },
      viewport: { width: win.innerWidth || doc.documentElement.clientWidth, height: win.innerHeight },
      scroll: { x: win.scrollX, y: win.scrollY },
      tabbarBottom: bar?.getBoundingClientRect().bottom ?? 0,
    });
    menu.style.left = `${String(p.left)}px`;
    menu.style.top = `${String(p.top)}px`;
    menu.style.width = p.width !== undefined ? `${String(p.width)}px` : '';
  };

  const focusAction = (i: number): void => {
    const n = buttons.length;
    const k = ((i % n) + n) % n;
    buttons.forEach((b, j) => (b.tabIndex = j === k ? 0 : -1));
    buttons[k]?.focus();
  };

  const ctl: SelectionController = {
    root,
    current: () => snap,
    open(s, range) {
      snap = s;
      snapRange = range ?? null;
      const isBusy = busy.has(s.sectionId);
      hint.textContent = isBusy ? 'This section is being updated' : s.clipped ? `Applies to: ${s.heading}` : '';
      const tooLong = s.selection.tooLong;
      for (const b of buttons) b.disabled = isBusy || (tooLong && b.dataset.action === 'eli5-selection');
      cap.textContent = tooLong && !isBusy ? TOO_LONG_NOTE : '';
      buttons.forEach((b, j) => (b.tabIndex = j === 0 ? 0 : -1));
      note.value = '';
      menu.hidden = false;
      setHighlight(snapRange);
      place();
    },
    close() {
      snap = null;
      snapRange = null;
      menu.hidden = true;
      setHighlight(null);
    },
    async submit(action, rawNote) {
      const s = snap;
      if (!s || busy.has(s.sectionId)) return;
      if (action === 'eli5-selection' && s.selection.tooLong) return;
      ctl.close();
      const section = doc.getElementById(s.sectionId);
      markBusy(doc, section, action);
      const n = normalizeNote(rawNote ?? '');
      const base = { tabKey: s.tabKey, sectionId: s.sectionId, selectionText: s.text, ...(n ? { note: n } : {}) };
      let res: { ok: boolean; error?: { message?: string } };
      try {
        if (action === 'eli5-selection') {
          // 08 §7.5: the whole selection, anchored to the first section it covers.
          res = await bridge.createSectionEli5({
            ...base,
            selectionText: s.selection.text,
            scope: 'selection',
            sectionIds: s.selection.sectionIds,
          });
        } else {
          res =
            action === 'eli5-tab'
              ? await bridge.createSectionEli5(base)
              : await bridge.regenerateSection({ ...base, action });
        }
      } catch (e) {
        res = { ok: false, error: { message: e instanceof Error ? e.message : 'Something went wrong' } };
      }
      if (!res.ok) {
        markBusy(doc, section, null);
        showNotice(doc, section, res.error?.message ?? 'Something went wrong');
      }
    },
    setBusy(list) {
      busy.clear();
      for (const b of list) busy.add(b.sectionId);
      for (const el of Array.from(doc.querySelectorAll<HTMLElement>('section[data-eli5-busy]'))) {
        if (!busy.has(el.id)) markBusy(doc, el, null);
      }
      for (const b of list) markBusy(doc, doc.getElementById(b.sectionId), b.action);
    },
  };

  for (const [i, b] of buttons.entries()) {
    b.addEventListener('click', () => void ctl.submit(b.dataset.action as MenuActionId, note.value));
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') focusAction(i + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') focusAction(i - 1);
      else return;
      e.preventDefault();
    });
  }
  note.addEventListener('keydown', (e) => {
    // Enter never submits, so a half-typed note cannot fire the wrong action (08 §5.4).
    if (e.key === 'Enter') {
      e.preventDefault();
      focusAction(0);
    }
  });
  /**
   * The range Esc restored (08 §5.4). Restoring fires selectionchange; the menu stays closed while
   * the live selection is still exactly this range.
   */
  let dismissed: Range | null = null;
  const isDismissed = (sel: Selection): boolean => {
    const d = dismissed;
    if (!d || sel.rangeCount === 0) return false;
    const r = sel.getRangeAt(0);
    const same =
      r.startContainer === d.startContainer &&
      r.startOffset === d.startOffset &&
      r.endContainer === d.endContainer &&
      r.endOffset === d.endOffset;
    if (!same) dismissed = null;
    return same;
  };
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const range = snapRange;
    ctl.close();
    if (range) {
      dismissed = range.cloneRange();
      const sel = doc.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      const sel = doc.getSelection();
      const s = snapshotSelection(sel);
      if (s && sel) {
        if (isDismissed(sel)) return;
        const hit = enclosing(sel.getRangeAt(0));
        ctl.open(s, hit ? hit.range.cloneRange() : undefined);
      } else if (!host.matches(':focus-within')) ctl.close();
    }, DEBOUNCE_MS);
  };
  doc.addEventListener('mouseup', (e) => {
    if (e.target !== host) check();
  });
  doc.addEventListener('keyup', (e) => {
    if (e.shiftKey || e.key === 'Home' || e.key === 'End') check();
  });
  doc.addEventListener('selectionchange', check);
  doc.addEventListener('mousedown', (e) => {
    if (e.target !== host) dismissed = null;
    if (e.target !== host && !menu.hidden) ctl.close();
  });
  // Cmd+. (Ctrl+. elsewhere) moves focus into the open menu (08 §5.2 step 7).
  doc.addEventListener('keydown', (e) => {
    if (e.key === '.' && (e.metaKey || e.ctrlKey) && !menu.hidden) {
      e.preventDefault();
      note.focus();
    }
  });
  // Reposition on scroll and resize; close once the anchor leaves the viewport (08 §5.4).
  const follow = (): void => {
    if (menu.hidden) return;
    const r = lastRect(snapRange);
    if (r && (r.bottom < 0 || r.top > win.innerHeight)) ctl.close();
    else place();
  };
  win.addEventListener('scroll', follow, { passive: true });
  win.addEventListener('resize', follow);
  tabs?.onChange(() => ctl.close());
  bridge.onSectionBusy((e) => {
    ctl.setBusy(e.busy);
    for (const n of e.notices ?? []) showNotice(doc, doc.getElementById(n.sectionId), n.message);
  });
  return ctl;
}

/** 08 §5.5 step 2: `data-eli5-busy` plus an aria-live label under the heading; null clears both. */
function markBusy(doc: Document, section: HTMLElement | null, action: string | null): void {
  if (!section) return;
  let label = section.querySelector<HTMLElement>(':scope > .eli5-busy-label');
  if (action === null) {
    section.removeAttribute('data-eli5-busy');
    label?.remove();
    return;
  }
  section.setAttribute('data-eli5-busy', action);
  if (!label) {
    label = doc.createElement('span');
    label.className = 'eli5-busy-label';
    label.setAttribute('aria-live', 'polite');
    label.setAttribute('data-eli5-noact', '');
    const h = section.querySelector(':scope > h2');
    if (h) h.after(label);
    else section.prepend(label);
  }
  label.textContent = busyLabel(action);
}

/** Inline, non-modal failure notice under the section heading (08 §5.5 step 4, §9). */
function showNotice(doc: Document, section: HTMLElement | null, message: string): void {
  if (!section) return;
  const p = doc.createElement('p');
  p.className = 'eli5-notice';
  p.setAttribute('role', 'status');
  p.setAttribute('data-eli5-noact', '');
  p.textContent = message;
  const h = section.querySelector(':scope > h2');
  if (h) h.after(p);
  else section.prepend(p);
  const remove = (): void => p.remove();
  p.addEventListener('click', remove);
  setTimeout(remove, NOTICE_MS);
}
