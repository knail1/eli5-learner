// Selection bridge and inline action menu (08 §5). Installed only when window.eli5Doc exists
// (08 §2 item 6): snapshot, the Ask field, the grouped actions + note, submit, busy marks and
// inline notices.
import type { DocBridge } from '../bridge';
import type { TabsApi } from '../tabs';
import { placeMenu } from './menu';
import { drawPending, pendingRects } from './pending';
import { rangeText } from './text';

/** 08 §5.1: the popup groups of the toolbar, in order. */
export const MENU_GROUPS = [
  {
    id: 'explain',
    label: 'Explain',
    items: [
      ['expand', 'Expand this'],
      ['reexplain', "This isn't clear, re-explain it"],
      ['analogy', 'Give me an analogy'],
      ['deeper', 'Go deeper'],
    ],
  },
  {
    id: 'eli5',
    label: 'ELI5',
    items: [
      ['eli5-tab', 'Create a separate ELI5 for this section'],
      ['eli5-selection', 'ELI5 this selection'],
    ],
  },
] as const;
/** The toolbar's plain button after the popup triggers. */
export const EDIT_ACTION = ['revise', 'Edit with my note'] as const;
type MenuItem = (typeof MENU_GROUPS)[number]['items'][number];
/** The six popup items, flattened in order (for tests). */
export const MENU_ACTIONS: readonly MenuItem[] = MENU_GROUPS.flatMap((g): readonly MenuItem[] => g.items);
export type MenuActionId = MenuItem[0] | (typeof EDIT_ACTION)[0] | AskActionId;
/** 08 §5.1: the three Ask buttons, in row order. */
export type AskActionId = 'ask' | 'ask-deep' | 'ask-deeper';
export const ASK_ACTIONS: readonly AskActionId[] = ['ask', 'ask-deep', 'ask-deeper'];
/** 08 §5.1: each Ask button's exact label (its accessible name; the ⓘ marker is aria-hidden). */
export const ASK_LABELS: Readonly<Record<AskActionId, string>> = {
  ask: 'Ask',
  'ask-deep': 'Ask deep',
  'ask-deeper': 'Ask deeper',
};
/** 08 §5.1: the tooltip shown on hover and focus, also each button's accessible description. */
export const ASK_TOOLTIPS: Readonly<Record<AskActionId, string>> = {
  ask: 'Answers from this section and the sections around it. Fastest. (Enter)',
  'ask-deep': 'Also searches every tab and the original source text. (⌘ Enter or Ctrl+Enter)',
  'ask-deeper':
    "Searches every tab and the original sources first, then the web, then the AI's general knowledge. Anything from outside the document is marked. (⌘ ⇧ Enter or Ctrl+Shift+Enter)",
};
/** 08 §5.4: the shortcuts typed in the question field. */
export const ASK_KEYSHORTCUTS: Readonly<Record<AskActionId, string>> = {
  ask: 'Enter',
  'ask-deep': 'Meta+Enter Control+Enter',
  'ask-deeper': 'Meta+Shift+Enter Control+Shift+Enter',
};
/** 08 §6.9: the Ask deep button. */
export const DEEP_ASK_LABEL = ASK_LABELS['ask-deep'];
export const DEEP_ASK_DESCRIPTION = ASK_TOOLTIPS['ask-deep'];
export const DEEP_ASK_KEYSHORTCUTS = ASK_KEYSHORTCUTS['ask-deep'];
/** 08 §6.10: the Ask deeper button. */
export const DEEPER_ASK_LABEL = ASK_LABELS['ask-deeper'];
export const DEEPER_ASK_DESCRIPTION = ASK_TOOLTIPS['ask-deeper'];
export const DEEPER_ASK_KEYSHORTCUTS = ASK_KEYSHORTCUTS['ask-deeper'];
/** Tooltip geometry (08 §5.1): gap to the button, viewport margin, widest. */
const TIP_GAP = 6;
const TIP_MARGIN = 8;
const TIP_MAX_WIDTH = 260;

