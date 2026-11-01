// Diagram label contrast (07 §7.3): a text label must never be the same colour as, or blend into,
// the shape behind it. Runs on the parsed SVG before sanitizeSvg serializes it, so the result goes
// through the same allow-list and stays idempotent: a label that is already correct is untouched.
import type { ColorToken } from './svg-sanitize';

/** sanitizeSvg's colour mapping, passed in so this module does not import its caller. */
export type ToToken = (value: string) => ColorToken | 'none' | undefined;

/** The parts of a linkedom element this pass reads and writes. */
interface Node {
  nodeType: number;
  localName?: string;
  childNodes: ArrayLike<Node>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

type Fill = ColorToken | 'none' | 'url' | undefined;

interface Ctx {
  fill: Fill;
  opacity: number;
  tx: number;
  ty: number;
  /** A non-translate transform on this element or an ancestor: geometry cannot be judged. */
  skewed: boolean;
}

interface Backdrop {
  contains(x: number, y: number): boolean;
  tok: ColorToken;
  skewed: boolean;
}

/** Shapes with fill or element opacity under this count as no shape. */
const MIN_OPACITY = 0.5;
const NOT_PAINTED = new Set(['defs', 'marker', 'clipPath', 'linearGradient', 'radialGradient', 'title', 'desc']);
const ACCENTS = new Set<string>(['1', '2', '3', '4', '5', '6', '7', '8']);
const OUTLINE: [string, string][] = [
  ['stroke-width', '3'],
  ['stroke-linejoin', 'round'],
  ['paint-order', 'stroke'],
];

const num = (v: string | null): number | undefined => {
  if (v === null) return undefined;
  const m = /^\s*(-?[0-9]*\.?[0-9]+)\s*(px)?\s*$/.exec(v);
  return m ? Number(m[1]) : undefined;
};

function styleProp(el: Node, prop: string): string | undefined {
  const style = el.getAttribute('style');
  if (!style) return undefined;
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i > 0 && decl.slice(0, i).trim().toLowerCase() === prop)
      return decl
        .slice(i + 1)
        .trim()
        .toLowerCase();
  }
  return undefined;
}

const classes = (el: Node): string[] => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

