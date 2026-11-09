// The chart palette (07 §11.1): one shared, high-contrast set of chart colours used by every theme,
// held to hard rules for normal vision in both themes. Comprehension comes first; colour-vision
// simulation is not a requirement.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANIMATION_SHELL_CSS, ANIMATION_SHELL_JS } from '../../../../src/main/document/animation';
import {
  RUNTIME_DARK,
  RUNTIME_LIGHT,
  contrast,
  parseColor,
  type ColorToken,
  type Rgb,
} from '../../../../src/main/document/color';
import { sanitizeSvg } from '../../../../src/main/document/svg-sanitize';
import { CHART_SLOTS, resolveDocTheme, themeCss, themeDarkTokens } from '../../../../src/main/document/theme';
import { parseThemeDarkTokens, parseThemeTokens } from '../../../../src/main/pipeline';

const REPO = path.resolve(__dirname, '../../../..');
const VIZ = ['--viz-1', '--viz-2', '--viz-3', '--viz-4', '--viz-5', '--viz-6', '--viz-7', '--viz-8'] as const;

const lin = (x: number): number => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);

/** sRGB -> CIELAB (D65). */
function lab(hex: string): [number, number, number] {
  const c = parseColor(hex) as Rgb;
  const [r, g, b] = [lin(c.r), lin(c.g), lin(c.b)];
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000 colour difference (Sharma, Wu and Dalal 2005). */
function ciede2000(p: [number, number, number], q: [number, number, number]): number {
  const [L1, a1, b1] = p;
  const [L2, a2, b2] = q;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb7 = ((C1 + C2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number): number => {
    if (a === 0 && b === 0) return 0;
    const h = Math.atan2(b, a) / rad;
    return h < 0 ? h + 360 : h;
  };
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);
  const dL = L2 - L1;
  const dC = C2p - C1p;
  let dh = 0;
  if (C1p * C2p !== 0) {
    dh = h2p - h1p;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh * rad) / 2);
  const Lb = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hb = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hb = hb < 360 ? hb + 360 : hb - 360;
    hb /= 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hb - 30) * rad) +
    0.24 * Math.cos(2 * hb * rad) +
    0.32 * Math.cos((3 * hb + 6) * rad) -
    0.2 * Math.cos((4 * hb - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hb - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const SC = 1 + 0.045 * Cbp;
  const SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

const ratio = (a: string, b: string): number => contrast(parseColor(a) as Rgb, parseColor(b) as Rgb);
const dE = (a: string, b: string): number => ciede2000(lab(a), lab(b));

type Palette = Readonly<Record<ColorToken, string>>;

// Every theme file the app ships: the runtime default and the bundled beautiful-doc skill theme,
// each as a document shows it (theme tokens over the runtime palette) in light and dark.
const SKILL_CSS = readFileSync(path.join(REPO, 'resources/skills/beautiful-doc/theme.css'), 'utf8');
const skill = resolveDocTheme({ skill: parseThemeTokens(SKILL_CSS), skillDark: parseThemeDarkTokens(SKILL_CSS) });
const THEMES: [string, Palette, Palette][] = [
  ['runtime light', RUNTIME_LIGHT, RUNTIME_LIGHT],
  ['runtime dark', RUNTIME_DARK, RUNTIME_DARK],
  ['beautiful-doc light', { ...RUNTIME_LIGHT, ...skill.theme.tokens } as Palette, RUNTIME_LIGHT],
  ['beautiful-doc dark', { ...RUNTIME_DARK, ...themeDarkTokens(skill.theme) } as Palette, RUNTIME_DARK],
];

describe('chart palette (07 §11.1)', () => {
  it('matches reference CIEDE2000 pairs (Sharma et al. test data)', () => {
    expect(ciede2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
    expect(ciede2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 3);
  });

  it('CHART_SLOTS are exactly --viz-1..8', () => {
    expect([...CHART_SLOTS]).toEqual([...VIZ]);
  });

  it.each(THEMES)('%s: every theme uses the one shared chart palette', (_, palette, runtime) => {
    for (const t of VIZ) expect(palette[t], t).toBe(runtime[t]);
  });

  it.each(THEMES)('%s: every slot is >= 4.5:1 on the paper (marks, series-coloured labels)', (_, palette) => {
    for (const t of VIZ) expect(ratio(palette[t], palette['--paper']), t).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)('%s: the highlight accent is >= 3:1 on the paper', (_, palette) => {
    expect(ratio(palette['--accent'], palette['--paper'])).toBeGreaterThanOrEqual(3);
  });

  it.each(THEMES)('%s: de-emphasized marks (--viz-muted) are >= 3:1 on the paper and fixed', (_, palette, runtime) => {
    // Every non-highlighted bar, point or slice is still data the reader compares (S8: marks >= 3:1).
    expect(palette['--viz-muted']).toBe(runtime['--viz-muted']);
    expect(ratio(palette['--viz-muted'], palette['--paper'])).toBeGreaterThanOrEqual(3);
  });

  it.each(THEMES)('%s: paper-coloured text on any slot or accent fill reaches 4.5:1', (_, palette) => {
    for (const t of [...VIZ, '--accent'] as const) {
      expect(ratio(palette['--paper'], palette[t]), `paper on ${t}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(THEMES)('%s: outlined ink (ink on its paper outline, 07 §7.3) reaches 4.5:1', (_, palette) => {
    // The 3 px paper outline puts the ink on paper whatever fill sits behind it.
    expect(ratio(palette['--ink'], palette['--paper'])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)('%s: every pair of slots differs by more than 20 (CIEDE2000, normal vision)', (_, palette) => {
    // Charts show at most five slots, but diagrams and animations may use all eight together.
    for (let i = 0; i < VIZ.length; i++) {
      for (let j = i + 1; j < VIZ.length; j++) {
        expect(dE(palette[VIZ[i]!], palette[VIZ[j]!]), `${VIZ[i]} vs ${VIZ[j]}`).toBeGreaterThan(20);
      }
    }
  });

  it.each(THEMES)('%s: callout and analogy rules are >= 3:1 on their backgrounds', (_, palette) => {
    expect(ratio(palette['--accent'], palette['--callout-note'])).toBeGreaterThanOrEqual(3);
    expect(ratio(palette['--viz-2'], palette['--callout-warning'])).toBeGreaterThanOrEqual(3);
    expect(ratio(palette['--viz-6'], palette['--callout-key'])).toBeGreaterThanOrEqual(3);
    expect(ratio(palette['--viz-3'], palette['--paper-2'])).toBeGreaterThanOrEqual(3);
  });

  it.each(VIZ.map((_, i) => i + 1))('never same-hue text on fill: slot %i text on a slot %i shape becomes ink', (n) => {
    const svg =
      sanitizeSvg(
        `<svg viewBox="0 0 200 100"><rect x="0" y="0" width="200" height="100" class="viz-fill-${n}"/>` +
          `<text x="10" y="20" class="viz-fill-${n}">Label</text></svg>`,
        { idPrefix: 'd0a1b2c3d-', ariaLabel: 'Diagram', rootClass: 'diagram-svg', labelContrast: true },
      ) ?? '';
    expect(svg).toMatch(/<text [^>]*class="viz-fill-ink viz-stroke-paper"/);
  });
});

describe('themes never override the chart palette (07 §11.1, §11.3)', () => {
  it('the bundled beautiful-doc theme declares no chart slot', () => {
    for (const t of [...VIZ, '--viz-muted']) expect(SKILL_CSS).not.toContain(`${t}:`);
  });

  it('skill and overlay chart slots are dropped with a warning; other tokens stay', () => {
    const r = resolveDocTheme({
      skill: { '--viz-1': '#d97757', '--accent': '#a8512f', '--viz-muted': '#d1cfc5' },
      skillDark: { '--viz-2': '#ffcc00' },
      overlay: { id: 'org', version: '1', tokens: { '--viz-8': '#eeeeee' }, darkTokens: { '--viz-3': '#111111' } },
    });
    for (const t of VIZ) {
      expect(r.theme.tokens[t], t).toBeUndefined();
      expect(r.theme.darkTokens?.[t], t).toBeUndefined();
    }
    expect(r.theme.tokens['--accent']).toBe('#a8512f');
    expect(r.theme.tokens['--viz-muted']).toBeUndefined();
    expect(r.warnings).toEqual([
      'theme-token-chart-fixed:--viz-1',
      'theme-token-chart-fixed:--viz-muted',
      'theme-token-chart-fixed:--viz-2',
      'theme-token-chart-fixed:--viz-8',
      'theme-token-chart-fixed:--viz-3',
    ]);
  });

  it('themeCss never writes a chart slot, so a stored theme that set one heals on re-render', () => {
    const css = themeCss({
      id: 'old',
      version: '1',
      tokens: { '--viz-1': '#d97757', '--accent': '#a8512f' },
      darkTokens: { '--viz-1': '#ffaa88' },
    });
    expect(css).toContain('--accent:#a8512f');
    expect(css).not.toMatch(/--viz-[1-8]:/);
  });
});

describe('palette copies stay in sync (07 §11.1)', () => {
  const css = readFileSync(path.join(REPO, 'src/doc-runtime/index.css'), 'utf8');
  const decls = (body: string | undefined): Record<string, string> =>
    Object.fromEntries([...(body ?? '').matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]!.trim()]));

  it('the stylesheet uses the callout rules, and every runtime block carries the palette', () => {
    expect(css).toMatch(/\.callout--warning \{[^}]*border-left-color: var\(--viz-2\)/);
    expect(css).toMatch(/\.callout--keypoint \{[^}]*border-left-color: var\(--viz-6\)/);
    expect(css).toMatch(/\.analogy \{[^}]*border-left-color: var\(--viz-3\)/);
    const media = /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme='light'\]\) \{([^}]*)\}/.exec(
      css,
    )?.[1];
    const print = /:root:root:root:root:root \{([^}]*)\}/.exec(css)?.[1];
    expect(media).toBeDefined();
    expect(print).toBeDefined();
    for (const t of VIZ) {
      expect(decls(media)[t], `dark media ${t}`).toBe(RUNTIME_DARK[t]);
      expect(decls(print)[t], `print ${t}`).toBe(RUNTIME_LIGHT[t]);
    }
    expect(css).not.toContain('viz-stop-');
  });

  it('the animation shell offers the same series colours in both themes', () => {
    const light = VIZ.map((t) => RUNTIME_LIGHT[t]);
    const dark = VIZ.map((t) => RUNTIME_DARK[t]);
    const list = (l: string[]): string => `series: [${l.map((c) => `'${c}'`).join(', ')}]`;
    expect(ANIMATION_SHELL_JS).toContain(list(light));
    expect(ANIMATION_SHELL_JS).toContain(list(dark));
    const shellLight = VIZ.map((_, i) => new RegExp(`--s${i + 1}:([^;}]+)`).exec(ANIMATION_SHELL_CSS)?.[1]);
    expect(shellLight).toEqual(light);
    const darkBlock = ANIMATION_SHELL_CSS.slice(ANIMATION_SHELL_CSS.indexOf(':root[data-theme=dark]'));
    expect(VIZ.map((_, i) => new RegExp(`--s${i + 1}:([^;}]+)`).exec(darkBlock)?.[1])).toEqual(dark);
  });
});