export const MAX_SELECTION_CHARS = 4000;
export const MAX_NOTE_CHARS = 200;
export const MAX_QUESTION_CHARS = 500;
/** Non-space characters a question needs before Ask enables. */
export const MIN_QUESTION_CHARS = 3;
/** 08 §7.5: "ELI5 this selection" takes the whole selection up to this length. */
export const MAX_SELECTION_ELI5_CHARS = 12000;
export const TOO_LONG_NOTE = 'Too long to ELI5 as a selection (12,000 characters max)';
const DEBOUNCE_MS = 150;
const NOTICE_MS = 6000;
const EXCLUDED =
  "[data-eli5-noact], nav.tabbar, details.gl-note, details.qa-q, figure.animation, section[data-eli5-actionable='false'], header.doc-head, footer.doc-foot";
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

/** The question is collapsed to one line and cut to 500 characters (08 §5.1). */
export function normalizeQuestion(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION_CHARS);
}

const nonSpace = (s: string): number => s.replace(/\s/g, '').length;
const hasText = (s: string): boolean => nonSpace(s) > 0;

/** "Edit with my note" needs a note: the note is its only instruction (08 §5.1). */
const needsNote = (action: string): boolean => action === 'revise';

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
.m{position:absolute;z-index:30;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;width:340px;max-width:420px;
padding:8px;border-radius:10px;background:var(--eli5-menu-bg,#1f2125);color:#f3f1ec;font:13px/1.3 -apple-system,'Helvetica Neue',Arial,sans-serif;
border:1px solid var(--eli5-menu-rule,#1f2125);box-shadow:var(--eli5-menu-shadow,0 6px 24px rgba(0,0,0,.25))}
.m[hidden],.ask[hidden],.pop[hidden]{display:none}
input{font:inherit;min-width:0;padding:6px 8px;border-radius:6px;border:1px solid #555;background:#2b2e33;color:inherit}
.ask{display:flex;flex-wrap:wrap;gap:4px}
input.q{flex:1 1 120px}
.askb{display:flex;gap:4px;flex:1 0 auto}
.askb button{flex:1 1 auto;display:inline-flex;align-items:center;justify-content:center}
.askb button:disabled{pointer-events:none}
.askb button[hidden]{display:none}
.info{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:12px;height:12px;margin-left:5px;
border:1px solid currentColor;border-radius:50%;font:italic 700 8px/1 Georgia,'Times New Roman',serif;opacity:.8}
.tip{position:absolute;z-index:1;box-sizing:border-box;max-width:260px;padding:6px 8px;border-radius:6px;background:#f3f1ec;color:#1f2125;
font:12px/1.35 -apple-system,'Helvetica Neue',Arial,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35);pointer-events:none;white-space:normal}
.tip[hidden]{display:none}
.acts{display:flex;flex-wrap:wrap;gap:4px}
button{font:inherit;font-weight:600;color:inherit;background:#34373d;border:0;border-radius:6px;padding:6px 8px;cursor:pointer}
button:focus-visible,button:hover{background:#4a4e56;outline:none}
button:disabled{opacity:.45;cursor:default}
.go{flex:none;white-space:nowrap}
.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.trig{display:inline-flex;align-items:center;gap:6px}
.caret{width:0;height:0;border:4px solid transparent;border-top:5px solid currentColor;border-bottom:0;transition:transform .15s}
.trig[aria-expanded=true] .caret{transform:rotate(180deg)}
.pop{display:flex;flex-direction:column;gap:2px;padding:4px;border-radius:8px;background:#2b2e33}
[role=menuitem]{min-height:28px;text-align:left;font-weight:500;background:transparent}
[role=menuitem]:focus-visible,[role=menuitem]:hover{background:#4a4e56}
.hint,.cap{margin:0;color:#c9c5bd}
.hint:empty,.cap:empty{display:none}
@media (prefers-reduced-motion:reduce){.caret{transition:none}}
@media print{.m{display:none}}`;

/** 08 §5.5 step 2: the label under the heading while a section is busy. */
const BUSY_LABEL: Record<string, string> = {
  ask: 'Answering…',
  'ask-deep': 'Answering in depth…',
  'ask-deeper': 'Searching further…',
  'eli5-tab': 'Creating ELI5 tab…',
  'eli5-selection': 'Creating ELI5 tab…',
};
const busyLabel = (action: string): string => BUSY_LABEL[action] ?? 'Updating…';

export interface SelectionController {
  /** For tests: the menu's (closed) shadow root. */
  readonly root: ShadowRoot;
  current(): SelectionSnapshot | null;
  open(s: SelectionSnapshot, range?: Range): void;
  close(): void;
  /** `text` is the note, or for an Ask the question (the question field when omitted). */
  submit(action: MenuActionId, text?: string): Promise<void>;
  /** `depth` 'deep' or 'deeper' on an 'ask' item is Ask deep or Ask deeper (their own busy labels). */
  setBusy(busy: { sectionId: string; action: string; depth?: string }[]): void;
}

function lastRect(range: Range | null): { left: number; top: number; bottom: number; width: number } | undefined {
  if (!range || typeof range.getClientRects !== 'function') return undefined;
  const rects = range.getClientRects();
  return rects.length > 0 ? rects[rects.length - 1] : undefined;
}

/** Roving focus over `list` (08 §5.4): from `i`, step `dir` past disabled controls, with wrap. */
function rove(list: HTMLButtonElement[], i: number, dir: 1 | -1, focus = true): void {
  const n = list.length;
  let k = ((i % n) + n) % n;
  for (let tries = 0; tries < n && list[k]?.disabled; tries++) k = (((k + dir) % n) + n) % n;
  list.forEach((b, j) => (b.tabIndex = j === k ? 0 : -1));
  if (focus) list[k]?.focus();
}

/** A toolbar trigger, its in-flow popup (`role=menu`) and the popup's items. */
interface Group {
  trigger: HTMLButtonElement;
  pop: HTMLElement;
  items: HTMLButtonElement[];
}

export function initSelection(doc: Document, win: Window, bridge: DocBridge, tabs?: TabsApi): SelectionController {
  const host = doc.createElement('div');
  host.setAttribute('data-eli5-noact', '');
  doc.body.appendChild(host);
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = MENU_CSS;
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls: string,
    attrs: Record<string, string> = {},
  ): HTMLElementTagNameMap[K] => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  const button = (label: string, cls = ''): HTMLButtonElement => {
    const b = el('button', cls);
    b.type = 'button';
    b.textContent = label;
    return b;
  };
  const input = (cls: string, placeholder: string, max: number, label: string): HTMLInputElement => {
    const i = el('input', cls, { 'aria-label': label, autocomplete: 'off' });
    i.type = 'text';
    i.placeholder = placeholder;
    i.maxLength = max;
    return i;
  };

  // 08 §5.1, top to bottom: hint, Ask row, note, toolbar, the popups (in flow), cap.
  const menu = el('div', 'm', { role: 'group', 'aria-label': 'Selection actions' });
  menu.hidden = true;
  const hint = el('p', 'hint', { 'aria-live': 'polite' });
  const askRow = el('div', 'ask');
  const question = input('q', 'Ask a question about this…', MAX_QUESTION_CHARS, 'Your question about this passage');
  // 08 §5.1: three Ask buttons, each with a visible ⓘ marker (aria-hidden, so the accessible name is
  // exactly the label), a tooltip on hover and focus, and the same text as its accessible
  // description. No native `title`, so the browser never draws a second tooltip.
  const askButton = (id: AskActionId, cls: string, descId: string): HTMLButtonElement => {
    const b = el('button', cls, {
      'aria-describedby': descId,
      'aria-keyshortcuts': ASK_KEYSHORTCUTS[id],
      'data-ask': id,
    });
    b.type = 'button';
    const label = el('span', 'lbl');
    label.textContent = ASK_LABELS[id];
    const info = el('span', 'info', { 'aria-hidden': 'true' });
    info.textContent = 'i';
    b.append(label, info);
    return b;
  };
  const askBtn = askButton('ask', 'go', 'ask-desc');
  const askDeepBtn = askButton('ask-deep', 'go deep', 'deep-desc');
  const askDeeperBtn = askButton('ask-deeper', 'go deeper', 'deeper-desc');
  const askBtns = el('div', 'askb');
  askBtns.append(askBtn, askDeepBtn, askDeeperBtn);
  const descs = (
    [
      ['ask-desc', 'ask'],
      ['deep-desc', 'ask-deep'],
      ['deeper-desc', 'ask-deeper'],
    ] as const
  ).map(([id, a]) => {
    const d = el('span', 'sr', { id });
    d.textContent = ASK_TOOLTIPS[a];
    return d;
  });
  askRow.append(question, askBtns, ...descs);
  // An older app's bridge has no askQuestion: the row stays hidden there. One with askQuestion but
  // no askDeep (or no askDeeper) hides that button.
  askRow.hidden = typeof bridge.askQuestion !== 'function';
  const hasDeep = typeof bridge.askDeep === 'function';
  const hasDeeper = typeof bridge.askDeeper === 'function';
  askDeepBtn.hidden = !hasDeep;
  askDeeperBtn.hidden = !hasDeeper;
  const askButtons = [askBtn, askDeepBtn, askDeeperBtn];
  // One tooltip for the three buttons, inside the menu (08 §5.1).
  const tip = el('div', 'tip', { 'aria-hidden': 'true' });
  tip.hidden = true;
  const note = input('note', 'Add a note (optional)', MAX_NOTE_CHARS, 'Note for this action');
  const acts = el('div', 'acts', { role: 'toolbar', 'aria-label': 'Section actions' });
  const groups: Group[] = MENU_GROUPS.map((g) => {
    const trigger = button(g.label, 'trig');
    trigger.append(el('span', 'caret', { 'aria-hidden': 'true' }));
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', `pm-${g.id}`);
    const pop = el('div', 'pop', { id: `pm-${g.id}`, role: 'menu', 'aria-label': g.label });
    pop.hidden = true;
    const items = g.items.map(([id, label]) => {
      const b = button(label);
      b.setAttribute('role', 'menuitem');
      b.dataset.action = id;
      b.tabIndex = -1;
      pop.appendChild(b);
      return b;
    });
    acts.appendChild(trigger);
    return { trigger, pop, items };
  });
  const revise = button(EDIT_ACTION[1]);
  revise.dataset.action = EDIT_ACTION[0];
  acts.appendChild(revise);
  /** The toolbar's controls: one roving tab stop. */
  const tools = [...groups.map((g) => g.trigger), revise];
  const cap = el('p', 'cap');
  menu.append(hint, askRow, note, acts, ...groups.map((g) => g.pop), cap, tip);
  root.append(style, menu);

  let snap: SelectionSnapshot | null = null;
  let snapRange: Range | null = null;
  /** The side the menu was last placed on (true = below the anchor); reset on open. */
  let side: boolean | undefined;
  let openGroup: Group | null = null;
  const busy = new Set<string>();
  // 08 §5.2 step 5: boxes over the passage's own line boxes, painted with the highlight color.
  const layer = doc.createElement('div');
  layer.className = 'eli5-pending';
  layer.setAttribute('data-eli5-noact', '');
  layer.setAttribute('aria-hidden', 'true');
  layer.hidden = true;
  doc.body.appendChild(layer);

  const setHighlight = (range: Range | null): void => {
    drawPending(layer, range ? pendingRects(range, TEXT_EXCLUDED) : [], { x: win.scrollX, y: win.scrollY });
  };

  /** `keepSide`: the menu changed size, so it stays on its side and grows away from the selection. */
  const place = (keepSide = false): void => {
    const r = lastRect(snapRange);
    const bar = doc.querySelector('nav.tabbar');
    const p = placeMenu({
      anchor: r ?? { left: 0, top: 0, bottom: 0, width: 0 },
      menu: { width: menu.offsetWidth || 340, height: menu.offsetHeight || 150 },
      viewport: { width: win.innerWidth || doc.documentElement.clientWidth, height: win.innerHeight },
      scroll: { x: win.scrollX, y: win.scrollY },
      tabbarBottom: bar?.getBoundingClientRect().bottom ?? 0,
      ...(keepSide && side !== undefined ? { prefer: side ? ('below' as const) : ('above' as const) } : {}),
    });
    side = p.below;
    menu.style.left = `${String(p.left)}px`;
    menu.style.top = `${String(p.top)}px`;
    menu.style.width = p.width !== undefined ? `${String(p.width)}px` : '';
  };

  const closePop = (focusTrigger = false): void => {
    const g = openGroup;
    if (!g) return;
    openGroup = null;
    g.pop.hidden = true;
    g.trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger) g.trigger.focus();
    if (!menu.hidden) place(true);
  };

  /** Opens `g` (closing the other) and focuses its first or last enabled item. */
  const openPop = (g: Group, at: 'first' | 'last'): void => {
    if (g.trigger.disabled) return;
    if (openGroup !== g) {
      closePop();
      openGroup = g;
      g.pop.hidden = false;
      g.trigger.setAttribute('aria-expanded', 'true');
      place(true);
    }
    rove(tools, tools.indexOf(g.trigger), 1, false);
    if (at === 'first') rove(g.items, 0, 1);
    else rove(g.items, g.items.length - 1, -1);
  };

  /** Moves the toolbar's roving stop, closing an open popup on the way. */
  const toTool = (i: number, dir: 1 | -1): void => {
    closePop();
    rove(tools, i, dir);
  };

  /** 08 §5.1 enable rules: on open, on every input and on busy changes. */
  const refresh = (): void => {
    const s = snap;
    const isBusy = s ? busy.has(s.sectionId) : false;
    const tooLong = s?.selection.tooLong ?? false;
    question.readOnly = isBusy;
    note.readOnly = isBusy;
    askBtn.disabled = isBusy || nonSpace(question.value) < MIN_QUESTION_CHARS;
    askDeepBtn.disabled = askBtn.disabled;
    askDeeperBtn.disabled = askBtn.disabled;
    for (const g of groups) {
      for (const b of g.items) b.disabled = isBusy || (tooLong && b.dataset.action === 'eli5-selection');
      g.trigger.disabled = g.items.every((b) => b.disabled);
      if (g.trigger.disabled && openGroup === g) {
        // Focus inside the popup would fall to <body>; keep it in the menu on the note.
        const inside = g.pop.contains(root.activeElement);
        closePop();
        if (inside) note.focus();
      }
    }
    // "Edit with my note" needs a note: the note is its only instruction.
    revise.disabled = isBusy || !normalizeNote(note.value);
    const stop = tools.find((b) => b.tabIndex === 0);
    if (!stop || stop.disabled) rove(tools, 0, 1, false);
    const h = isBusy ? 'This section is being updated' : s?.clipped ? `Applies to: ${s.heading}` : '';
    const c = tooLong && !isBusy ? TOO_LONG_NOTE : '';
    if (h !== hint.textContent || c !== cap.textContent) {
      hint.textContent = h;
      cap.textContent = c;
      if (!menu.hidden) place(true);
    }
  };

  const ctl: SelectionController = {
    root,
    current: () => snap,
    open(s, range) {
      closePop();
      snap = s;
      snapRange = range ?? null;
      side = undefined;
      // The note belongs to one selection; a question is kept until it is sent (08 §5.5 step 4).
      note.value = '';
      tools.forEach((b, j) => (b.tabIndex = j === 0 ? 0 : -1));
      refresh();
      menu.hidden = false;
      setHighlight(snapRange);
      place();
    },
    close() {
      menu.hidden = true;
      hideTip(true);
      closePop();
      snap = null;
      snapRange = null;
      setHighlight(null);
    },
    async submit(action, text) {
      const s = snap;
      if (!s || busy.has(s.sectionId)) return;
      if (action === 'eli5-selection' && s.selection.tooLong) return;
      const isDeep = action === 'ask-deep';
      const isDeeper = action === 'ask-deeper';
      const isAsk = action === 'ask' || isDeep || isDeeper;
      const q = isAsk ? normalizeQuestion(text ?? question.value) : '';
      if (isAsk && nonSpace(q) < MIN_QUESTION_CHARS) return;
      // The note is never sent with Ask.
      const n = isAsk ? '' : normalizeNote(text ?? '');
      if (needsNote(action) && !n) return;
      ctl.close();
      const section = doc.getElementById(s.sectionId);
      markBusy(doc, section, action);
      const base = { tabKey: s.tabKey, sectionId: s.sectionId, selectionText: s.text, ...(n ? { note: n } : {}) };
      let res: { ok: boolean; error?: { message?: string } };
      try {
        if (isDeeper) {
          res = bridge.askDeeper
            ? await bridge.askDeeper({ ...base, question: q })
            : { ok: false, error: { message: 'Update the app to ask deeper' } };
        } else if (isDeep) {
          res = bridge.askDeep
            ? await bridge.askDeep({ ...base, question: q })
            : { ok: false, error: { message: 'Update the app to ask in depth' } };
        } else if (isAsk) {
          res = bridge.askQuestion
            ? await bridge.askQuestion({ ...base, question: q })
            : { ok: false, error: { message: 'Update the app to ask questions' } };
        } else if (action === 'eli5-selection') {
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
      } else if (isAsk && normalizeQuestion(question.value) === q) {
        // Cleared only after a successful dispatch, so a refused question can be sent again.
        question.value = '';
      }
    },
    setBusy(list) {
      busy.clear();
      for (const b of list) busy.add(b.sectionId);
      for (const el of Array.from(doc.querySelectorAll<HTMLElement>('section[data-eli5-busy]'))) {
        if (!busy.has(el.id)) markBusy(doc, el, null);
      }
      for (const b of list) {
        const action = b.action === 'ask' && (b.depth === 'deep' || b.depth === 'deeper') ? `ask-${b.depth}` : b.action;
        markBusy(doc, doc.getElementById(b.sectionId), action);
      }
      if (!menu.hidden) refresh();
    },
  };

  /** Space activates a button on keyup; handled on keydown instead, so it must not click twice. */
  const noSpaceClick = (b: HTMLButtonElement): void =>
    b.addEventListener('keyup', (e) => {
      if (e.key === ' ') e.preventDefault();
    });

  askBtn.addEventListener('click', () => void ctl.submit('ask'));
  askDeepBtn.addEventListener('click', () => void ctl.submit('ask-deep'));
  askDeeperBtn.addEventListener('click', () => void ctl.submit('ask-deeper'));
  question.addEventListener('input', refresh);
  question.addEventListener('keydown', (e) => {
    // Enter submits Ask when enabled, Cmd+Enter (Ctrl+Enter elsewhere) Ask deep, Cmd+Shift+Enter
    // Ask deeper; the keydown carries user activation (08 §5.4). An Enter that commits an IME
    // composition is not a submit.
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    if (askBtn.disabled) return;
    const mod = e.metaKey || e.ctrlKey;
    const action: AskActionId = mod && e.shiftKey ? 'ask-deeper' : mod ? 'ask-deep' : 'ask';
    // 08 §5.4: a shortcut does nothing when its button is not offered (an older app).
    if ((action === 'ask-deep' && !hasDeep) || (action === 'ask-deeper' && !hasDeeper)) return;
    void ctl.submit(action);
  });

  // ---- 08 §5.1: the Ask tooltips, on hover and on keyboard focus ----
  let hovered: HTMLButtonElement | null = null;
  let focused: HTMLButtonElement | null = null;
  /** Esc hid the tooltip; it stays hidden until the hover or focus target changes. */
  let tipDismissed = false;
  const placeTip = (b: HTMLButtonElement): void => {
    const vw = win.innerWidth || doc.documentElement.clientWidth;
    const vh = win.innerHeight || doc.documentElement.clientHeight;
    tip.style.maxWidth = `${String(Math.max(120, Math.min(TIP_MAX_WIDTH, vw - 2 * TIP_MARGIN)))}px`;
    tip.style.left = '0px';
    tip.style.top = '0px';
    const m = menu.getBoundingClientRect();
    const r = b.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const left = Math.max(TIP_MARGIN, Math.min(r.left + r.width / 2 - tw / 2, vw - TIP_MARGIN - tw));
    let top = r.bottom + TIP_GAP;
    if (top + th > vh - TIP_MARGIN) top = Math.max(TIP_MARGIN, r.top - TIP_GAP - th);
    // The tooltip is positioned in the menu's padding box.
    tip.style.left = `${String(Math.round(left - m.left - menu.clientLeft))}px`;
    tip.style.top = `${String(Math.round(top - m.top - menu.clientTop))}px`;
  };
  const showTip = (b: HTMLButtonElement): void => {
    const id = b.dataset.ask as AskActionId | undefined;
    if (!id || b.hidden || menu.hidden) return;
    tip.textContent = ASK_TOOLTIPS[id];
    tip.dataset.for = id;
    tip.hidden = false;
    placeTip(b);
  };
  function hideTip(reset = false): void {
    tip.hidden = true;
    delete tip.dataset.for;
    if (reset) {
      hovered = null;
      focused = null;
      tipDismissed = false;
    }
  }
  const updateTip = (): void => {
    const b = hovered ?? focused;
    if (b && !tipDismissed) showTip(b);
    else hideTip();
  };
  // Disabled buttons get no pointer events (CSS), so hover is tracked on the group by position.
  askBtns.addEventListener('mousemove', (e) => {
    const b =
      askButtons.find((x) => {
        if (x.hidden) return false;
        const r = x.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
      }) ?? null;
    if (b !== hovered) {
      hovered = b;
      tipDismissed = false;
      updateTip();
    }
  });
  askBtns.addEventListener('mouseleave', () => {
    hovered = null;
    updateTip();
  });
  for (const b of askButtons) {
    b.addEventListener('mouseenter', () => {
      if (hovered !== b) {
        hovered = b;
        tipDismissed = false;
        updateTip();
      }
    });
    b.addEventListener('focus', () => {
      focused = b;
      tipDismissed = false;
      updateTip();
    });
    b.addEventListener('blur', () => {
      if (focused === b) focused = null;
      updateTip();
    });
  }
  note.addEventListener('input', refresh);
  note.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      // Enter never submits, so a half-typed note cannot fire the wrong action: it opens Explain
      // on "Expand this", which keeps Cmd+. -> Enter -> Enter = Expand this (08 §5.4).
      e.preventDefault();
      const g = groups[0];
      if (g) openPop(g, 'first');
    } else if (e.key === 'Tab' && e.shiftKey && !askRow.hidden) {
      e.preventDefault();
      question.focus();
    }
  });

  for (const [i, b] of tools.entries()) {
    const g = groups.find((x) => x.trigger === b);
    b.addEventListener('keydown', (e) => {
      const k = e.key;
      if (k === 'ArrowRight') toTool(i + 1, 1);
      else if (k === 'ArrowLeft') toTool(i - 1, -1);
      else if (k === 'Home') toTool(0, 1);
      else if (k === 'End') toTool(tools.length - 1, -1);
      else if (g && (k === 'Enter' || k === ' ' || k === 'ArrowDown')) openPop(g, 'first');
      else if (g && k === 'ArrowUp') openPop(g, 'last');
      else return;
      e.preventDefault();
    });
    if (!g) continue;
    noSpaceClick(b);
    b.addEventListener('click', () => {
      if (openGroup === g) closePop();
      else openPop(g, 'first');
    });
  }
  revise.addEventListener('click', () => void ctl.submit('revise', note.value));

  for (const g of groups) {
    const t = tools.indexOf(g.trigger);
    for (const [j, b] of g.items.entries()) {
      noSpaceClick(b);
      b.addEventListener('click', () => void ctl.submit(b.dataset.action as MenuActionId, note.value));
      b.addEventListener('keydown', (e) => {
        const k = e.key;
        if (k === 'ArrowDown') rove(g.items, j + 1, 1);
        else if (k === 'ArrowUp') rove(g.items, j - 1, -1);
        else if (k === 'Home') rove(g.items, 0, 1);
        else if (k === 'End') rove(g.items, g.items.length - 1, -1);
        else if (k === 'ArrowRight') toTool(t + 1, 1);
        else if (k === 'ArrowLeft') toTool(t - 1, -1);
        else if (k === 'Tab') closePop(true);
        else if (k === 'Enter' || k === ' ') void ctl.submit(b.dataset.action as MenuActionId, note.value);
        else return;
        e.preventDefault();
      });
    }
  }
  /**
   * The range Esc restored (08 §5.4). Restoring fires selectionchange; the menu stays closed while
   * the live selection is still exactly this range.
   */
  let dismissed: Range | null = null;
  const sameRange = (a: Range, b: Range): boolean =>
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset;
  const isDismissed = (sel: Selection): boolean => {
    const d = dismissed;
    if (!d || sel.rangeCount === 0) return false;
    const same = sameRange(sel.getRangeAt(0), d);
    if (!same) dismissed = null;
    return same;
  };
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // 08 §5.4: Esc hides an open tooltip first.
    if (!tip.hidden) {
      e.preventDefault();
      tipDismissed = true;
      hideTip();
      return;
    }
    // Esc layering: an open popup closes first (focus back on its trigger), then the menu.
    if (openGroup) {
      e.preventDefault();
      closePop(true);
      return;
    }
    const range = snapRange;
    ctl.close();
    if (range) {
      dismissed = range.cloneRange();
      const sel = doc.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  });

  /**
   * The primary mouse button is down: a drag selection is still growing, so the menu waits for the
   * release (08 §5.2, Mouse drags). Keyboard and touch selections never set it.
   */
  let pressed = false;
  /** Focus is inside the menu: the document's active element is then the shadow host. */
  const focusIn = (): boolean => doc.activeElement === host || host.matches(':focus-within');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      if (pressed) return;
      const sel = doc.getSelection();
      const s = snapshotSelection(sel);
      if (s && sel) {
        if (isDismissed(sel)) return;
        const hit = enclosing(sel.getRangeAt(0));
        // The same passage again (a late selectionchange or mouseup): keep the open menu and its popup.
        if (!menu.hidden && hit && snapRange && sameRange(hit.range, snapRange)) return;
        ctl.open(s, hit ? hit.range.cloneRange() : undefined);
      } else if (!focusIn()) ctl.close();
    }, DEBOUNCE_MS);
  };
  /** The release was lost (outside the window, a drag and drop, a cancelled pointer): check now. */
  const release = (): void => {
    if (!pressed) return;
    pressed = false;
    check();
  };
  // Window capture phase: the flag is cleared before the document's mouseup handler checks.
  win.addEventListener(
    'mousedown',
    (e) => {
      if (e.button === 0) pressed = true;
    },
    true,
  );
  win.addEventListener(
    'mouseup',
    (e) => {
      if (e.button === 0) pressed = false;
    },
    true,
  );
  win.addEventListener(
    'mousemove',
    (e) => {
      if ((e.buttons & 1) === 0) release();
    },
    true,
  );
  win.addEventListener('blur', release);
  win.addEventListener('pointercancel', release, true);
  win.addEventListener('dragend', release, true);
  // macOS Ctrl+click reports button 0 and its context menu swallows the mouseup.
  win.addEventListener('contextmenu', release, true);
  doc.addEventListener('mouseup', (e) => {
    if (e.target !== host) check();
  });
  doc.addEventListener('keyup', (e) => {
    // A keyboard selection means no drag is in progress, whatever a lost mouseup left behind.
    if (e.shiftKey || e.key === 'Home' || e.key === 'End') {
      pressed = false;
      check();
    }
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
  // Reposition on scroll and resize; close once the anchor leaves the viewport (08 §5.4). With focus
  // in the menu, moving focus there can itself scroll the page, so the menu stays open as long as it
  // is still on screen; scrolling the menu itself out of view closes it.
  const follow = (): void => {
    if (menu.hidden) return;
    const r = lastRect(snapRange);
    const anchorOff = !!r && (r.bottom < 0 || r.top > win.innerHeight);
    if (anchorOff && !focusIn()) {
      ctl.close();
      return;
    }
    place();
    if (anchorOff) {
      const m = menu.getBoundingClientRect();
      if (m.bottom < 0 || m.top > win.innerHeight) {
        ctl.close();
        return;
      }
    }
    if (!tip.hidden) updateTip();
  };
  win.addEventListener('scroll', follow, { passive: true });
  win.addEventListener('resize', () => {
    follow();
    if (!menu.hidden) setHighlight(snapRange); // line boxes move when the text reflows
  });
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
