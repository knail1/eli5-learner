// Allowlist sanitizer for model-supplied diagram SVG (07 §7.3). Parses with linkedom, then
// re-serializes only allowlisted nodes and attributes; colors become theme classes (07 §7.2 rule 11).
import { DOMParser } from 'linkedom';
import { attrs, esc } from './html';

const ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
  'desc',
  'defs',
  'marker',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'use',
]);
const TEXT_ELEMENTS = new Set(['text', 'tspan', 'title', 'desc']);

const ATTRIBUTES = new Set([
  'd',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'points',
  'transform',
  'viewBox',
  'preserveAspectRatio',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'font-size',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'marker-start',
  'marker-end',
  'marker-mid',
  'offset',
  'stop-color',
  'id',
  'role',
  'aria-label',
  // marker/gradient/clipPath geometry needed for the allowlisted elements to work
  'refX',
  'refY',
  'markerWidth',
  'markerHeight',
  'orient',
  'markerUnits',
  'gradientUnits',
  'gradientTransform',
  'clipPathUnits',
  'fx',
  'fy',
  'clip-path',
]);

/** Palette tokens a color may map to (07 §7.3); DOC_RUNTIME_CSS defines a class for each. */
export const COLOR_TOKENS = ['1', '2', '3', '4', '5', '6', '7', '8', 'ink', 'muted', 'paper', 'rule'] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

// Hues of the light-theme --viz-1..8 tokens (index.css), for nearest-hue mapping.
const VIZ_HUES: readonly [ColorToken, number][] = [
  ['1', 207],
  ['2', 20],
  ['3', 146],
  ['4', 334],
  ['5', 260],
  ['6', 42],
  ['7', 180],
  ['8', 0],
];

const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  lime: '#00ff00',
  blue: '#0000ff',
  navy: '#000080',
  teal: '#008080',
  aqua: '#00ffff',
  cyan: '#00ffff',
  yellow: '#ffff00',
  orange: '#ffa500',
  purple: '#800080',
  magenta: '#ff00ff',
  fuchsia: '#ff00ff',
  pink: '#ffc0cb',
  brown: '#a52a2a',
  maroon: '#800000',
  olive: '#808000',
  gold: '#ffd700',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9',
  steelblue: '#4682b4',
  tomato: '#ff6347',
  coral: '#ff7f50',
  indigo: '#4b0082',
  violet: '#ee82ee',
  crimson: '#dc143c',
  salmon: '#fa8072',
  skyblue: '#87ceeb',
  seagreen: '#2e8b57',
  forestgreen: '#228b22',
};

function hexToRgb(hex: string): [number, number, number] | undefined {
  const h = hex.slice(1);
  if (/^[0-9a-f]{3,4}$/i.test(h)) {
    return [0, 1, 2].map((i) => parseInt((h[i] ?? '0') + (h[i] ?? '0'), 16)) as [number, number, number];
  }
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) {
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  }
  return undefined;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function parseColor(v: string): [number, number, number] | undefined {
  const s = v.trim().toLowerCase();
  if (s.startsWith('#')) return hexToRgb(s);
  const named = NAMED[s];
  if (named) return hexToRgb(named);
  const nums = (inner: string): number[] =>
    inner
      .split(/[\s,/]+/)
      .filter((p) => p !== '')
      .map((p) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p)));
  let m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const parts = (m[1] ?? '').split(/[\s,/]+/).filter((p) => p !== '');
    const c = parts.slice(0, 3).map((p) => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p)));
    if (c.length === 3 && c.every(Number.isFinite)) return c as [number, number, number];
    return undefined;
  }
  m = /^hsla?\(([^)]*)\)$/.exec(s);
  if (m) {
    const [h, sat, l] = nums((m[1] ?? '').replace(/deg/g, ''));
    if (h === undefined || sat === undefined || l === undefined || ![h, sat, l].every(Number.isFinite))
      return undefined;
    return hslToRgb(((h % 360) + 360) % 360, Math.min(1, sat), Math.min(1, l));
  }
  return undefined;
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

/**
 * Maps a color value to a palette token (07 §7.3): `currentColor` -> ink, `var(--viz-N|--ink|
 * --muted|--paper|--rule)` -> that token, any other color -> nearest token by hue and lightness.
 * Returns 'none' for none/transparent and undefined for values that are not colors.
 */
