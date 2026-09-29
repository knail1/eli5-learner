// Color math for theme dark variants (07 §11.4): parsing token values, WCAG contrast, and the
// derivation of a dark palette from a theme's light tokens (keep hue, move lightness).
import type { TokenName } from './types';

export interface Rgb {
  r: number; // 0..1
  g: number;
  b: number;
}

/** Runtime light palette (doc-runtime index.css `:root`); a unit test keeps the two in sync. */
export const RUNTIME_LIGHT: Readonly<Record<ColorToken, string>> = {
  '--paper': '#fbfaf7',
  '--paper-2': '#f1eee7',
  '--ink': '#1b1b1b',
  '--ink-2': '#363636',
  '--muted': '#5a5a5a',
  '--rule': '#d8d3c9',
  '--link': '#17548c',
  '--accent': '#0f5fa8',
  '--accent-ink': '#ffffff',
  '--highlight': '#fff1a8',
  '--viz-1': '#1f6fb2',
  '--viz-2': '#d4652f',
  '--viz-3': '#2e8b57',
  '--viz-4': '#b8336a',
  '--viz-5': '#6a4fc2',
  '--viz-6': '#b8860b',
  '--viz-7': '#1f8a8a',
  '--viz-8': '#a23b3b',
  '--viz-muted': '#bdb8ad',
  '--viz-grid': '#e4e0d7',
  '--callout-note': '#edf3fa',
  '--callout-warning': '#fcf0e4',
  '--callout-key': '#ecf6ef',
  '--gl-bg': '#f7f2e3',
  '--gl-rule': '#c49a1c',
  '--pull-rule': '#1b1b1b',
};

/** Runtime dark palette (doc-runtime index.css `:root[data-theme='dark']`), kept in sync by a test. */
export const RUNTIME_DARK: Readonly<Record<ColorToken, string>> = {
  '--paper': '#16171a',
  '--paper-2': '#202227',
  '--ink': '#ece9e4',
  '--ink-2': '#d4d0c9',
  '--muted': '#a9a59e',
  '--rule': '#3a3d43',
  '--link': '#8cc4ff',
  '--accent': '#6fb1f5',
  '--accent-ink': '#0d1117',
  '--highlight': '#5a4b12',
  '--viz-1': '#5fa8e8',
  '--viz-2': '#f08a55',
  '--viz-3': '#5cc08a',
  '--viz-4': '#e06a9a',
  '--viz-5': '#a08cf0',
  '--viz-6': '#e0b34a',
  '--viz-7': '#4fc0c0',
  '--viz-8': '#e07a7a',
  '--viz-muted': '#5b5f66',
  '--viz-grid': '#2d3035',
  '--callout-note': '#1b2836',
  '--callout-warning': '#35281b',
  '--callout-key': '#1b3024',
  '--gl-bg': '#28251b',
  '--gl-rule': '#c9a227',
  '--pull-rule': '#ece9e4',
};

export type ColorToken = Exclude<TokenName, '--font-serif' | '--font-sans'>;
export const COLOR_TOKENS = Object.keys(RUNTIME_DARK) as ColorToken[];

