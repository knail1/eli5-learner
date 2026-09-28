/**
 * HTML sources (04 §4 dispatch row "html", §9.3). `html` payloads from 03/05 are already readable
 * HTML. A local `.html` file (`path` payload) goes through Readability first (`readable`; the public
 * registry passes the worker-safe readable.ts). Without it the raw page goes straight to
 * htmlToBlocks, which drops script, style, nav, svg and form.
 */
import type { ResolvedSource } from '../sources';
import { htmlToBlocks } from './html-to-blocks';
import { readSourceText } from './payload';
import { cleanInline, newContent } from './text-util';
import type { ExtractContext, ExtractResult, Extractor } from './types';

export type ReadableHtml = (html: string, baseUrl: string | undefined, signal: AbortSignal) => Promise<string>;

export function createHtmlExtractor(deps: { readable?: ReadableHtml } = {}): Extractor {
  return {
    id: 'html',
    formats: ['html'],
    canHandle: (s) => s.format === 'html',
    async extract(source: ResolvedSource, ctx: ExtractContext): Promise<ExtractResult> {
      let html = await readSourceText(source);
      const baseUrl = source.payload.kind === 'html' ? source.payload.baseUrl : undefined;
      let title = source.title;
      if (source.payload.kind === 'path') {
        if (!title) {
          const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
          const t = m?.[1] ? cleanInline(m[1]) : '';
          if (t) title = t;
        }
        if (deps.readable) html = await deps.readable(html, undefined, ctx.signal);
      }
      // Remote images are never fetched (04 §9.3); placeholders only exist for docx.
      const { blocks } = htmlToBlocks(html, baseUrl);
      const content = newContent(source, { blocks, ...(title ? { title } : {}) });
      return { ok: true, content };
    },
  };
}
