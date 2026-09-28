/**
 * Visible text of a generated document for the judge (13 §9.3 step 3): HTML stripped, glossary notes,
 * figure captions and chart data kept as text, scripts and SVG drawing primitives dropped.
 */
import {
  attr,
  findAll,
  isElement,
  parseTree,
  textOf,
  type P5Element,
  type P5Node,
} from '../../../src/main/document/html-tree';

const SKIP = new Set(['script', 'style', 'template', 'button', 'noscript']);
const BLOCK = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'ol',
  'ul',
  'section',
  'div',
  'figure',
  'figcaption',
  'aside',
  'blockquote',
  'details',
  'summary',
  'header',
  'footer',
  'table',
  'pre',
  'br',
]);

const classes = (el: P5Element): string[] => (attr(el, 'class') ?? '').split(/\s+/).filter(Boolean);
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

function kids(n: P5Node): P5Node[] {
  return 'childNodes' in n ? n.childNodes : [];
}

function svgLabel(svg: P5Element): string {
  const title = findAll(svg, (e) => e.tagName === 'title')[0];
  const desc = findAll(svg, (e) => e.tagName === 'desc')[0];
  const parts = [attr(svg, 'aria-label'), title ? textOf(title) : undefined, desc ? textOf(desc) : undefined]
    .map((s) => squash(s ?? ''))
    .filter(Boolean);
  return [...new Set(parts)].join(' — ');
}

function emit(n: P5Node, out: string[]): void {
  if (n.nodeName === '#text' && 'value' in n) {
    out.push(n.value);
    return;
  }
  if (!isElement(n)) return;
  const tag = n.tagName;
  const cls = classes(n);
  if (SKIP.has(tag) || attr(n, 'aria-hidden') === 'true') return;
  if (tag === 'details' && cls.includes('gl-note')) {
    const summary = n.childNodes.find((c): c is P5Element => isElement(c) && c.tagName === 'summary');
    const body = n.childNodes.filter((c) => c !== summary);
    out.push(
      `\n[Glossary] ${squash(summary ? textOf(summary) : '')}: ${squash(body.map((c) => textOf(c)).join(' '))}\n`,
    );
    return;
  }
  if (tag === 'svg') {
    // Chart SVGs are covered by their title and data table; other SVGs are diagrams.
    const label = svgLabel(n);
    if (!cls.includes('viz') && label) out.push(`\n[Diagram] ${label}\n`);
    return;
  }
  if (tag === 'img') {
    const alt = squash(attr(n, 'alt') ?? '');
    if (alt) out.push(`\n[Image] ${alt}\n`);
    return;
  }
  if (tag === 'summary' && n.parentNode && isElement(n.parentNode) && classes(n.parentNode).includes('chart-data')) {
    return; // "Show data"
  }
  if (tag === 'tr') {
    const cells = n.childNodes.filter(
      (c): c is P5Element => isElement(c) && (c.tagName === 'td' || c.tagName === 'th'),
    );
    out.push(`\n${cells.map((c) => squash(textOf(c))).join(' | ')}\n`);
    return;
  }
  if (tag === 'h3' && cls.includes('chart-title')) {
    out.push(`\n[Chart] ${squash(textOf(n))}\n`);
    return;
  }
  const block = BLOCK.has(tag);
  if (block) out.push('\n');
  for (const c of kids(n)) emit(c, out);
  if (block) out.push('\n');
}

function toText(el: P5Element): string {
  const out: string[] = [];
  emit(el, out);
  return out.join('').split('\n').map(squash).filter(Boolean).join('\n');
}

function panel(html: string, tabKey: string): P5Element {
  const { doc } = parseTree(html);
  const p = findAll(doc, (e) => attr(e, 'role') === 'tabpanel' && attr(e, 'data-tab-key') === tabKey)[0];
  if (!p) throw new Error(`document has no tab panel "${tabKey}"`);
  return p;
}

/** Tab keys in document order. */
export function tabKeys(html: string): string[] {
  const { doc } = parseTree(html);
  return findAll(doc, (e) => attr(e, 'role') === 'tabpanel')
    .map((e) => attr(e, 'data-tab-key') ?? '')
    .filter(Boolean);
}

export function tabText(html: string, tabKey: string): string {
  return toText(panel(html, tabKey));
}

export function sectionText(html: string, sectionId: string): string {
  const { doc } = parseTree(html);
  const s = findAll(doc, (e) => e.tagName === 'section' && attr(e, 'id') === sectionId)[0];
  if (!s) throw new Error(`document has no section ${sectionId}`);
  return toText(s);
}

export interface GlossaryNoteText {
  /** The callout's own term (`<b>`). */
  term: string;
  /** Its summary line: the term plus an optional expansion ("ROAS · return on ad spend"). */
  summary: string;
  text: string;
}

/** Glossary callouts (`details.gl-note`) inside the In depth panel (07 §9.2). */
export function glossaryNotes(html: string): GlossaryNoteText[] {
  let p: P5Element;
  try {
    p = panel(html, 'indepth');
  } catch {
    return [];
  }
  return findAll(p, (e) => e.tagName === 'details' && classes(e).includes('gl-note')).map((d) => {
    const b = findAll(d, (e) => e.tagName === 'b')[0];
    const summary = findAll(d, (e) => e.tagName === 'summary')[0];
    return {
      term: squash(b ? textOf(b) : ''),
      summary: squash(summary ? textOf(summary) : ''),
      text: squash(textOf(d)),
    };
  });
}