export function colorToken(value: string): ColorToken | 'none' | undefined {
  const v = value.trim().toLowerCase();
  if (v === 'none' || v === 'transparent') return 'none';
  if (v === 'currentcolor') return 'ink';
  const tok = /^var\(\s*--(viz-([1-8])|ink|muted|paper|rule)\s*(,[^)]*)?\)$/.exec(v);
  if (tok) return (tok[2] ?? tok[1]) as ColorToken;
  const rgb = parseColor(v);
  if (!rgb) return undefined;
  const [h, s, l] = rgbToHsl(rgb);
  if (s < 0.15 || l > 0.94 || l < 0.08) {
    if (l >= 0.9) return 'paper';
    if (l >= 0.7) return 'rule';
    if (l >= 0.3) return 'muted';
    return 'ink';
  }
  let best: ColorToken = '1';
  let bestD = Infinity;
  for (const [token, hue] of VIZ_HUES) {
    const d = Math.min(Math.abs(h - hue), 360 - Math.abs(h - hue));
    if (d < bestD) {
      bestD = d;
      best = token;
    }
  }
  return best;
}

const URL_REF_RE = /^url\(\s*#([A-Za-z_][\w.-]*)\s*\)$/;

/** Theme classes this sanitizer itself emits; kept on re-sanitize so the pass is idempotent. */
const OWN_CLASS_RE = /^viz-(?:fill|stroke|stop)-(?:[1-8]|ink|muted|paper|rule)$/;

export interface SanitizeSvgOptions {
  /** Prefix for every id inside the SVG, `d` + 8 hex + `-` (07 §7.3). */
  idPrefix: string;
  /** Accessible name for the root (diagram.alt). */
  ariaLabel: string;
  /** Extra class on the root (e.g. 'diagram-svg'). */
  rootClass?: string;
}

interface El {
  nodeType: number;
  localName?: string;
  textContent?: string | null;
  childNodes: ArrayLike<El>;
  attributes?: ArrayLike<{ name: string; value: string }>;
}

const numAttr = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/.exec(v);
  return m ? Number(m[1]) : undefined;
};

/**
 * Sanitizes model SVG per 07 §7.3. Returns the serialized SVG, or null when nothing valid is left,
 * the root is not `<svg>`, or no viewBox can be derived.
 */
/**
 * Safe presentation declarations from a `style` attribute, as attributes (07 §7.3). Models often
 * write `style="text-anchor:middle;font-size:12px"`; dropping style wholesale left real diagrams'
 * labels left-aligned at the default size. Only these properties, with strict values, are kept;
 * real attributes win, and colors still go through the palette mapping in the attribute loop.
 */
const STYLE_PROPS: Readonly<Record<string, RegExp>> = {
  'text-anchor': /^(start|middle|end)$/,
  'dominant-baseline': /^(auto|middle|central|hanging|alphabetic|text-top|text-bottom|mathematical)$/,
  'font-weight': /^(normal|bold|lighter|bolder|[1-9]00)$/,
  'font-size': /^\d{1,3}(\.\d{1,2})?(px)?$/,
  'stroke-width': /^\d{1,2}(\.\d{1,2})?(px)?$/,
  opacity: /^(0|1|0?\.\d{1,3}|1\.0+)$/,
  'fill-opacity': /^(0|1|0?\.\d{1,3}|1\.0+)$/,
  'stroke-opacity': /^(0|1|0?\.\d{1,3}|1\.0+)$/,
  fill: /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]{3,20})$/,
  stroke: /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]{3,20})$/,
};

function withStyleAttributes(attrs: { name: string; value: string }[]): { name: string; value: string }[] {
  const style = attrs.find((a) => a.name === 'style');
  if (!style) return attrs;
  const present = new Set(attrs.map((a) => a.name));
  const extra: { name: string; value: string }[] = [];
  for (const decl of style.value.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const name = decl.slice(0, i).trim().toLowerCase();
    const value = decl
      .slice(i + 1)
      .trim()
      .toLowerCase()
      .replace(/\s*!important$/, '');
    const re = STYLE_PROPS[name];
    if (!re || present.has(name) || !re.test(value)) continue;
    present.add(name);
    extra.push({ name, value: /^(font-size|stroke-width)$/.test(name) ? value.replace(/px$/, '') : value });
  }
  return [...attrs, ...extra];
}

