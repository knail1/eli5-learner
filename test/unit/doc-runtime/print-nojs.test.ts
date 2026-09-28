/**
 * 07 §13 print and 07 §16 "readable with JavaScript disabled". jsdom has no print media or layout,
 * so print is checked on the shipped stylesheet's `@media print` rules and no-JS on the golden DOM
 * before the runtime boots. A browser print preview stays with the Playwright smoke (13 §6).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readGolden } from '../../fixtures/documents/runtime';
import { loadGolden } from './dom';

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
    const rule = /:root:root:root:root \{([^}]*)\}/.exec(print)?.[1] ?? '';
    expect(rule).toContain('color-scheme: light');
    const colors = rootTokens(CSS).filter((t) => !NON_COLOR.has(t));
    expect(colors.length).toBeGreaterThan(20);
    for (const t of colors) expect(rule).toContain(`${t}:`);
  });

  it('outranks the document theme override block', () => {
    const themed = readGolden('themed');
    const themeSel = /<style id="eli5-theme">([^{]*)\{/.exec(themed)?.[1] ?? '';
    expect(themeSel).toBe(':root:root:root');
    // (0,4,0) inside @media print beats the theme block's (0,3,0).
    expect(print).toContain(':root:root:root:root {');
  });

  it('hides the tab bar and controls, shows every stepper step, keeps callout backgrounds', () => {
    expect(print).toMatch(/\.tabbar,[^{]*\{\s*display: none !important;/);
    expect(print).toMatch(/\.stepper--js \.step:not\(\.is-current\) \{\s*display: block;/);
    expect(print).toMatch(/\.callout,[^{]*\{\s*print-color-adjust: exact;/);
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
