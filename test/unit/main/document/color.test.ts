import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COLOR_TOKENS,
  RUNTIME_DARK,
  RUNTIME_LIGHT,
  contrast,
  deriveDarkTokens,
  parseColor,
  rgbToHsl,
  toHex,
  type ColorToken,
} from '../../../../src/main/document/color';
import { parseThemeTokens } from '../../../../src/main/pipeline';

const REPO = path.resolve(import.meta.dirname, '../../../..');
const CSS = readFileSync(path.join(REPO, 'src/doc-runtime/index.css'), 'utf8');

const rgb = (v: string) => {
  const c = parseColor(v);
  if (!c) throw new Error(`not a color: ${v}`);
  return c;
};
const ratio = (a: string, b: string): number => contrast(rgb(a), rgb(b));
const hueDiff = (a: string, b: string): number => {
  const d = Math.abs(rgbToHsl(rgb(a)).h - rgbToHsl(rgb(b)).h) % 360;
  return Math.min(d, 360 - d);
};

function block(selector: string): Record<string, string> {
  const i = CSS.indexOf(`${selector} {`);
  const body = CSS.slice(CSS.indexOf('{', i) + 1, CSS.indexOf('}', i));
  return Object.fromEntries(
    body
      .split(';')
      .map((d) => d.split(':').map((s) => s.trim()))
      .filter(([k, v]) => k?.startsWith('--') && v),
  );
}

describe('color math (07 §11.4)', () => {
  it('parses hex, rgb, hsl and oklch token values; names are not colors', () => {
    expect(toHex(rgb('#abc'))).toBe('#aabbcc');
    expect(toHex(rgb('#8a1c7cff'))).toBe('#8a1c7c');
    expect(toHex(rgb('rgb(250, 250, 250)'))).toBe('#fafafa');
    expect(toHex(rgb('rgb(100% 0% 0% / 50%)'))).toBe('#ff0000');
    expect(toHex(rgb('hsl(120, 100%, 25%)'))).toBe('#008000');
    expect(toHex(rgb('oklch(1 0 0)'))).toBe('#ffffff');
    expect(toHex(rgb('oklch(0.628 0.2577 29.23)'))).toBe('#ff0000');
    expect(parseColor('red')).toBeNull();
    expect(parseColor('transparent')).toBeNull();
  });

  it('computes WCAG contrast', () => {
    expect(ratio('#000', '#fff')).toBeCloseTo(21, 5);
    expect(ratio('#777', '#fff')).toBeCloseTo(4.48, 2);
    expect(ratio('#fff', '#fff')).toBe(1);
  });

  it('mirrors the runtime light and dark palettes in index.css', () => {
    const light = block(':root');
    const dark = block(":root[data-theme='dark']");
    for (const t of COLOR_TOKENS) {
      expect(light[t], `light ${t}`).toBe(RUNTIME_LIGHT[t]);
      expect(dark[t], `dark ${t}`).toBe(RUNTIME_DARK[t]);
    }
  });
});

describe('deriveDarkTokens (07 §11.4)', () => {
  const darkPaper = RUNTIME_DARK['--paper'];

  it('lifts a dark accent to 4.5:1 on the dark paper and keeps its hue', () => {
    const d = deriveDarkTokens({ '--accent': '#8a1c7c', '--font-serif': 'Georgia' });
    expect(Object.keys(d)).toEqual(['--accent']); // fonts and unset tokens are left alone
    const accent = d['--accent'] ?? '';
    expect(ratio('#8a1c7c', darkPaper)).toBeLessThan(4.5);
    expect(ratio(accent, darkPaper)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(accent, darkPaper)).toBeLessThan(5.5); // the smallest lift, not white
    expect(hueDiff(accent, '#8a1c7c')).toBeLessThan(3);
  });

  it('keeps a color that already reaches its ratio', () => {
    expect(ratio('#e07a7a', darkPaper)).toBeGreaterThan(4.5);
    expect(deriveDarkTokens({ '--link': '#e07a7a' })['--link']).toBe('#e07a7a');
  });

  it('turns the beautiful-doc palette into a dark palette that meets WCAG on its own paper', () => {
    const css = readFileSync(path.join(REPO, 'resources/skills/beautiful-doc/theme.css'), 'utf8');
    const light = parseThemeTokens(css);
    const d = deriveDarkTokens(light) as Record<ColorToken, string>;
    expect(Object.keys(d).sort()).toEqual([...COLOR_TOKENS].sort());
    const paper = d['--paper'];
    // Surfaces are dark, near the runtime's lightness, and keep their light hue.
    expect(ratio(paper, '#000')).toBeLessThan(1.4);
    expect(hueDiff(paper, light['--paper'] ?? '')).toBeLessThan(10);
    for (const bg of [
      '--paper',
      '--paper-2',
      '--callout-note',
      '--callout-warning',
      '--callout-key',
      '--gl-bg',
      '--highlight',
    ] as const) {
      expect(ratio(d['--ink'], d[bg]), `--ink on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(d['--ink'], paper)).toBeGreaterThanOrEqual(7);
    for (const t of ['--ink-2', '--muted', '--link', '--accent'] as const) {
      expect(ratio(d[t], paper), t).toBeGreaterThanOrEqual(4.5);
    }
    for (const t of [
      '--gl-rule',
      '--pull-rule',
      '--viz-1',
      '--viz-2',
      '--viz-3',
      '--viz-4',
      '--viz-5',
      '--viz-6',
      '--viz-7',
      '--viz-8',
    ] as const) {
      expect(ratio(d[t], paper), t).toBeGreaterThanOrEqual(3);
    }
    expect(ratio(d['--accent-ink'], d['--accent'])).toBeGreaterThanOrEqual(4.5);
    expect(hueDiff(d['--accent'], light['--accent'] ?? '')).toBeLessThan(3);
  });

  it('uses explicit dark values, judging derived ones against the explicit paper', () => {
    const d = deriveDarkTokens({ '--paper': '#ffffff', '--accent': '#8a1c7c' }, { '--paper': '#000000' });
    expect(d['--paper']).toBe('#000000');
    expect(ratio(d['--accent'] ?? '', '#000000')).toBeGreaterThanOrEqual(4.5);
    expect(deriveDarkTokens({ '--accent': '#8a1c7c' }, { '--accent': '#ff00ff' })['--accent']).toBe('#ff00ff');
  });

  it('falls back to the runtime dark value for colors it cannot read', () => {
    expect(deriveDarkTokens({ '--link': 'rebeccapurple', '--paper': 'white' })).toEqual({
      '--paper': RUNTIME_DARK['--paper'],
      '--link': RUNTIME_DARK['--link'],
    });
  });
});