export function sanitizeSvg(input: string, opts: SanitizeSvgOptions): string | null {
  let doc: { documentElement: El | null };
  try {
    doc = new DOMParser().parseFromString(input.trim(), 'image/svg+xml') as unknown as { documentElement: El | null };
  } catch {
    return null;
  }
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg') return null;

  // Collect ids of kept elements first so references can be rewritten (or dropped when dangling).
  const ids = new Set<string>();
  const collect = (el: El): void => {
    if (el.nodeType !== 1 || !ELEMENTS.has(el.localName ?? '')) return;
    for (const a of Array.from(el.attributes ?? [])) if (a.name === 'id') ids.add(a.value);
    for (const c of Array.from(el.childNodes)) collect(c);
  };
  collect(root);

  // Ids already carrying the prefix keep it, so sanitizeSvg(sanitizeSvg(x)) === sanitizeSvg(x);
  // parseDocument re-runs it on model-stored SVG (07 §8).
  const pref = (id: string): string => (id.startsWith(opts.idPrefix) ? id : `${opts.idPrefix}${id}`);

  let shapes = 0;
  const emit = (el: El, isRoot: boolean): string => {
    const name = el.localName ?? '';
    const out: [string, string][] = [];
    const classes: string[] = [];
    let width: string | undefined;
    let height: string | undefined;
    for (const a of withStyleAttributes(Array.from(el.attributes ?? []))) {
      const attrName = a.name;
      const value = a.value;
      if (attrName === 'class') {
        for (const c of value.split(/\s+/)) if (OWN_CLASS_RE.test(c) && !classes.includes(c)) classes.push(c);
        continue;
      }
      if (/^on/i.test(attrName) || attrName === 'style') continue;
      if (attrName === 'href' || attrName === 'xlink:href') {
        const target = /^#([A-Za-z_][\w.-]*)$/.exec(value)?.[1];
        if (name === 'use' && target && ids.has(target)) out.push(['href', `#${pref(target)}`]);
        continue;
      }
      if (!ATTRIBUTES.has(attrName)) continue;
      if (/url\(/i.test(value)) {
        const ref = URL_REF_RE.exec(value.trim())?.[1];
        if (ref && ids.has(ref)) out.push([attrName, `url(#${pref(ref)})`]);
        continue;
      }
      if (/javascript:|expression\(|[<>]/i.test(value)) continue;
      if (attrName === 'fill' || attrName === 'stroke' || attrName === 'stop-color') {
        const tok = colorToken(value);
        if (tok === 'none') {
          if (attrName !== 'stop-color') out.push([attrName, 'none']);
        } else if (tok !== undefined) {
          const kind = attrName === 'stop-color' ? 'stop' : attrName;
          const c = `viz-${kind}-${tok}`;
          if (!classes.includes(c)) classes.push(c);
        }
        continue;
      }
      if (attrName === 'id') {
        out.push(['id', pref(value)]);
        continue;
      }
      if (isRoot && (attrName === 'role' || attrName === 'aria-label')) continue;
      if (isRoot && attrName === 'width') {
        width = value;
        continue;
      }
      if (isRoot && attrName === 'height') {
        height = value;
        continue;
      }
      out.push([attrName, value]);
    }
    if (isRoot) {
      if (!out.some(([n]) => n === 'viewBox')) {
        const w = numAttr(width);
        const h = numAttr(height);
        if (w === undefined || h === undefined || w <= 0 || h <= 0) return '';
        out.unshift(['viewBox', `0 0 ${w} ${h}`]);
      }
      out.unshift(['xmlns', 'http://www.w3.org/2000/svg']);
      out.push(['role', 'img'], ['aria-label', opts.ariaLabel]);
      // Unfilled marks and text default to ink instead of black, so they follow the theme.
      if (!classes.some((c) => c.startsWith('viz-fill-')) && !out.some(([n]) => n === 'fill')) {
        classes.unshift('viz-fill-ink');
      }
      if (opts.rootClass) classes.unshift(opts.rootClass);
    } else if (name !== 'defs' && name !== 'g' && name !== 'title' && name !== 'desc') {
      shapes++;
    }
    let inner = '';
    for (const c of Array.from(el.childNodes)) {
      if (c.nodeType === 3 || c.nodeType === 4) {
        if (TEXT_ELEMENTS.has(name)) inner += esc(c.textContent ?? '');
      } else if (c.nodeType === 1 && ELEMENTS.has(c.localName ?? '') && c.localName !== 'svg') {
        inner += emit(c, false);
      }
    }
    const list: [string, string][] = classes.length ? [...out, ['class', classes.join(' ')]] : out;
    return `<${name}${attrs(list)}>${inner}</${name}>`;
  };

  const svg = emit(root, true);
  if (svg === '' || shapes === 0) return null;
  return svg;
}
