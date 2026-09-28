/**
 * toPromptText (04 §11): a deterministic, structure-preserving text form. Identical input gives
 * byte-identical output; the golden tests in 13 §5 rely on it. Images appear as markers only.
 */
import type { ContentBlock, ExtractedContent, ListItem, NotesBlock, TableBlock } from './types';

export function xmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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

function blocks(bs: readonly ContentBlock[], headingOffset: number, out: string[]): void {
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
        out.push(b.alt ? `[image #${b.imageId}: "${b.alt.replace(/"/g, "'")}"]` : `[image #${b.imageId}]`);
        break;
      case 'notes':
        notes(b, out);
        break;
      case 'slide':
        if (out.length > 1) out.push('');
        out.push(`## Slide ${b.index}${b.title ? `: ${b.title}` : ''}${b.hidden ? ' (hidden)' : ''}`);
        blocks(b.blocks, 2, out);
        if (b.notes) notes(b.notes, out);
        break;
      case 'page':
        if (out.length > 1) out.push('');
        out.push(`--- Page ${b.number} ---`);
        blocks(b.blocks, headingOffset, out);
        break;
    }
  }
}

export function toPromptText(content: ExtractedContent): string {
  const attrs: string[] = [`ref="${xmlAttr(content.sourceRef)}"`, `format="${content.format}"`];
  if (content.stats.slides !== undefined) attrs.push(`slides="${content.stats.slides}"`);
  if (content.stats.pages !== undefined) attrs.push(`pages="${content.stats.pages}"`);
  if (content.stats.scannedPages) attrs.push(`scanned-pages="${content.stats.scannedPages}"`);
  if (content.stats.sheets !== undefined) attrs.push(`sheets="${content.stats.sheets}"`);
  attrs.push(`truncated="${content.truncated}"`);
  const out: string[] = [`<source ${attrs.join(' ')}>`];
  blocks(content.blocks, 0, out);
  out.push('</source>');
  return out.join('\n');
}