export function isColorToken(t: TokenName): t is ColorToken {
  return t in RUNTIME_DARK;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

function num(s: string, pctScale = 1): number {
  const t = s.trim();
  return t.endsWith('%') ? (parseFloat(t) / 100) * pctScale : parseFloat(t);
}

function hueDeg(s: string): number {
  const t = s.trim().toLowerCase();
  const v = parseFloat(t);
  if (t.endsWith('turn')) return v * 360;
  if (t.endsWith('rad')) return (v * 180) / Math.PI;
  return v;
}

/** Arguments of `fn(a b c / d)` or `fn(a, b, c, d)`; alpha ignored. */
function args(inner: string): string[] {
  return inner
    .split('/')[0]!
    .split(/[\s,]+/)
    .filter(Boolean);
}

/** Parses #hex, rgb(), hsl() and oklch() token values; anything else (names, keywords) is null. */
export function parseColor(value: string): Rgb | null {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b] = [0, 1, 2].map((i) => parseInt(hex[i]! + hex[i]!, 16) / 255);
      return { r: r!, g: g!, b: b! };
    }
    if (hex.length === 6 || hex.length === 8) {
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      return { r: r!, g: g!, b: b! };
    }
    return null;
  }
  const fn = /^(rgba?|hsla?|oklch)\(([^()]*)\)$/.exec(v);
  if (!fn) return null;
  const a = args(fn[2] ?? '');
  if (a.length < 3) return null;
  let out: Rgb;
  if (fn[1]!.startsWith('rgb')) {
    out = { r: num(a[0]!, 255) / 255, g: num(a[1]!, 255) / 255, b: num(a[2]!, 255) / 255 };
  } else if (fn[1]!.startsWith('hsl')) {
    out = hslToRgb({
      h: hueDeg(a[0]!),
      s: num(a[1]!, 1) / (a[1]!.endsWith('%') ? 1 : 100),
      l: num(a[2]!, 1) / (a[2]!.endsWith('%') ? 1 : 100),
    });
  } else {
    out = oklchToRgb(num(a[0]!, 1), num(a[1]!, 0.4), hueDeg(a[2]!));
  }
  if (![out.r, out.g, out.b].every(Number.isFinite)) return null;
  return { r: clamp01(out.r), g: clamp01(out.g), b: clamp01(out.b) };
}

