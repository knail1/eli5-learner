/**
 * 07 §13 print and 07 §16 "readable with JavaScript disabled". jsdom has no print media or layout,
 * so print is checked on the shipped stylesheet's `@media print` rules and no-JS on the golden DOM
 * before the runtime boots. A browser print preview stays with the Playwright smoke (13 §6).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readGolden } from '../../fixtures/documents/runtime';
import { loadGolden, loadRuntime } from './dom';

const CSS = readFileSync(join(process.cwd(), 'src/doc-runtime/index.css'), 'utf8');

/** Body of the first `@media print { … }` block (balanced braces). */
function printBlock(css: string): string {
  const start = css.indexOf('@media print');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', start) + 1, i);
  }
  throw new Error('unbalanced @media print');
}

/** Custom properties declared in the first top-level `:root { … }` rule. */
function rootTokens(css: string): string[] {
  const body = /(^|\n):root \{([^}]*)\}/.exec(css)?.[2] ?? '';
  return [...body.matchAll(/(--[\w-]+):/g)].map((m) => m[1] ?? '');
}

const NON_COLOR = new Set(['--font-serif', '--font-sans', '--eli5-tabbar-h']);

describe('print stylesheet (07 §13)', () => {
  const print = printBlock(CSS);

  it('forces every color token to the light palette with color-scheme light', () => {
    const rule = /:root:root:root:root:root \{([^}]*)\}/.exec(print)?.[1] ?? '';
    expect(rule).toContain('color-scheme: light');
    const colors = rootTokens(CSS).filter((t) => !NON_COLOR.has(t));
    expect(colors.length).toBeGreaterThan(20);
    for (const t of colors) expect(rule).toContain(`${t}:`);
  });

  it('outranks the document theme override block', () => {
    const themed = readGolden('themed');
    const themeSel = /<style id="eli5-theme">([^{]*)\{/.exec(themed)?.[1] ?? '';
    expect(themeSel).toBe(':root:root:root');
    // (0,5,0) inside @media print beats the theme blocks' (0,3,0) light and (0,4,0) dark rules.
    expect(print).toContain(':root:root:root:root:root {');
    const dark = /<style id="eli5-theme">[^<]*\[data-theme="dark"\]\{/.exec(themed)?.[0] ?? '';
    expect(dark).toContain(':root:root:root[data-theme="dark"]{');
  });

  it('hides the tab bar and controls, shows every stepper step, keeps callout backgrounds', () => {
    expect(print).toMatch(/\.tabbar,[^{]*\{\s*display: none !important;/);
    expect(print).toMatch(/\.stepper--js \.step:not\(\.is-current\) \{\s*display: block;/);
    expect(print).toMatch(/\.callout,[^{]*\{\s*print-color-adjust: exact;/);
  });

  it('prints answer boxes with the question shown and the chip hidden (07 §7.1)', () => {
    expect(print).toMatch(/\.qa-chip \{\s*display: none;/);
    expect(print).toMatch(/details\.qa-q::details-content \{\s*content-visibility: visible;/);
    expect(print).toMatch(/\.qa-q-text::before \{\s*content: 'You asked: ';/);
    expect(print).toMatch(/\.qa,[^{]*\{\s*print-color-adjust: exact;/);
    expect(print).not.toMatch(/\.qa[\s,][^{]*\{\s*display: none/);
  });

  it('avoids breaks inside short tables only (<= 30 rows)', () => {
    expect(print).toContain('.table-wrap--short');
    expect(print).not.toMatch(/(^|[\s,])table\s*[,{]/);
  });
});

describe('without JavaScript (07 §16)', () => {
  it('stacks every tab with its title; steppers and notes stay in the DOM', () => {
    const { doc } = loadGolden('with-tab'); // not booted: the runtime never ran
    expect(doc.documentElement.classList.contains('js')).toBe(false);
    const panels = Array.from(doc.querySelectorAll<HTMLElement>('.tabpanel'));
    expect(panels.length).toBe(3);
    for (const p of panels) {
      expect(p.hidden).toBe(false);
      expect(p.querySelector('.panel-title')?.textContent?.trim()).not.toBe('');
    }
    for (const s of Array.from(doc.querySelectorAll('.stepper'))) {
      expect(s.classList.contains('stepper--js')).toBe(false);
      expect(s.querySelectorAll('.step').length).toBeGreaterThan(1);
    }
    // Panel titles are hidden only once the runtime adds `js`; the tab bar only without it.
    expect(CSS).toMatch(/html\.js \.panel-title \{\s*display: none;/);
    expect(CSS).toMatch(/html:not\(\.js\) \.tabbar \{\s*display: none;/);
  });
});

describe('answer boxes (07 §7.1)', () => {
  it('are readable before the runtime boots: question and answer in the DOM, no script', () => {
    const { doc } = loadGolden('asked');
    const boxes = Array.from(doc.querySelectorAll<HTMLElement>('aside.qa'));
    expect(boxes).toHaveLength(2);
    for (const b of boxes) {
      expect(b.querySelector('.qa-a p')?.textContent?.trim()).not.toBe('');
      expect(b.querySelector('details.qa-q .qa-q-text')?.textContent?.trim()).not.toBe('');
      expect(b.querySelector('script')).toBeNull();
      expect(b.closest('[data-eli5-noact]')).toBeNull();
    }
  });

  it('print opens every question and restores them afterwards', async () => {
    const rt = await loadRuntime();
    const { win, doc } = loadGolden('asked');
    rt.boot(win, doc);
    const qs = Array.from(doc.querySelectorAll<HTMLDetailsElement>('details.qa-q'));
    const first = qs[0];
    if (!first) throw new Error('fixture');
    first.open = true; // opened by the reader: stays open after printing
    win.dispatchEvent(new win.Event('beforeprint'));
    expect(qs.every((d) => d.open)).toBe(true);
    win.dispatchEvent(new win.Event('afterprint'));
    expect(qs.map((d) => d.open)).toEqual([true, ...qs.slice(1).map(() => false)]);
  });
});

describe('deep answer boxes (08 §6.9)', () => {
  it('are readable without JavaScript: badge, question and answer in the DOM, one per source mode', () => {
    const { doc } = loadGolden('deep-asked'); // not booted
    const deep = Array.from(doc.querySelectorAll<HTMLElement>('aside.qa.qa-deep'));
    expect(deep).toHaveLength(3);
    expect(deep.map((b) => b.querySelector('.qa-badge')?.textContent)).toEqual([
      'Deep answer · checked against the original sources',
      'Deep answer · checked against excerpts of the original sources',
      'Deep answer · the original source text is not available for this document, so this answer uses the tabs only',
    ]);
    for (const b of deep) {
      expect(b.getAttribute('aria-label')).toBe('Deep answer to a reader question');
      expect(b.querySelector('.qa-a p')?.textContent?.trim()).not.toBe('');
      expect(b.querySelector('details.qa-q .qa-q-text')?.textContent?.trim()).not.toBe('');
      expect(b.closest('[data-eli5-noact]')).toBeNull();
      // The badge is outside the answer, so selections and follow-up asks never carry it.
      expect(b.querySelector('.qa-a .qa-badge')).toBeNull();
    }
    // A deep answer stores links as plain text.
    expect(deep[0]?.querySelector('.qa-a a')).toBeNull();
    expect(deep[0]?.querySelector('.qa-a')?.textContent).toContain('See the channel table for the other channels.');
    // Quick boxes in the same document stay unmarked.
    const quick = Array.from(doc.querySelectorAll<HTMLElement>('aside.qa:not(.qa-deep):not(.qa-deeper)'));
    expect(quick).toHaveLength(2);
    for (const b of quick) expect(b.querySelector('.qa-badge')).toBeNull();
  });

  it('print shows the badge (an exception to the [data-eli5-noact] rule) and keeps the box together', () => {
    const print = printBlock(CSS);
    expect(print).toMatch(/\[data-eli5-noact\] \{\s*display: none !important;/);
    expect(print).toMatch(
      /\.qa-badge\[data-eli5-noact\],\s*\.qa-web\[data-eli5-noact\] \{\s*display: block !important;/,
    );
    // .qa-deep is also .qa: break-inside avoid and exact colors apply.
    expect(print).toMatch(/\.qa,[^{]*\{\s*break-inside: avoid;/);
  });

  it('the deep box style uses theme tokens only (light and dark follow the palette)', () => {
    const rule = (sel: string): string =>
      new RegExp(`\\n${sel.replace('.', '\\.')} \\{([^}]*)\\}`).exec(CSS)?.[1] ?? '';
    expect(rule('.qa-deep')).toContain('var(--accent)');
    const badge = rule('.qa-badge');
    expect(badge).toContain('color: var(--ink-2)');
    expect(badge).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});

describe('deeper answer boxes (08 §6.10)', () => {
  it('are readable without JavaScript: badge per reach, the page list as plain text, no links', () => {
    const { doc } = loadGolden('deep-asked'); // not booted
    const boxes = Array.from(doc.querySelectorAll<HTMLElement>('aside.qa.qa-deeper'));
    expect(boxes).toHaveLength(3);
    for (const b of boxes) {
      expect(b.classList.contains('qa-deep')).toBe(false);
      expect(b.getAttribute('aria-label')).toBe('Deeper answer to a reader question');
      expect(b.querySelector('.qa-badge')?.hasAttribute('data-eli5-noact')).toBe(true);
      expect(b.querySelector('.qa-badge')?.nextElementSibling?.classList.contains('qa-a')).toBe(true);
      expect(b.querySelector('a')).toBeNull();
    }
    expect(boxes.map((b) => b.querySelector('.qa-badge')?.textContent)).toEqual([
      'Deeper answer · found in the document and its original sources',
      'Deeper answer · includes information from the web (pages listed below)',
      "Deeper answer · includes the AI's general knowledge, not from the document or the web",
    ]);
    // Only the web box lists pages: after the answer, plain text, no query or fragment, escaped.
    expect(boxes[0]?.querySelector('ul.qa-web')).toBeNull();
    expect(boxes[2]?.querySelector('ul.qa-web')).toBeNull();
    const list = boxes[1]?.querySelector<HTMLElement>('ul.qa-web');
    expect(list?.hasAttribute('data-eli5-noact')).toBe(true);
    expect(list?.previousElementSibling?.classList.contains('qa-a')).toBe(true);
    expect(Array.from(list?.querySelectorAll('li') ?? []).map((li) => li.textContent)).toEqual([
      'What is a good ROAS? <A guide> & more — example.org/guides/roas',
      'Advertising basics — www.example.net/ads',
    ]);
    expect(list?.innerHTML).toContain('&lt;A guide&gt; &amp; more');
  });

  it('print shows the page list and the deeper box style uses the shared teal slot, not a hex', () => {
    const rule = (sel: string): string =>
      new RegExp(`\\n${sel.replace('.', '\\.')} \\{([^}]*)\\}`).exec(CSS)?.[1] ?? '';
    expect(rule('.qa-deeper')).toContain('var(--viz-5)');
    expect(rule('.qa-web')).toContain('color: var(--ink-2)');
    expect(rule('.qa-web')).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});

describe('animations (07 §7.1, §13)', () => {
  it('show their poster, title and caption without JavaScript; the frame is hidden', () => {
    const { doc } = loadGolden('showcase'); // not booted
    const figs = Array.from(doc.querySelectorAll<HTMLElement>('figure.animation'));
    expect(figs).toHaveLength(1);
    for (const f of figs) {
      expect(f.querySelector('h3')?.textContent?.trim()).not.toBe('');
      expect(f.querySelector('.anim-poster svg[role="img"]')?.getAttribute('aria-label')).not.toBe('');
      expect(f.querySelector('figcaption.anim-cap')?.textContent?.trim()).not.toBe('');
      expect(f.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts');
      // print hides [data-eli5-noact]: the figure itself must never carry it
      expect(f.closest('[data-eli5-noact]')).toBeNull();
    }
    expect(CSS).toMatch(/html:not\(\.js\) \.anim-stage iframe \{\s*display: none;/);
  });

  it('print shows the poster and never the live frame', () => {
    const print = printBlock(CSS);
    expect(print).toMatch(/\.anim-stage iframe \{\s*display: none;/);
    expect(print).toMatch(/\.anim-live \.anim-poster \{\s*visibility: visible;/);
    expect(print).not.toMatch(/\.anim-poster[^{]*\{[^}]*display: none/);
  });
});
