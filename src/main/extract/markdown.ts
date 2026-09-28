/**
 * Markdown (04 §9.1): the marked lexer only, text kept verbatim (inline markup included) so
 * headings, lists and tables become structure hints. Front matter is removed and its title used.
 * Image references become "[image: alt]"; local image files are never followed.
 */
import { marked, type Token, type Tokens } from 'marked';
import { readSourceText } from './payload';
import { cleanInline, cleanMultiline, newContent } from './text-util';
import type { ContentBlock, ExtractContext, ExtractResult, Extractor, ListItem } from './types';
import type { ResolvedSource } from '../sources';

const FRONT_MATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/;

export function splitFrontMatter(src: string): { body: string; title?: string } {
  const m = FRONT_MATTER.exec(src);
  if (!m) return { body: src };
  const t = /^title:\s*(.+?)\s*$/m.exec(m[1] ?? '');
  const title = t?.[1]?.replace(/^(['"])(.*)\1$/, '$2').trim();
  return { body: src.slice(m[0].length), ...(title ? { title } : {}) };
}

function inline(s: string): string {
  return cleanInline(s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => `[image: ${alt.trim()}]`));
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ');
}

function listItems(list: Tokens.List): ListItem[] {
  const out: ListItem[] = [];
  for (const it of list.items) {
    const parts: string[] = [];
    const children: ListItem[] = [];
    for (const t of it.tokens) {
      if (t.type === 'list') children.push(...listItems(t as Tokens.List));
      else if (t.type === 'checkbox') continue;
      else if ('text' in t && typeof t.text === 'string') parts.push(t.type === 'html' ? stripTags(t.text) : t.text);
    }
    let text = inline(parts.join(' '));
    if (it.task) text = `[${it.checked ? 'x' : ' '}] ${text.replace(/^\[[ xX]\]\s*/, '')}`.trim();
    const item: ListItem = { text };
    if (children.length) item.children = children;
    if (item.text || item.children) out.push(item);
  }
  return out;
}

function tokensToBlocks(tokens: readonly Token[], quote: boolean, out: ContentBlock[]): void {
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': {
        const text = inline((t as Tokens.Heading).text);
        if (!text) break;
        if (quote) out.push({ kind: 'paragraph', text, style: 'quote' });
        else
          out.push({ kind: 'heading', level: Math.min(6, (t as Tokens.Heading).depth) as 1 | 2 | 3 | 4 | 5 | 6, text });
        break;
      }
      case 'paragraph':
      case 'text': {
        const text = inline((t as Tokens.Paragraph).text);
        if (text) out.push({ kind: 'paragraph', text, ...(quote ? { style: 'quote' as const } : {}) });
        break;
      }
      case 'list': {
        const items = listItems(t as Tokens.List);
        if (items.length) out.push({ kind: 'list', ordered: (t as Tokens.List).ordered, items });
        break;
      }
      case 'table': {
        const tt = t as Tokens.Table;
        out.push({
          kind: 'table',
          header: tt.header.map((c) => inline(c.text)),
          rows: tt.rows.map((r) => r.map((c) => inline(c.text))),
        });
        break;
      }
      case 'blockquote':
        tokensToBlocks((t as Tokens.Blockquote).tokens, true, out);
        break;
      case 'code': {
        const text = cleanMultiline((t as Tokens.Code).text, { keepIndent: true });
        if (text) out.push({ kind: 'paragraph', text, style: 'code' });
        break;
      }
      case 'html': {
        const text = cleanInline(stripTags((t as Tokens.HTML).text));
        if (text) out.push({ kind: 'paragraph', text });
        break;
      }
      default:
        break; // space, hr, def
    }
  }
}

export function markdownToBlocks(src: string): { blocks: ContentBlock[]; title?: string } {
  const { body, title } = splitFrontMatter(src.replace(/\r\n?/g, '\n'));
  const blocks: ContentBlock[] = [];
  tokensToBlocks(marked.lexer(body, { gfm: true }), false, blocks);
  return { blocks, ...(title ? { title } : {}) };
}

export const markdownExtractor: Extractor = {
  id: 'markdown',
  formats: ['markdown'],
  canHandle: (s) => s.format === 'markdown',
  async extract(source: ResolvedSource, _ctx: ExtractContext): Promise<ExtractResult> {
    const { blocks, title } = markdownToBlocks(await readSourceText(source));
    return { ok: true, content: newContent(source, { blocks, ...(title ? { title } : {}) }) };
  },
};
