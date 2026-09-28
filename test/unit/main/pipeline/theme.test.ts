import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseThemeTokens } from '../../../../src/main/pipeline';

const REPO = path.resolve(import.meta.dirname, '../../../..');

describe('parseThemeTokens (07 §11.3 skill theme input)', () => {
  it('reads the bundled beautiful-doc palette', () => {
    const css = readFileSync(path.join(REPO, 'resources/skills/beautiful-doc/theme.css'), 'utf8');
    const t = parseThemeTokens(css);
    expect(t['--accent']).toBe('#d97757');
    expect(t['--font-serif']).toBe('"Iowan Old Style", ui-serif, Georgia, "Times New Roman", serif');
    expect(Object.keys(t)).toHaveLength(28);
  });

  it('keeps known tokens outside @media blocks, first declaration wins, comments ignored', () => {
    const css = `
      /* --ink: #000; */
      :root { --paper: #fff; --unknown-thing: red; --ink: #111 }
      @media (prefers-color-scheme: dark) { :root { --paper: #000; } .x { --ink: #eee } }
      .late { --paper: #abc; --accent: #0af; }
    `;
    expect(parseThemeTokens(css)).toEqual({ '--paper': '#fff', '--ink': '#111', '--accent': '#0af' });
    expect(parseThemeTokens('')).toEqual({});
  });
});
