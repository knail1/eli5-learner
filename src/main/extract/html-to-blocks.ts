/**
 * HTML to blocks (04 §9.3), shared by docx (§5.2), rich-text pastes, and 05 after Readability.
 * linkedom parses without running scripts. Inline elements reduce to text; link URLs are dropped
 * (bare autolinks keep their text, which is the URL). Remote images are never fetched: their alt
 * text stays inline. Only docx placeholders (`img[data-eli5-img]`) become ImageBlocks.
 */
import { parseHTML } from 'linkedom';
import { cleanInline, cleanMultiline } from './text-util';
import type { ContentBlock, ImageBlock, ListItem, TableBlock } from './types';

/** Minimal structural view of the linkedom DOM that this walker needs. */
export interface DomNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
  getAttribute?(name: string): string | null;
}

export interface ImageRef {
  /** The placeholder id (docx: the `data-eli5-img` value), also used as the ImageBlock.imageId. */
  ref: string;
  alt?: string;
}

export interface HtmlBlocks {
  blocks: ContentBlock[];
  imageRefs: ImageRef[];
}

const DROP = new Set([
  'SCRIPT',
  'STYLE',
  'NAV',
  'SVG',
  'FORM',
  'NOSCRIPT',
  'TEMPLATE',
  'IFRAME',
  'HEAD',
  'BUTTON',
  'SELECT',
  'TEXTAREA',
  'INPUT',
  'OBJECT',
  'EMBED',
  'CANVAS',
]);
const BLOCK = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'TABLE',
  'BLOCKQUOTE',
  'PRE',
  'FIGURE',
  'FIGCAPTION',
  'SECTION',
  'ARTICLE',
  'MAIN',
  'HEADER',
  'FOOTER',
  'ASIDE',
  'HR',
  'DL',
  'DT',
  'DD',
  'ADDRESS',
  'DETAILS',
  'SUMMARY',
  'LI',
  'BODY',
  'HTML',
]);

function tag(n: DomNode): string {
  return n.nodeName.toUpperCase();
}
function isEl(n: DomNode): boolean {
  return n.nodeType === 1;
}
function kids(n: DomNode): DomNode[] {
  return Array.from(n.childNodes);
}
function attrOf(n: DomNode, name: string): string | null {
  return n.getAttribute ? n.getAttribute(name) : null;
}