function oklchToRgb(l: number, c: number, h: number): Rgb {
  const hr = (h * Math.PI) / 180;
  const A = c * Math.cos(hr);
  const B = c * Math.sin(hr);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const enc = (x: number): number => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(Math.max(0, x), 1 / 2.4) - 0.055);
  return {
    r: enc(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    g: enc(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    b: enc(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  };
}

export function toHex(c: Rgb): string {
  const h = (x: number): string =>
    Math.round(clamp01(x) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export interface Hsl {
  h: number; // degrees
  s: number; // 0..1
  l: number; // 0..1
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: clamp01(s), l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return { r: clamp01(r1 + m), g: clamp01(g1 + m), b: clamp01(b1 + m) };
}

/** WCAG 2 relative luminance. */
export function luminance({ r, g, b }: Rgb): number {
  const lin = (x: number): number => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio (1..21). */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Same hue and chroma (max - min) as `c`, at HSL lightness `l` (chroma capped to what `l` allows). */
function withLightness(c: Rgb, l: number): Rgb {
  const { h } = rgbToHsl(c);
  const chroma = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  const room = 1 - Math.abs(2 * l - 1);
  const s = room > 0 ? Math.min(1, chroma / room) : 0;
  return hslToRgb({ h, s, l });
}

/**
 * Lightest-first search: the smallest lightness at or above `start` (same hue, same HSL saturation)
 * whose contrast with every background reaches `target`. Undefined when even white fails.
 */
export function liftToContrast(c: Rgb, start: number, bgs: readonly Rgb[], target: number): Rgb | undefined {
  const { h, s } = rgbToHsl(c);
  const steps = [start];
  for (let i = Math.floor(start * 100) + 1; i <= 100; i++) steps.push(i / 100);
  for (const l of steps) {
    const cand = hslToRgb({ h, s, l });
    const hex = parseColor(toHex(cand))!; // judge the color that is actually written out
    if (bgs.every((bg) => contrast(hex, bg) >= target)) return hex;
  }
  return undefined;
}

/** Surfaces take the runtime dark lightness; text and marks are lifted to reach these ratios. */
const SURFACES: readonly ColorToken[] = [
  '--paper',
  '--paper-2',
  '--rule',
  '--highlight',
  '--viz-muted',
  '--viz-grid',
  '--callout-note',
  '--callout-warning',
  '--callout-key',
  '--gl-bg',
  '--accent-ink',
];
/** Body text: start from the inverted lightness (dark ink becomes light ink). */
const TEXT_TARGET: Partial<Record<ColorToken, number>> = { '--ink': 7, '--ink-2': 4.5, '--muted': 4.5 };
/** Colored text (kicker, links) >= 4.5:1; large text and UI marks >= 3:1 (WCAG 1.4.3, 1.4.11). */
const FG_TARGET: Partial<Record<ColorToken, number>> = {
  '--link': 4.5,
  '--accent': 4.5,
  '--gl-rule': 3,
  '--pull-rule': 3,
  '--viz-1': 3,
  '--viz-2': 3,
  '--viz-3': 3,
  '--viz-4': 3,
  '--viz-5': 3,
  '--viz-6': 3,
  '--viz-7': 3,
  '--viz-8': 3,
};
/** Backgrounds --ink sits on (doc-runtime index.css) besides --paper. */
const INK_SURFACES: readonly ColorToken[] = [
  '--paper-2',
  '--callout-note',
  '--callout-warning',
  '--callout-key',
  '--gl-bg',
  '--highlight',
];

/**
 * Dark values for a theme (07 §11.4). For every color token the theme sets in light, the dark value
 * is the explicit one when given, else derived: surfaces keep the light color's hue and chroma at the
 * runtime dark lightness; text and marks keep their hue and move lightness until they reach
 * 4.5:1 (text, accent, link) or 3:1 (rules, chart marks) on the dark paper. Unparseable values fall
 * back to the runtime dark value. Tokens the theme does not set are left to the runtime palette.
 */
export function deriveDarkTokens(
  light: Readonly<Partial<Record<TokenName, string>>>,
  explicit: Readonly<Partial<Record<TokenName, string>>> = {},
): Partial<Record<ColorToken, string>> {
  const out: Partial<Record<ColorToken, string>> = {};
  const set = COLOR_TOKENS.filter((t) => light[t] !== undefined || explicit[t] !== undefined);
  const eff = (t: ColorToken): Rgb =>
    parseColor(out[t] ?? explicit[t] ?? RUNTIME_DARK[t]) ?? parseColor(RUNTIME_DARK[t])!;
  // 1. Surfaces first: text contrast is judged against them.
  for (const t of SURFACES) {
    if (!set.includes(t) || t === '--accent-ink') continue;
    if (explicit[t]) out[t] = explicit[t];
    else {
      const c = parseColor(light[t] ?? '');
      const target = rgbToHsl(parseColor(RUNTIME_DARK[t])!).l;
      out[t] = c ? toHex(withLightness(c, target)) : RUNTIME_DARK[t];
    }
  }
  const paper = eff('--paper');
  // 2. Text and marks.
  for (const t of set) {
    if (SURFACES.includes(t) || out[t]) continue;
    if (explicit[t]) {
      out[t] = explicit[t];
      continue;
    }
    const c = parseColor(light[t] ?? '');
    const text = TEXT_TARGET[t];
    const target = text ?? FG_TARGET[t] ?? 3;
    const bgs = t === '--ink' ? [paper] : t === '--ink-2' || t === '--muted' ? [paper, eff('--paper-2')] : [paper];
    let v = c ? liftToContrast(c, text !== undefined ? 1 - rgbToHsl(c).l : rgbToHsl(c).l, bgs, target) : undefined;
    if (v && t === '--ink') {
      // Body text also sits on callouts, notes and the highlight.
      const surf = INK_SURFACES.map(eff);
      if (!surf.every((bg) => contrast(v!, bg) >= 4.5)) v = liftToContrast(v, rgbToHsl(v).l, [paper, ...surf], 4.5);
    }
    out[t] = v ? toHex(v) : RUNTIME_DARK[t];
  }
  // 3. Text on the accent (buttons, badges): dark, same hue, >= 4.5:1 on the dark accent.
  if (set.includes('--accent-ink')) {
    if (explicit['--accent-ink']) out['--accent-ink'] = explicit['--accent-ink'];
    else {
      const c = parseColor(light['--accent-ink'] ?? '');
      const accent = eff('--accent');
      let v = c ? withLightness(c, rgbToHsl(parseColor(RUNTIME_DARK['--accent-ink'])!).l) : undefined;
      if (!v || contrast(v, accent) < 4.5) v = parseColor(RUNTIME_DARK['--accent-ink'])!;
      out['--accent-ink'] = toHex(v);
    }
  }
  return out;
}
