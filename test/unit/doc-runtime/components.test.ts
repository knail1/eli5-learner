import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadGolden, loadRuntime, type Runtime } from './dom';

let rt: Runtime;
const boot: Runtime['boot'] = (win, doc) => rt.boot(win, doc);
beforeAll(async () => {
  rt = await loadRuntime();
});

describe('theme toggle (07 §11.2)', () => {
  it('cycles auto -> light -> dark -> auto and remembers the choice', () => {
    const { win, doc } = loadGolden('full');
    boot(win, doc);
    const btn = doc.querySelector<HTMLButtonElement>('.theme-toggle');
    expect(btn?.hidden).toBe(false);
    expect(doc.documentElement.getAttribute('data-theme')).toBe('auto');
    btn?.click();
    expect(doc.documentElement.getAttribute('data-theme')).toBe('light');
    btn?.click();
    expect(doc.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(win.localStorage.getItem(rt.THEME_KEY)).toBe('dark');
    btn?.click();
    expect(doc.documentElement.getAttribute('data-theme')).toBe('auto');
  });

  it('applies a stored preference on boot', () => {
    const { win, doc } = loadGolden('full');
    win.localStorage.setItem(rt.THEME_KEY, 'dark');
    boot(win, doc);
    expect(doc.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('merge highlights toggle (07 §6.4)', () => {
  const KEY = 'eli5.enh.11111111-1111-4111-8111-111111111111';

  it('shows highlights by default, hides them on click and remembers it per document', () => {
    const { win, doc } = loadGolden('merged');
    const btn = doc.querySelector<HTMLButtonElement>('.enh-toggle');
    expect(btn?.hidden).toBe(true); // no JS: highlights visible, no toggle
    expect(doc.querySelectorAll('ins.enh[data-merge="m1"]').length).toBeGreaterThan(0);
    boot(win, doc);
    expect(btn?.hidden).toBe(false);
    expect(doc.documentElement.hasAttribute('data-hide-enh')).toBe(false);
    btn?.click();
    expect(doc.documentElement.hasAttribute('data-hide-enh')).toBe(true);
    expect(btn?.textContent).toBe('Show highlights');
    expect(btn?.getAttribute('aria-pressed')).toBe('true');
    expect(win.localStorage.getItem(KEY)).toBe('hidden');
    btn?.click();
    expect(doc.documentElement.hasAttribute('data-hide-enh')).toBe(false);
    expect(win.localStorage.getItem(KEY)).toBeNull();
  });

  it('applies a stored choice on boot and survives blocked storage', () => {
    const a = loadGolden('merged');
    a.win.localStorage.setItem(KEY, 'hidden');
    boot(a.win, a.doc);
    expect(a.doc.documentElement.hasAttribute('data-hide-enh')).toBe(true);
    const b = loadGolden('merged');
    Object.defineProperty(b.win, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    boot(b.win, b.doc);
    const btn = b.doc.querySelector<HTMLButtonElement>('.enh-toggle');
    btn?.click();
    expect(b.doc.documentElement.hasAttribute('data-hide-enh')).toBe(true);
  });

  it('is absent from documents without merges', () => {
    const { win, doc } = loadGolden('full');
    boot(win, doc);
    expect(doc.querySelector('.enh-legend')).toBeNull();
    expect(doc.documentElement.hasAttribute('data-hide-enh')).toBe(false);
  });
});

describe('stepper (07 §7.1)', () => {
  it('numbers each step from its own data-step, not a CSS counter', () => {
    // Hidden steps are display:none and skip counter-increment, so a counter shows "1" on every
    // step once the stepper is paged. The badge must come from data-step.
    const css = readFileSync(join(process.cwd(), 'src/doc-runtime/index.css'), 'utf8');
    const before = /\.step::before\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(before).toMatch(/content:\s*attr\(data-step\)/);
    const { doc } = loadGolden('full');
    const steps = Array.from(doc.querySelectorAll('.stepper .step'));
    expect(steps.map((s) => s.getAttribute('data-step'))).toEqual(steps.map((_, i) => String(i + 1)));
  });

  it('shows one step with prev/next; all steps remain in the markup', () => {
    const { win, doc } = loadGolden('full');
    boot(win, doc);
    const stepper = doc.querySelector('.stepper');
    expect(stepper?.classList.contains('stepper--js')).toBe(true);
    const steps = Array.from(stepper?.querySelectorAll('.step') ?? []);
    expect(steps).toHaveLength(3);
    const current = (): number => steps.findIndex((s) => s.classList.contains('is-current'));
    expect(current()).toBe(0);
    const [prev, next] = Array.from(stepper?.querySelectorAll<HTMLButtonElement>('.stepper-nav button') ?? []);
    expect(prev?.disabled).toBe(true);
    next?.click();
    next?.click();
    expect(current()).toBe(2);
    expect(next?.disabled).toBe(true);
    prev?.click();
    expect(current()).toBe(1);
  });
});

describe('charts and figures', () => {
  it('shows a tooltip for a focused chart mark', () => {
    const { win, doc } = loadGolden('full');
    boot(win, doc);
    const mark = doc.querySelector('figure.chart [data-value]');
    mark?.dispatchEvent(new win.FocusEvent('focusin', { bubbles: true }));
    const tip = doc.querySelector<HTMLElement>('.viz-tip');
    expect(tip?.hidden).toBe(false);
    expect(tip?.textContent).toBe(`${mark?.getAttribute('data-label')}: ${mark?.getAttribute('data-value')}`);
    mark?.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true }));
    expect(tip?.hidden).toBe(true);
  });

  it('highlights a figure note from its marker', () => {
    const { win, doc } = loadGolden('full');
    boot(win, doc);
    const marker = doc.querySelectorAll('a.fig-marker')[1];
    marker?.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    const active = Array.from(doc.querySelectorAll('.fig-notes li')).map((li) => li.classList.contains('is-active'));
    expect(active).toEqual([false, true]);
  });

  it('keeps working when one module fails (07 §14 step 4)', () => {
    const { win, doc } = loadGolden('full');
    Object.defineProperty(win, 'matchMedia', {
      configurable: true,
      value: () => {
        throw new Error('boom');
      },
    });
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    try {
      const h = boot(win, doc);
      expect(h.glossary).toBeUndefined();
      expect(h.tabs?.active()).toBe('indepth');
      expect(doc.querySelector('.stepper')?.classList.contains('stepper--js')).toBe(true);
    } finally {
      console.error = orig;
    }
    expect(errors).toHaveLength(1);
  });
});
