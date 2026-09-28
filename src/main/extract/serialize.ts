/**
 * toPromptText (04 §11): a deterministic, structure-preserving text form. Identical input gives
 * byte-identical output; the golden tests in 13 §5 rely on it. Images appear as markers only.
 * The `<source>` delimiter and its escaping belong to 02 (02 §9 "Untrusted content"): this module
 * renders the body and supplies the delimiter attributes via promptAttributes().
 */
import type { ContentBlock, ExtractedContent, ImageBlock, ListItem, NotesBlock, TableBlock } from './types';

export interface PromptTextOptions {
  /** Marker line for an image block; default `[image #<id>: "<alt>"]`. 02 passes its vision labels. */
  imageMarker?: (b: ImageBlock) => string;
}

const defaultMarker = (b: ImageBlock): string =>
  b.alt ? `[image #${b.imageId}: "${b.alt.replace(/"/g, "'")}"]` : `[image #${b.imageId}]`;

function cell(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ');
}

function row(cells: readonly string[], width: number): string {
  const padded = [...cells];
  while (padded.length < width) padded.push('');
  return `| ${padded.map(cell).join(' | ')} |`;
}

function table(t: TableBlock, out: string[]): void {
  if (t.caption) out.push(t.caption.startsWith('Chart:') ? t.caption : `Table: ${t.caption}`);
  const width = Math.max(t.header?.length ?? 0, ...t.rows.map((r) => r.length), 1);
  if (t.header) {
    out.push(row(t.header, width));
    out.push(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`);
  }
  for (const r of t.rows) out.push(row(r, width));
  if (t.truncated) {
    const parts: string[] = [];
    if (t.truncated.rows) parts.push(`${t.truncated.rows} more rows`);
    if (t.truncated.cols) parts.push(`${t.truncated.cols} more columns`);
    if (parts.length) out.push(`[table truncated: ${parts.join(', ')}]`);
  }
}

function list(items: readonly ListItem[], ordered: boolean, depth: number, out: string[]): void {
  items.forEach((it, i) => {
    const marker = ordered ? `${i + 1}.` : '-';
    out.push(`${'  '.repeat(depth)}${marker} ${it.text}`);
    if (it.children?.length) list(it.children, ordered, depth + 1, out);
  });
}

function notes(n: NotesBlock, out: string[]): void {
  const lines = n.text.split('\n');
  out.push(`> Speaker notes: ${lines[0] ?? ''}`);
  for (const l of lines.slice(1)) out.push(`> ${l}`);
}

type Marker = (b: ImageBlock) => string;

function blocks(bs: readonly ContentBlock[], headingOffset: number, out: string[], marker: Marker): void {
  for (const b of bs) {
    switch (b.kind) {
      case 'heading':
        out.push(`${'#'.repeat(Math.min(6, b.level + headingOffset))} ${b.text}`);
        break;
      case 'paragraph':
        if (b.style === 'code') {
          out.push('```', b.text, '```');
        } else if (b.style === 'quote') {
          for (const l of b.text.split('\n')) out.push(`> ${l}`);
        } else {
          out.push(b.text);
        }
        break;
      case 'list':
        list(b.items, b.ordered, 0, out);
        break;
      case 'table':
        table(b, out);
        break;
      case 'image':
        out.push(marker(b));
        break;
      case 'notes':
        notes(b, out);
        break;
      case 'slide':
        if (out.length > 0) out.push('');
        out.push(`## Slide ${b.index}${b.title ? `: ${b.title}` : ''}${b.hidden ? ' (hidden)' : ''}`);
        blocks(b.blocks, 2, out, marker);
        if (b.notes) notes(b.notes, out);
        break;
      case 'page':
        if (out.length > 0) out.push('');
        out.push(`--- Page ${b.number} ---`);
        blocks(b.blocks, headingOffset, out, marker);
        break;
    }
  }
}

/** Body text for a run of blocks (no delimiter); 02 uses it per block when chunking (02 §8.4). */
export function blocksToPromptText(bs: readonly ContentBlock[], opts: PromptTextOptions = {}): string {
  const out: string[] = [];
  blocks(bs, 0, out, opts.imageMarker ?? defaultMarker);
  return out.join('\n');
}

/** The body of one source's prompt text (04 §11); 02 wraps it in `<source ...>` (02 §9). */
export function toPromptText(content: ExtractedContent, opts: PromptTextOptions = {}): string {
  return blocksToPromptText(content.blocks, opts);
}

/** Delimiter attributes after `ref` (04 §11), in fixed order; values are raw (02 escapes them). */
export function promptAttributes(content: ExtractedContent): [string, string][] {
  const attrs: [string, string][] = [['format', content.format]];
  if (content.stats.slides !== undefined) attrs.push(['slides', String(content.stats.slides)]);
  if (content.stats.pages !== undefined) attrs.push(['pages', String(content.stats.pages)]);
  if (content.stats.scannedPages) attrs.push(['scanned-pages', String(content.stats.scannedPages)]);
  if (content.stats.sheets !== undefined) attrs.push(['sheets', String(content.stats.sheets)]);
  attrs.push(['truncated', String(content.truncated)]);
  return attrs;
}