/** The element's own fill as a palette token, from a theme class, the fill attribute or style. */
function ownFill(el: Node, colorToken: ToToken): Fill {
  const cls = classes(el)
    .map((c) => /^viz-fill-([1-8]|ink|muted|paper|rule)$/.exec(c)?.[1])
    .find(Boolean);
  if (cls) return cls as ColorToken;
  const v = el.getAttribute('fill') ?? styleProp(el, 'fill');
  if (v === null || v === undefined) return undefined;
  if (/url\(/i.test(v)) return 'url';
  return colorToken(v);
}

function ownOpacity(el: Node, names: readonly string[]): number {
  let o = 1;
  for (const n of names) {
    const v = num(el.getAttribute(n) ?? styleProp(el, n) ?? null);
    if (v !== undefined) o *= Math.min(1, Math.max(0, v));
  }
  return o;
}

/** Translate offsets of a transform, or null when it holds anything but translations. */
function translation(t: string | null): { x: number; y: number } | null {
  if (!t || !t.trim()) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  const rest = t.replace(/translate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?\s*\)/g, (_m, a: string, b?: string) => {
    x += Number(a);
    y += b === undefined ? 0 : Number(b);
    return '';
  });
  return rest.trim() === '' && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function backdropOf(el: Node, ctx: Ctx, tok: ColorToken): Backdrop | null {
  const at = (n: string) => num(el.getAttribute(n));
  const { tx, ty, skewed } = ctx;
  switch (el.localName) {
    case 'rect': {
      const x = (at('x') ?? 0) + tx;
      const y = (at('y') ?? 0) + ty;
      const w = at('width');
      const h = at('height');
      if (w === undefined || h === undefined) return null;
      return { tok, skewed, contains: (px, py) => px >= x && px <= x + w && py >= y && py <= y + h };
    }
    case 'circle': {
      const cx = (at('cx') ?? 0) + tx;
      const cy = (at('cy') ?? 0) + ty;
      const r = at('r');
      if (r === undefined) return null;
      return { tok, skewed, contains: (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r };
    }
    case 'ellipse': {
      const cx = (at('cx') ?? 0) + tx;
      const cy = (at('cy') ?? 0) + ty;
      const rx = at('rx');
      const ry = at('ry');
      if (rx === undefined || ry === undefined || rx <= 0 || ry <= 0) return null;
      return { tok, skewed, contains: (px, py) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1 };
    }
    default:
      return null;
  }
}

const elements = (n: Node): Node[] => Array.from(n.childNodes).filter((c) => c.nodeType === 1);

/** Drops fill and stroke colours (attributes, style and theme classes) from a label and its spans. */
function stripColors(el: Node): void {
  el.removeAttribute('fill');
  el.removeAttribute('stroke');
  const style = el.getAttribute('style');
  if (style !== null) {
    const kept = style
      .split(';')
      .filter((d) => !/^\s*(fill|stroke)\s*:/i.test(d))
      .join(';');
    if (kept.trim()) el.setAttribute('style', kept);
    else el.removeAttribute('style');
  }
  const rest = classes(el).filter((c) => !/^viz-(fill|stroke)-/.test(c));
  if (rest.length) el.setAttribute('class', rest.join(' '));
  else el.removeAttribute('class');
  for (const c of elements(el)) stripColors(c);
}

function recolor(el: Node, tok: 'ink' | 'paper', outline: boolean): void {
  stripColors(el);
  for (const [n] of OUTLINE) el.removeAttribute(n);
  const cls = [...classes(el), `viz-fill-${tok}`];
  if (outline) {
    for (const [n, v] of OUTLINE) el.setAttribute(n, v);
    cls.push('viz-stroke-paper');
  }
  el.setAttribute('class', cls.join(' '));
}

const hasOutline = (el: Node): boolean =>
  classes(el).includes('viz-stroke-paper') && OUTLINE.every(([n, v]) => el.getAttribute(n) === v);

/**
 * Walks the diagram in paint order and judges each text with explicit x and y: the backdrop is the
 * last solid rectangle, circle or ellipse painted before it that contains its anchor point (the
 * page when none does). Only translate transforms are followed; any other transform on the text or
 * on its backdrop leaves the text alone, as do backdrops other than paper, ink or an accent fill.
 */
export function fixLabelContrast(root: Node, colorToken: ToToken): void {
  const painted: Backdrop[] = [];
  const visit = (el: Node, parent: Ctx): void => {
    const name = el.localName ?? '';
    if (NOT_PAINTED.has(name)) return;
    const t = translation(el.getAttribute('transform'));
    const own = ownFill(el, colorToken);
    const ctx: Ctx = {
      fill: own ?? parent.fill,
      opacity: parent.opacity * ownOpacity(el, ['opacity']),
      tx: parent.tx + (t?.x ?? 0),
      ty: parent.ty + (t?.y ?? 0),
      skewed: parent.skewed || t === null,
    };
    if (name === 'text') {
      judge(el, ctx);
      return;
    }
    const fill = ctx.fill;
    const solid = fill !== undefined && fill !== 'none' && fill !== 'url';
    if (solid && ctx.opacity * ownOpacity(el, ['fill-opacity']) >= MIN_OPACITY) {
      const b = backdropOf(el, ctx, fill);
      if (b) painted.push(b);
    }
    for (const c of elements(el)) visit(c, ctx);
  };

  const judge = (text: Node, ctx: Ctx): void => {
    const x = num(text.getAttribute('x'));
    const y = num(text.getAttribute('y'));
    if (x === undefined || y === undefined || ctx.skewed) return;
    const ax = x + ctx.tx;
    const ay = y + ctx.ty;
    let behind: Backdrop | undefined;
    for (let i = painted.length - 1; i >= 0; i--) {
      if (painted[i]?.contains(ax, ay)) {
        behind = painted[i];
        break;
      }
    }
    if (behind?.skewed) return;
    const back = behind?.tok ?? 'paper';
    const ink = ctx.fill ?? 'ink';
    if (ink === 'none' || ink === 'url') return;
    if (back === 'paper') {
      if (ink === 'paper') recolor(text, 'ink', false);
    } else if (back === 'ink') {
      if (ink !== 'paper') recolor(text, 'paper', false);
    } else if (ACCENTS.has(back)) {
      if (ink !== 'paper' && !(ink === 'ink' && hasOutline(text))) recolor(text, 'ink', true);
    }
  };

  // Unfilled marks and text default to ink (sanitizeSvg gives the root viz-fill-ink).
  visit(root, { fill: ownFill(root, colorToken) ?? 'ink', opacity: 1, tx: 0, ty: 0, skewed: false });
}