/** Parses an HTML string (fragment or document) and returns its body. */
export function parseBody(html: string): DomNode {
  const doc = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head></head><body>${html}</body></html>`;
  const { document } = parseHTML(doc);
  return (document.body ?? document.documentElement) as unknown as DomNode;
}

class Walker {
  readonly blocks: ContentBlock[] = [];
  readonly imageRefs: ImageRef[] = [];

  /** Inline text of a node; images become "[image: alt]" or, for placeholders, are collected. */
  inlineText(n: DomNode, pendingImages?: ImageBlock[]): string {
    if (n.nodeType === 3) return n.textContent ?? '';
    if (!isEl(n)) return '';
    const t = tag(n);
    if (DROP.has(t)) return '';
    if (t === 'BR') return ' ';
    if (t === 'IMG') {
      const ph = attrOf(n, 'data-eli5-img');
      const alt = attrOf(n, 'alt')?.trim() || undefined;
      if (ph !== null && pendingImages) {
        this.imageRefs.push({ ref: ph, ...(alt ? { alt } : {}) });
        pendingImages.push({ kind: 'image', imageId: ph, origin: 'embedded', ...(alt ? { alt } : {}) });
        return '';
      }
      return alt ? ` [image: ${alt}] ` : '';
    }
    return kids(n)
      .map((c) => this.inlineText(c, pendingImages))
      .join('');
  }

  private pushParagraph(raw: string, style?: 'quote' | 'code'): void {
    const text = style === 'code' ? cleanMultiline(raw, { keepIndent: true }) : cleanInline(raw);
    if (text) this.blocks.push({ kind: 'paragraph', text, ...(style ? { style } : {}) });
  }

  /** Walks a container, flushing runs of inline content as paragraphs. */
  walk(n: DomNode, style?: 'quote'): void {
    let buf = '';
    let imgs: ImageBlock[] = [];
    const flush = (): void => {
      this.pushParagraph(buf, style);
      this.blocks.push(...imgs);
      buf = '';
      imgs = [];
    };
    for (const c of kids(n)) {
      if (!isEl(c) || !BLOCK.has(tag(c))) {
        buf += this.inlineText(c, imgs);
        continue;
      }
      flush();
      this.block(c, style);
    }
    flush();
  }

  block(n: DomNode, style?: 'quote'): void {
    const t = tag(n);
    if (DROP.has(t)) return;
    if (/^H[1-6]$/.test(t)) {
      const imgs: ImageBlock[] = [];
      const text = cleanInline(this.inlineText(n, imgs));
      if (text) {
        if (style) this.blocks.push({ kind: 'paragraph', text, style });
        else this.blocks.push({ kind: 'heading', level: Number(t[1]) as 1 | 2 | 3 | 4 | 5 | 6, text });
      }
      this.blocks.push(...imgs);
      return;
    }
    switch (t) {
      case 'UL':
      case 'OL': {
        const imgs: ImageBlock[] = [];
        const items = this.listItems(n, imgs);
        if (items.length) this.blocks.push({ kind: 'list', ordered: t === 'OL', items });
        this.blocks.push(...imgs);
        return;
      }
      case 'TABLE': {
        const table = this.table(n);
        if (table) this.blocks.push(table);
        return;
      }
      case 'BLOCKQUOTE':
        this.walk(n, 'quote');
        return;
      case 'PRE':
        this.pushParagraph(n.textContent ?? '', 'code');
        return;
      case 'HR':
        return;
      default:
        this.walk(n, style);
    }
  }

  private listItems(list: DomNode, imgs: ImageBlock[]): ListItem[] {
    const items: ListItem[] = [];
    for (const li of kids(list)) {
      if (!isEl(li)) continue;
      if (tag(li) !== 'LI') {
        // Stray nested list directly under a list: attach to the previous item.
        if ((tag(li) === 'UL' || tag(li) === 'OL') && items.length) {
          const prev = items[items.length - 1]!;
          (prev.children ??= []).push(...this.listItems(li, imgs));
        }
        continue;
      }
      let text = '';
      const children: ListItem[] = [];
      for (const c of kids(li)) {
        if (isEl(c) && (tag(c) === 'UL' || tag(c) === 'OL')) children.push(...this.listItems(c, imgs));
        else if (isEl(c) && tag(c) === 'TABLE') text += ` ${cellText(c)} `;
        else text += ` ${this.inlineText(c, imgs)} `;
      }
      const item: ListItem = { text: cleanInline(text) };
      if (children.length) item.children = children;
      if (item.text || item.children) items.push(item);
    }
    return items;
  }

  private table(t: DomNode): TableBlock | undefined {
    const rows: Array<{ cells: string[]; header: boolean; inHead: boolean }> = [];
    const collectRows = (n: DomNode, inHead: boolean): void => {
      for (const c of kids(n)) {
        if (!isEl(c)) continue;
        const ct = tag(c);
        if (ct === 'THEAD') collectRows(c, true);
        else if (ct === 'TBODY' || ct === 'TFOOT') collectRows(c, false);
        else if (ct === 'TR') {
          const cells: string[] = [];
          let allTh = true;
          let any = false;
          for (const cell of kids(c)) {
            if (!isEl(cell) || (tag(cell) !== 'TD' && tag(cell) !== 'TH')) continue;
            any = true;
            if (tag(cell) !== 'TH') allTh = false;
            cells.push(cellText(cell));
            const span = Math.min(Number(attrOf(cell, 'colspan') ?? '1') || 1, 100);
            for (let k = 1; k < span; k++) cells.push('');
          }
          if (any) rows.push({ cells, header: allTh, inHead });
        }
      }
    };
    collectRows(t, false);
    if (!rows.length) return undefined;
    const caption = attrOf(t, 'data-caption') ?? undefined;
    const first = rows[0]!;
    const hasHeader = first.inHead || first.header;
    const body = (hasHeader ? rows.slice(1) : rows).map((r) => r.cells);
    return {
      kind: 'table',
      ...(caption ? { caption: cleanInline(caption) } : {}),
      ...(hasHeader ? { header: first.cells } : {}),
      rows: body,
    };
  }
}

/** Cell text; nested tables flatten to their cell text joined with "; " (04 §5.2). */
function cellText(cell: DomNode): string {
  const parts: string[] = [];
  let buf = '';
  const visit = (n: DomNode): void => {
    if (n.nodeType === 3) {
      buf += n.textContent ?? '';
      return;
    }
    if (!isEl(n) || DROP.has(tag(n))) return;
    const t = tag(n);
    if (t === 'TD' || t === 'TH') {
      if (buf.trim()) parts.push(buf);
      buf = '';
      kids(n).forEach(visit);
      if (buf.trim()) parts.push(buf);
      buf = '';
      return;
    }
    if (t === 'IMG') {
      const alt = attrOf(n, 'alt')?.trim();
      if (alt) buf += ` [image: ${alt}] `;
      return;
    }
    if (t === 'BR' || BLOCK.has(t)) buf += ' ';
    kids(n).forEach(visit);
    if (BLOCK.has(t)) buf += ' ';
  };
  kids(cell).forEach(visit);
  if (buf.trim()) parts.push(buf);
  return parts.map(cleanInline).filter(Boolean).join('; ');
}

/** Converts an already-parsed DOM subtree (used by docx after its DOM pre-pass). */
export function domToBlocks(root: DomNode): HtmlBlocks {
  const w = new Walker();
  w.walk(root);
  return { blocks: w.blocks, imageRefs: w.imageRefs };
}

/** 04 §9.3. `baseUrl` is accepted for 05's callers; link URLs are dropped, so it is unused today. */
export function htmlToBlocks(html: string, _baseUrl?: string): HtmlBlocks {
  return domToBlocks(parseBody(html));
}
