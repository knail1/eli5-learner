import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkillLibrary } from '../../../src/main/llm/skills';
import { TOKEN_NAMES, resolveDocTheme } from '../../../src/main/document';
import { parseThemeCss } from '../../../src/main/document/theme';

/** The bundled skills (resources/skills) the app ships with, 02 §11 and 07 §11.3. */
const ROOT = path.resolve(import.meta.dirname, '../../../resources/skills');

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
});
