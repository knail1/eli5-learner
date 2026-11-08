// The chart palette (07 §11.1): the first four --viz colours stay distinguishable under the
// three common colour-vision deficiencies, and every slot reaches 3:1 on the paper in both themes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RUNTIME_DARK,
  RUNTIME_LIGHT,
  contrast,
  parseColor,
  type ColorToken,
  type Rgb,
} from '../../../../src/main/document/color';

const REPO = path.resolve(__dirname, '../../../..');
const VIZ = ['--viz-1', '--viz-2', '--viz-3', '--viz-4', '--viz-5', '--viz-6', '--viz-7', '--viz-8'] as const;

// Machado, Oliveira and Fernandes (2009), severity 1.0, applied to linear RGB.
const CVD: Record<string, readonly (readonly number[])[]> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

const lin = (x: number): number => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
const clamp = (x: number): number => Math.min(1, Math.max(0, x));

function linear(hex: string): [number, number, number] {
  const c = parseColor(hex) as Rgb;
  return [lin(c.r), lin(c.g), lin(c.b)];
}

function simulate(rgb: [number, number, number], m: readonly (readonly number[])[]): [number, number, number] {
  const row = (i: number): number => clamp(m[i]![0]! * rgb[0] + m[i]![1]! * rgb[1] + m[i]![2]! * rgb[2]);
  return [row(0), row(1), row(2)];
}

/** Linear sRGB -> CIELAB (D65). */
function lab([r, g, b]: [number, number, number]): [number, number, number] {
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

const THEMES: [string, Readonly<Record<ColorToken, string>>][] = [
  ['light', RUNTIME_LIGHT],
  ['dark', RUNTIME_DARK],
];

describe('chart palette (07 §11.1)', () => {
  it('matches a reference CIEDE2000 pair (Sharma et al. test data)', () => {
    expect(ciede2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
    expect(ciede2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 3);
  });

  it.each(THEMES)('%s: the first four stay > 10 apart (CIEDE2000) under each CVD simulation', (_, palette) => {
    const four = VIZ.slice(0, 4).map((t) => linear(palette[t]));
    for (const [name, m] of Object.entries(CVD)) {
      for (let i = 0; i < four.length; i++) {
        for (let j = i + 1; j < four.length; j++) {
          const d = ciede2000(lab(simulate(four[i]!, m)), lab(simulate(four[j]!, m)));
          expect(d, `${name}: --viz-${i + 1} vs --viz-${j + 1}`).toBeGreaterThan(10);
        }
      }
    }
  });

  it.each(THEMES)('%s: every slot is >= 3:1 on the paper', (_, palette) => {
    for (const t of VIZ) expect(ratio(palette[t], palette['--paper']), t).toBeGreaterThanOrEqual(3);
  });

  it.each(THEMES)('%s: callout and analogy rules are >= 3:1 on their backgrounds', (_, palette) => {
    expect(ratio(palette['--accent'], palette['--callout-note'])).toBeGreaterThanOrEqual(3);
    expect(ratio(palette['--viz-2'], palette['--callout-warning'])).toBeGreaterThanOrEqual(3);
    expect(ratio(palette['--viz-6'], palette['--callout-key'])).toBeGreaterThanOrEqual(3);
    expect(ratio(palette['--viz-3'], palette['--paper-2'])).toBeGreaterThanOrEqual(3);
  });

  it('the stylesheet uses those rules, and both dark blocks carry the same palette', () => {
    const css = readFileSync(path.join(REPO, 'src/doc-runtime/index.css'), 'utf8');
    expect(css).toMatch(/\.callout--warning \{[^}]*border-left-color: var\(--viz-2\)/);
    expect(css).toMatch(/\.callout--keypoint \{[^}]*border-left-color: var\(--viz-6\)/);
    expect(css).toMatch(/\.analogy \{[^}]*border-left-color: var\(--viz-3\)/);
    const media = /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme='light'\]\) \{([^}]*)\}/.exec(
      css,
    )?.[1];
    expect(media).toBeDefined();
    for (const t of VIZ) expect(media).toContain(`${t}: ${RUNTIME_DARK[t]};`);
    expect(css).not.toContain('viz-stop-');
  });
});
