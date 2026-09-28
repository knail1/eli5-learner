// Selection bridge and minimal inline action menu (08 §5). Installed only when window.eli5Doc
// exists (08 §2 item 6). M1 scope: snapshot, five actions + note, submit, busy marks.
import type { DocBridge } from './bridge';

export const MENU_ACTIONS = [
  ['expand', 'Expand this'],
  ['reexplain', "This isn't clear, re-explain it"],
  ['analogy', 'Give me an analogy'],
  ['deeper', 'Go deeper'],
  ['eli5-tab', 'Create a separate ELI5 for this section'],
] as const;
export type MenuActionId = (typeof MENU_ACTIONS)[number][0];

export const MAX_SELECTION_CHARS = 4000;
export const MAX_NOTE_CHARS = 200;
const EXCLUDED =
  "[data-eli5-noact], nav.tabbar, details.gl-note, section[data-eli5-actionable='false'], header.doc-head, footer.doc-foot";

export interface SelectionSnapshot {
  tabKey: string;
  sectionId: string;
  heading: string;
  text: string;
  /** The selection spanned sections and was clipped to the start section (08 §5.3). */
  clipped: boolean;
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

/** Snapshot of the current selection, or null when no menu should open (08 §5.2 steps 1-4). */
export function snapshotSelection(sel: Selection | null): SelectionSnapshot | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const hit = enclosing(sel.getRangeAt(0));
  if (!hit) return null;
  const text = normalizeSelection(hit.range.toString());
  if (text.replace(/\s/g, '').length < 3) return null;
  const panel = hit.section.closest<HTMLElement>('.tabpanel[data-tab-key]');
  const tabKey = panel?.dataset.tabKey ?? '';
  const sectionId = hit.section.dataset.sectionId ?? '';
  if (sectionId.slice(4, sectionId.lastIndexOf('-')) !== tabKey) return null;
  const heading = hit.section.querySelector(':scope > h2')?.textContent?.trim() ?? '';
  return { tabKey, sectionId, heading, text, clipped: hit.clipped };
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
.hint{color:#c9c5bd}
@media print{.m{display:none}}`;

export interface SelectionController {
  /** For tests: the menu's (closed) shadow root. */
  readonly root: ShadowRoot;
  current(): SelectionSnapshot | null;
  open(s: SelectionSnapshot): void;
  close(): void;
  submit(action: MenuActionId, note?: string): Promise<void>;
  setBusy(busy: { sectionId: string; action: string }[]): void;
}

export function initSelection(doc: Document, win: Window, bridge: DocBridge): SelectionController {
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
  const buttons = MENU_ACTIONS.map(([id, label]) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.action = id;
    acts.appendChild(b);
    return b;
  });
  menu.append(hint, note, acts);
  root.append(style, menu);

  let snap: SelectionSnapshot | null = null;
  const busy = new Set<string>();

  const place = (): void => {
    const sel = doc.getSelection();
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : undefined;
    const rects = typeof range?.getClientRects === 'function' ? range.getClientRects() : undefined;
    const r = rects && rects.length > 0 ? rects[rects.length - 1] : undefined;
    const x = (r ? r.left + r.width / 2 : 0) + win.scrollX;
    const y = (r ? r.top : 0) + win.scrollY;
    menu.style.left = `${Math.max(8, Math.round(x - 160))}px`;
    menu.style.top = `${Math.max(8, Math.round(y - 8 - 90))}px`;
  };

  const ctl: SelectionController = {
    root,
    current: () => snap,
    open(s) {
      snap = s;
      const isBusy = busy.has(s.sectionId);
      hint.textContent = isBusy ? 'This section is being updated' : s.clipped ? `Applies to: ${s.heading}` : '';
      for (const b of buttons) b.disabled = isBusy;
      note.value = '';
      menu.hidden = false;
      place();
    },
    close() {
      snap = null;
      menu.hidden = true;
    },
    async submit(action, rawNote) {
      const s = snap;
      if (!s || busy.has(s.sectionId)) return;
      ctl.close();
      const section = doc.getElementById(s.sectionId);
      section?.setAttribute('data-eli5-busy', action);
      const n = normalizeNote(rawNote ?? '');
      const base = { tabKey: s.tabKey, sectionId: s.sectionId, selectionText: s.text, ...(n ? { note: n } : {}) };
      let res: { ok: boolean; error?: { message?: string } };
      try {
        res =
          action === 'eli5-tab'
            ? await bridge.createSectionEli5(base)
            : await bridge.regenerateSection({ ...base, action });
      } catch (e) {
        res = { ok: false, error: { message: e instanceof Error ? e.message : 'Something went wrong' } };
      }
      if (!res.ok) {
        section?.removeAttribute('data-eli5-busy');
        showNotice(doc, section, res.error?.message ?? 'Something went wrong');
      }
    },
    setBusy(list) {
      busy.clear();
      for (const b of list) busy.add(b.sectionId);
      for (const el of Array.from(doc.querySelectorAll('section[data-eli5-busy]'))) {
        if (!busy.has(el.id)) el.removeAttribute('data-eli5-busy');
      }
      for (const b of list) doc.getElementById(b.sectionId)?.setAttribute('data-eli5-busy', b.action);
    },
  };

  for (const b of buttons) {
    b.addEventListener('click', () => void ctl.submit(b.dataset.action as MenuActionId, note.value));
  }
  note.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      buttons[0]?.focus();
    }
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ctl.close();
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      const s = snapshotSelection(doc.getSelection());
      if (s) ctl.open(s);
      else if (!host.matches(':focus-within')) ctl.close();
    }, 150);
  };
  doc.addEventListener('mouseup', (e) => {
    if (e.target !== host) check();
  });
  doc.addEventListener('keyup', (e) => {
    if (e.shiftKey || e.key === 'Home' || e.key === 'End') check();
  });
  doc.addEventListener('mousedown', (e) => {
    if (e.target !== host && !menu.hidden) ctl.close();
  });
  bridge.onSectionBusy((e) => ctl.setBusy(e.busy));
  return ctl;
}

/** Inline, non-modal failure notice under the section heading (08 §5.5 step 4). */
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
  setTimeout(remove, 6000);
}
