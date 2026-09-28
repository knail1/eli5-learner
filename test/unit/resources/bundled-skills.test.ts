import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkillLibrary } from '../../../src/main/llm/skills';
import { TOKEN_NAMES, resolveDocTheme } from '../../../src/main/document';
import { parseThemeCss } from '../../../src/main/document/theme';

/** The bundled skills (resources/skills) the app ships with, 02 §11 and 07 §11.3. */
const ROOT = path.resolve(import.meta.dirname, '../../../resources/skills');

/** WCAG 2 relative luminance and contrast ratio for #rrggbb colors. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('bundled skills', () => {
  const lib = new SkillLibrary([ROOT]);

  it('serve both slots from resources/skills', () => {
    expect(lib.forSlot('beautiful-doc')?.name).toBe('beautiful-doc');
    expect(lib.forSlot('eli5')?.name).toBe('eli5');
  });

  it('carry the vendored upstream guidance', () => {
    expect(lib.forSlot('eli5')?.body).toMatch(/big pictures, few words/i);
    expect(lib.forSlot('beautiful-doc')?.body).toMatch(/html-effectiveness/);
  });

  it('do not load vendored templates as prompt examples (they sit in subfolders)', () => {
    expect(lib.forSlot('beautiful-doc')?.examples).toEqual([]);
    expect(lib.forSlot('eli5')?.examples).toEqual([]);
  });

  it('beautiful-doc theme.css sets every document token and all values are accepted', () => {
    const css = lib.themeCss(['beautiful-doc']);
    const tokens = parseThemeCss(css);
    expect(Object.keys(tokens).sort()).toEqual([...TOKEN_NAMES].sort());
    const { theme, source, warnings } = resolveDocTheme({ skill: tokens });
    expect(warnings).toEqual([]);
    expect(source).toBe('skill');
    expect(theme.tokens['--paper']).toBe('#faf9f5');
    expect(theme.tokens['--font-serif']).toContain('Georgia');
  });

  it('beautiful-doc theme keeps body text readable on every surface it colors (WCAG AA 4.5:1)', () => {
    const t = parseThemeCss(lib.themeCss(['beautiful-doc'])) as Record<string, string>;
    // Callout and glossary tokens are backgrounds for --ink text (doc-runtime index.css).
    for (const bg of ['--paper', '--paper-2', '--callout-note', '--callout-warning', '--callout-key', '--gl-bg']) {
      expect(contrast(t['--ink']!, t[bg]!), `--ink on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(t['--ink-2']!, t['--paper']!), '--ink-2 on --paper').toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--link']!, t['--paper']!), '--link on --paper').toBeGreaterThanOrEqual(4.5);
  });
});
