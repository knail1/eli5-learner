/** Plain text (04 §9.2): decode, normalize line endings, paragraphs on blank lines, bullet lists. */
import type { ResolvedSource } from '../sources';
import { readSourceText } from './payload';
import { buildNestedList, cleanInline, cleanMultiline, matchBullet, newContent } from './text-util';
import type { ContentBlock, ExtractContext, ExtractResult, Extractor } from './types';

/** Structured text wrapped whole as code chunks (04 §9.2 step 4). */
const CODE_EXT = /\.(json|ya?ml|xml|log)$/i;
const CODE_CHUNK = 4000;

export function textToBlocks(text: string, opts: { asCode?: boolean } = {}): ContentBlock[] {
  const src = text.replace(/\r\n?/g, '\n');
  const blocks: ContentBlock[] = [];
  if (opts.asCode) {
    const body = cleanMultiline(src, { keepIndent: true });
    for (let i = 0; i < body.length; i += CODE_CHUNK) {
      blocks.push({ kind: 'paragraph', text: body.slice(i, i + CODE_CHUNK), style: 'code' });
    }
    return blocks;
  }
  for (const para of src.split(/\n[^\S\n]*\n/)) {
    const lines = para.split('\n').filter((l) => l.trim() !== '');
    let prose: string[] = [];
    let items: Array<{ level: number; text: string }> = [];
    let ordered = false;
    const flushProse = (): void => {
      const t = cleanInline(prose.join(' '));
      if (t) blocks.push({ kind: 'paragraph', text: t });
      prose = [];
    };
    const flushList = (): void => {
      if (items.length) blocks.push({ kind: 'list', ordered, items: buildNestedList(items) });
      items = [];
    };
    for (const line of lines) {
      const b = matchBullet(line);
      if (b) {
        flushProse();
        if (!items.length) ordered = b.ordered;
        items.push({ level: Math.floor(b.indent / 2), text: cleanInline(b.text) });
      } else if (items.length && /^\s{2,}\S/.test(line)) {
        // Wrapped continuation of the previous bullet.
        const last = items[items.length - 1]!;
        last.text = cleanInline(`${last.text} ${line}`);
      } else {
        flushList();
        prose.push(line);
      }
    }
    flushList();
    flushProse();
  }
  return blocks;
}

export const textExtractor: Extractor = {
  id: 'text',
  formats: ['text'],
  canHandle: (s) => s.format === 'text',
  async extract(source: ResolvedSource, _ctx: ExtractContext): Promise<ExtractResult> {
    const text = await readSourceText(source);
    const asCode = source.payload.kind === 'path' && CODE_EXT.test(source.location);
    return { ok: true, content: newContent(source, { blocks: textToBlocks(text, { asCode }) }) };
  },
};
