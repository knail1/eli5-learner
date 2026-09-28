// Selected text without glossary notes (08 §5.3, §5.6): the text the menu sends and the text a copy
// puts on the clipboard. Block boundaries become paragraph breaks.

/** Glossary margin notes: DOM-interleaved with the body, but never part of a body selection. */
export const NOTE_SELECTOR = 'details.gl-note';

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TR',
  'UL',
]);

/** A copy of the range's contents with every element matching `exclude` removed. */
export function filteredContents(range: Range, exclude: string): DocumentFragment {
  const frag = range.cloneContents();
  for (const el of Array.from(frag.querySelectorAll(exclude))) el.remove();
  return frag;
}

/** Text of a node with "\n\n" between blocks and runs of spaces collapsed; SVG text is skipped. */
export function blockText(root: Node): string {
  const parts: string[] = [];
  const walk = (n: Node): void => {
    if (n.nodeType === 3) {
      parts.push((n as Text).data.replace(/\s+/g, ' '));
      return;
    }
    if (n.nodeType !== 1 && n.nodeType !== 11) return;
    const el = n.nodeType === 1 ? (n as Element) : null;
    // Chart marks and tick labels are not prose; the chart's title and caption are.
    if (el && (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName.toLowerCase() === 'svg')) return;
    const block = el !== null && BLOCK_TAGS.has(el.tagName);
    if (block) parts.push('\n\n');
    for (const c of Array.from(n.childNodes)) walk(c);
    if (block) parts.push('\n\n');
  };
  walk(root);
  return parts
    .join('')
    .split(/\n{2,}/)
    .map((p) => p.replace(/ +/g, ' ').trim())
    .filter((p) => p !== '')
    .join('\n\n');
}

/** The range's text without `exclude` elements, paragraph breaks kept. */
export function rangeText(range: Range, exclude: string): string {
  return blockText(filteredContents(range, exclude));
}
