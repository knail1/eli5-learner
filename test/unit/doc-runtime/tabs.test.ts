import { beforeAll, describe, expect, it } from 'vitest';
import { fakeBridge, loadGolden, loadRuntime, type Runtime } from './dom';

let rt: Runtime;
const boot: Runtime['boot'] = (win, doc) => rt.boot(win, doc);
beforeAll(async () => {
  rt = await loadRuntime();
});

const panelsShown = (doc: Document): string[] =>
  Array.from(doc.querySelectorAll<HTMLElement>('.tabpanel'))
    .filter((p) => !p.hidden)
    .map((p) => p.dataset.tabKey ?? '');

describe('tabs (07 §12)', () => {
  it('boots with js class and In depth active; other panels hidden', () => {
    const { win, doc } = loadGolden('with-tab');
    const h = boot(win, doc);
    expect(doc.documentElement.classList.contains('js')).toBe(true);
    expect(h.tabs?.keys()).toEqual(['indepth', 'eli5', expect.stringMatching(/^sx[0-9a-f]{6}$/)]);
    expect(h.tabs?.active()).toBe('indepth');
    expect(panelsShown(doc)).toEqual(['indepth']);
    expect(doc.getElementById('tabbtn-indepth')?.getAttribute('aria-selected')).toBe('true');
    expect(h.inApp).toBe(false);
  });

  it('switches on click and records #tab= with replaceState', () => {
    const { win, doc } = loadGolden('with-tab');
    boot(win, doc);
    doc.getElementById('tabbtn-eli5')?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    expect(panelsShown(doc)).toEqual(['eli5']);
    expect(doc.getElementById('tabbtn-eli5')?.getAttribute('aria-selected')).toBe('true');
    expect(doc.getElementById('tabbtn-indepth')?.getAttribute('tabindex')).toBe('-1');
    expect(win.location.hash).toBe('#tab=eli5');
  });

  it('moves focus with arrows/Home/End and activates on Enter', () => {
    const { win, doc } = loadGolden('with-tab');
    const h = boot(win, doc);
    const first = doc.getElementById('tabbtn-indepth');
    first?.focus();
    first?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(doc.activeElement?.id).toBe('tabbtn-eli5');
    doc.activeElement?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(doc.activeElement?.id).toMatch(/^tabbtn-sx/);
    expect(h.tabs?.active()).toBe('indepth');
    doc.activeElement?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.tabs?.active()).toMatch(/^sx/);
    doc.activeElement?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(doc.activeElement?.id).toBe('tabbtn-indepth');
  });

  it('resolves #tab=<key> and #sec-… on open', () => {
    const a = loadGolden('with-tab', { url: 'https://example.test/doc/index.html#tab=eli5' });
    expect(boot(a.win, a.doc).tabs?.active()).toBe('eli5');
    const eli5Section = a.doc.querySelector('#tab-eli5 > section')?.id ?? '';
    const b = loadGolden('with-tab', { url: `https://example.test/doc/index.html#${eli5Section}` });
    expect(boot(b.win, b.doc).tabs?.active()).toBe('eli5');
    const c = loadGolden('with-tab', { url: 'https://example.test/doc/index.html#tab=nope' });
    expect(boot(c.win, c.doc).tabs?.active()).toBe('indepth');
  });

  it('activateTab({history:false}) leaves the hash alone and finds tabs by section', () => {
    const { win, doc } = loadGolden('with-tab');
    const h = boot(win, doc);
    const sx = h.tabs?.keys()[2] ?? '';
    expect(h.tabs?.activateTab(sx, { history: false })).toBe(true);
    expect(win.location.hash).toBe('');
    const sid = doc.querySelector(`#tab-${sx} > section`)?.id ?? '';
    expect(h.tabs?.tabOfSection(sid)).toBe(sx);
    expect(h.tabs?.activateTab('missing')).toBe(false);
  });

  it('follows "From:" links into the in-depth tab', () => {
    const { win, doc } = loadGolden('with-tab');
    const h = boot(win, doc);
    h.tabs?.activateTab(h.tabs.keys()[2] ?? '');
    doc.querySelector('.tab-from a')?.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(h.tabs?.active()).toBe('indepth');
  });

  it('works over file:// where storage and history may throw', () => {
    const { win, doc } = loadGolden('with-tab', { url: 'file:///Users/example/doc/index.html' });
    const h = boot(win, doc);
    expect(h.tabs?.active()).toBe('indepth');
    doc.querySelector<HTMLButtonElement>('.theme-toggle')?.click();
    expect(doc.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('malformed hash (07 §12 item 2)', () => {
  it('falls back to the default tab instead of throwing on a bad percent-escape', () => {
    const { win, doc } = loadGolden('with-tab', { url: 'https://example.test/doc/index.html#tab=%E0%A4' });
    const h = boot(win, doc);
    expect(h.tabs?.active()).toBe('indepth');
    expect(panelsShown(doc)).toEqual(['indepth']);
    win.location.hash = '#%';
    expect(() => win.dispatchEvent(new win.HashChangeEvent('hashchange'))).not.toThrow();
    expect(h.tabs?.active()).toBe('indepth');
  });
});

describe('viewer focus handoff (11 §12)', () => {
  it('in the app, focus arriving at the viewer lands on the active tab', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    const h = boot(win, doc);
    h.tabs?.activateTab('eli5');
    expect(doc.activeElement).toBe(doc.body);
    win.dispatchEvent(new win.FocusEvent('focus'));
    expect(doc.activeElement?.id).toBe('tabbtn-eli5');
  });

  it('keeps focus where it is when something in the document already has it', () => {
    const { win, doc } = loadGolden('with-tab', { bridge: fakeBridge() });
    boot(win, doc);
    const summary = doc.querySelector<HTMLElement>('#tab-indepth section h2');
    if (!summary) throw new Error('fixture');
    summary.tabIndex = -1;
    summary.focus();
    win.dispatchEvent(new win.FocusEvent('focus'));
    expect(doc.activeElement).toBe(summary);
  });

  it('in a plain browser, window focus never moves focus', () => {
    const { win, doc } = loadGolden('with-tab');
    boot(win, doc);
    win.dispatchEvent(new win.FocusEvent('focus'));
    expect(doc.activeElement).toBe(doc.body);
  });
});
