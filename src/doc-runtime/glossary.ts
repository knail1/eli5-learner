// Glossary margin notes (07 §9.2): always-open sidebars aligned with their anchor block at
// >= 1100 px, collapsed inline chips below; the switch follows matchMedia without reload.
import type { TabsApi } from './tabs';

export const GLOSSARY_QUERY = '(min-width: 1100px)';
const NOTE_GAP = 12;

export interface GlossaryApi {
  isWide(): boolean;
  layout(): void;
}

function notesOf(root: ParentNode): HTMLDetailsElement[] {
  return Array.from(root.querySelectorAll<HTMLDetailsElement>('details.gl-note'));
}

/** The block a note belongs to: the nearest preceding sibling that is not a note. */
function anchorBlock(note: HTMLElement): HTMLElement | null {
  let el = note.previousElementSibling as HTMLElement | null;
  while (el && el.matches('details.gl-note')) el = el.previousElementSibling as HTMLElement | null;
  return el;
}

export function initGlossary(doc: Document, win: Window, tabs?: TabsApi): GlossaryApi {
  const root = doc.documentElement;
  const mql = typeof win.matchMedia === 'function' ? win.matchMedia(GLOSSARY_QUERY) : undefined;
  let wide = mql?.matches ?? false;

  /** Wide: absolute tops so each note starts at its block and stacked notes never overlap. */
  const layout = (): void => {
    for (const panel of Array.from(doc.querySelectorAll<HTMLElement>('.tabpanel'))) {
      const notes = notesOf(panel);
      if (!wide) {
        for (const n of notes) n.style.top = '';
        continue;
      }
      if (panel.hidden) continue;
      const base = panel.getBoundingClientRect().top;
      let lastBottom = -Infinity;
      for (const n of notes) {
        const block = anchorBlock(n);
        const want = block ? block.getBoundingClientRect().top - base : 0;
        const top = Math.max(want, lastBottom + NOTE_GAP);
        n.style.top = `${Math.round(top)}px`;
        lastBottom = top + n.getBoundingClientRect().height;
      }
    }
  };

  const apply = (): void => {
    root.classList.toggle('gl-wide', wide);
    for (const n of notesOf(doc)) n.open = wide;
    layout();
  };

  const onChange = (e: { matches: boolean }): void => {
    wide = e.matches;
    apply();
  };
  if (mql) {
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange);
    else (mql as unknown as { addListener?: (cb: (e: { matches: boolean }) => void) => void }).addListener?.(onChange);
  }

  // Margin notes read as always-visible sidebars: their summary does not collapse them.
  doc.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    const summary = target?.closest?.('details.gl-note > summary');
    if (summary && wide) {
      e.preventDefault();
      return;
    }
    const dfn = target?.closest?.('dfn.gl-term');
    if (!dfn) return;
    const note = doc.getElementById(dfn.getAttribute('aria-describedby') ?? '') as HTMLDetailsElement | null;
    if (!note) return;
    if (!wide) note.open = !note.open;
    note.querySelector('summary')?.focus();
  });

  // Hovering or focusing a note highlights its term, and vice versa.
  const pairOf = (el: Element): Element[] => {
    if (el.matches('dfn.gl-term')) {
      const n = doc.getElementById(el.getAttribute('aria-describedby') ?? '');
      return n ? [el, n] : [el];
    }
    const t = doc.getElementById(el.getAttribute('data-note-for') ?? '');
    return t ? [el, t] : [el];
  };
  const hot = (on: boolean) => (e: Event) => {
    const el = (e.target as Element | null)?.closest?.('dfn.gl-term, details.gl-note');
    if (el) for (const x of pairOf(el)) x.classList.toggle('gl-hot', on);
  };
  doc.addEventListener('mouseover', hot(true));
  doc.addEventListener('mouseout', hot(false));
  doc.addEventListener('focusin', hot(true));
  doc.addEventListener('focusout', hot(false));

  win.addEventListener('resize', layout);
  doc.addEventListener('toggle', layout, true);
  tabs?.onChange(() => layout());
  (doc as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready?.then(layout, () => undefined);

  apply();
  return { isWide: () => wide, layout };
}
