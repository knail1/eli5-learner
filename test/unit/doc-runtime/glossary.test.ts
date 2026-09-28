import { beforeAll, describe, expect, it } from 'vitest';
import { loadGolden, loadRuntime, type Runtime } from './dom';

let rt: Runtime;
const boot: Runtime['boot'] = (win, doc) => rt.boot(win, doc);
beforeAll(async () => {
  rt = await loadRuntime();
});

const notes = (doc: Document): HTMLDetailsElement[] =>
  Array.from(doc.querySelectorAll<HTMLDetailsElement>('details.gl-note'));

describe('glossary layout (07 §9.2)', () => {
  it('opens every note as a margin sidebar at >= 1100 px', () => {
    const { win, doc } = loadGolden('full', { wide: true });
    const h = boot(win, doc);
    expect(h.glossary?.isWide()).toBe(true);
    expect(doc.documentElement.classList.contains('gl-wide')).toBe(true);
    expect(notes(doc).length).toBeGreaterThan(0);
    expect(notes(doc).every((n) => n.open)).toBe(true);
    for (const n of notes(doc)) expect(n.style.top).toMatch(/^\d+px$/);
  });

  it('collapses notes inline below the breakpoint and switches without reload', () => {
    const l = loadGolden('full', { wide: false });
    boot(l.win, l.doc);
    expect(l.doc.documentElement.classList.contains('gl-wide')).toBe(false);
    expect(notes(l.doc).every((n) => !n.open)).toBe(true);
    l.setWide(true);
    expect(notes(l.doc).every((n) => n.open)).toBe(true);
    l.setWide(false);
    expect(notes(l.doc).every((n) => !n.open && n.style.top === '')).toBe(true);
  });

  it('clicking a term toggles its note on narrow widths', () => {
    const { win, doc } = loadGolden('full');
    boot(win, doc);
    const dfn = doc.querySelector('dfn.gl-term');
    const note = doc.getElementById(dfn?.getAttribute('aria-describedby') ?? '') as HTMLDetailsElement;
    dfn?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    expect(note.open).toBe(true);
    dfn?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    expect(note.open).toBe(false);
  });

  it('keeps margin notes open when their summary is clicked (wide)', () => {
    const { win, doc } = loadGolden('full', { wide: true });
    boot(win, doc);
    const n = notes(doc)[0];
    const ev = new win.MouseEvent('click', { bubbles: true, cancelable: true });
    n?.querySelector('summary')?.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('highlights the term and its note together', () => {
    const { win, doc } = loadGolden('full');
    boot(win, doc);
    const dfn = doc.querySelector('dfn.gl-term');
    dfn?.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }));
    const note = doc.getElementById(dfn?.getAttribute('aria-describedby') ?? '');
    expect(dfn?.classList.contains('gl-hot')).toBe(true);
    expect(note?.classList.contains('gl-hot')).toBe(true);
    dfn?.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
    expect(note?.classList.contains('gl-hot')).toBe(false);
  });

  it('never has notes in ELI5 tabs and opens notes for print', () => {
    const { win, doc } = loadGolden('with-tab');
    boot(win, doc);
    expect(doc.querySelectorAll('.tabpanel:not([data-tab-key="indepth"]) details.gl-note')).toHaveLength(0);
    win.dispatchEvent(new win.Event('beforeprint'));
    expect(notes(doc).every((n) => n.open)).toBe(true);
    win.dispatchEvent(new win.Event('afterprint'));
    expect(notes(doc).every((n) => !n.open)).toBe(true);
  });
});
