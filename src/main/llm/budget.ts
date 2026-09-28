import type { ContentBlock, ExtractedContent } from '../extract';
import type { ImageInput, ModelLimits } from './types';

/**
 * Token estimation, context budgeting and the chunk planner (02 §8). Estimates are deliberately
 * pessimistic.
 */

// ---- 8.1 estimation ----

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿ｦ-ﾟ]/g;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const cjk = text.match(CJK_RE)?.length ?? 0;
  return Math.ceil(text.length / (cjk / text.length > 0.3 ? 1.5 : 3.5));
}

export const MAX_IMAGE_EDGE = 1568;
export const MAX_IMAGE_TOKENS = 1600;

/** ceil(w*h/750) after resizing to the 1568 px long edge, capped at 1600 per image. */
export function imageTokens(width: number, height: number): number {
  if (width <= 0 || height <= 0) return MAX_IMAGE_TOKENS;
  const s = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
  return Math.min(MAX_IMAGE_TOKENS, Math.ceil((width * s * (height * s)) / 750));
}

// ---- 8.2 budget ----

export const FRAMING_TOKENS = 2000;

/** Output reserved for the call; includes thinking tokens (02 §8.2). */
export function reservedOutput(limits: ModelLimits, maxOutputSetting: number): number {
  return Math.min(maxOutputSetting, limits.maxOutputTokens);
}

/** Visible-output budget prompts may target: reservedOutput minus the thinking reserve. */
export function visibleOutput(limits: ModelLimits, maxOutputSetting: number): number {
  return Math.max(1024, reservedOutput(limits, maxOutputSetting) - limits.thinkingReserveTokens);
}

export function inputBudget(limits: ModelLimits, systemTokens: number, maxOutputSetting: number): number {
  return (
    Math.floor(limits.contextTokens * 0.8) - systemTokens - reservedOutput(limits, maxOutputSetting) - FRAMING_TOKENS
  );
}

// ---- prompt serialization of extracted content ----

/** Keeps source text from closing its untrusted-content delimiter (02 §9 "Untrusted content"). */
export function escapeSourceText(text: string): string {
  return text.replace(/<(\/?)source/gi, '<$1​source');
}

export function wrapSource(ref: string, body: string, part?: string): string {
  const attr = ref.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<source ref="${attr}"${part ? ` part="${part}"` : ''}>\n${escapeSourceText(body)}\n</source>`;
}

type LabelOf = (imageId: string) => string | undefined;

function listLines(
  items: { text: string; children?: { text: string }[] }[],
  ordered: boolean,
  depth: number,
): string[] {
  return items.flatMap((it, i) => {
    const bullet = ordered ? `${i + 1}.` : '-';
    const self = `${'  '.repeat(depth)}${bullet} ${it.text}`;
    const kids = (it as { children?: typeof items }).children;
    return [self, ...(kids ? listLines(kids, ordered, depth + 1) : [])];
  });
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/**
 * Markdown-like rendering of blocks. 04 owns the canonical `toPromptText`; this local renderer is
 * used until that lands in extract's index (see integration notes).
 */
export function renderBlocks(blocks: readonly ContentBlock[], labelOf: LabelOf): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'heading':
        out.push(`${'#'.repeat(b.level)} ${b.text}`);
        break;
      case 'paragraph':
        out.push(b.style === 'quote' ? `> ${b.text}` : b.style === 'code' ? '```\n' + b.text + '\n```' : b.text);
        break;
      case 'list':
        out.push(listLines(b.items, b.ordered, 0).join('\n'));
        break;
      case 'table': {
        const rows = b.header ? [b.header, ...b.rows] : b.rows;
        const width = Math.max(0, ...rows.map((r) => r.length));
        const lines = rows.map((r) => `| ${Array.from({ length: width }, (_, i) => cell(r[i] ?? '')).join(' | ')} |`);
        if (b.header && lines.length) lines.splice(1, 0, `|${' --- |'.repeat(width)}`);
        out.push([b.caption ? `Table: ${b.caption}` : '', ...lines].filter(Boolean).join('\n'));
        break;
      }
      case 'slide':
        out.push(
          [
            `## Slide ${b.index}${b.title ? `: ${b.title}` : ''}${b.hidden ? ' (hidden)' : ''}`,
            renderBlocks(b.blocks, labelOf),
            b.notes ? `Speaker notes: ${b.notes.text}` : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        );
        break;
      case 'notes':
        out.push(`Speaker notes: ${b.text}`);
        break;
      case 'image': {
        const label = labelOf(b.imageId);
        out.push(
          label ? `[Image: ${label}]${b.alt ? ` ${b.alt}` : ''}` : `[Image not sent${b.alt ? `: ${b.alt}` : ''}]`,
        );
        break;
      }
      case 'page':
        out.push([`--- Page ${b.number} ---`, renderBlocks(b.blocks, labelOf)].join('\n\n'));
        break;
    }
  }
  return out.filter((s) => s !== '').join('\n\n');
}

export function contentToPromptText(contents: readonly ExtractedContent[], labelOf: LabelOf): string {
  return contents
    .map((c) =>
      wrapSource(
        c.sourceRef,
        [c.title ? `Title: ${c.title}` : '', renderBlocks(c.blocks, labelOf)].filter(Boolean).join('\n\n'),
      ),
    )
    .join('\n\n');
}

// ---- 8.4 chunk planning ----

export interface ContentUnit {
  sourceRef: string;
  text: string;
  tokens: number;
  images: ImageInput[];
}

function imageIdsIn(b: ContentBlock): string[] {
  switch (b.kind) {
    case 'image':
      return [b.imageId];
    case 'slide':
    case 'page':
      return b.blocks.flatMap(imageIdsIn);
    default:
      return [];
  }
}

export const OVERLAP_TOKENS = 200;

/** Splits text at sentence boundaries into pieces ≤ maxTokens with ~200 tokens of overlap. */
export function splitSentences(text: string, maxTokens: number, overlapTokens = OVERLAP_TOKENS): string[] {
  const sentences = text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)\s*/g) ?? [text];
  const pieces: string[] = [];
  let cur: string[] = [];
  let curTokens = 0;
  const flush = (): void => {
    if (!cur.length) return;
    pieces.push(cur.join('').trim());
    // carry trailing sentences worth ~overlapTokens into the next piece
    const carry: string[] = [];
    let t = 0;
    for (let i = cur.length - 1; i >= 0 && t < overlapTokens; i--) {
      const s = cur[i] ?? '';
      t += estimateTokens(s);
      carry.unshift(s);
    }
    cur = t < maxTokens / 2 ? carry : [];
    curTokens = cur.reduce((n, s) => n + estimateTokens(s), 0);
  };
  for (const raw of sentences) {
    // a single sentence longer than a piece is hard-cut by characters
    const parts: string[] = [];
    if (estimateTokens(raw) > maxTokens) {
      const size = Math.max(1, Math.floor(maxTokens * 3.5 * 0.9));
      for (let i = 0; i < raw.length; i += size) parts.push(raw.slice(i, i + size));
    } else parts.push(raw);
    for (const s of parts) {
      const t = estimateTokens(s);
      if (curTokens + t > maxTokens && cur.length) flush();
      cur.push(s);
      curTokens += t;
    }
  }
  if (cur.length) pieces.push(cur.join('').trim());
  return pieces.filter((p) => p !== '');
}

/**
 * Units at natural boundaries (02 §8.4 step 2): each top-level block of each source, in user order;
 * a unit larger than `maxUnitTokens` is split at sentences with overlap.
 */
export function contentUnits(
  contents: readonly ExtractedContent[],
  imagesById: ReadonlyMap<string, ImageInput & { tokens: number }>,
  maxUnitTokens: number,
): ContentUnit[] {
  const units: ContentUnit[] = [];
  const labelOf = (id: string): string | undefined => imagesById.get(id)?.label;
  for (const c of contents) {
    const blocks: ContentBlock[] = c.title ? [{ kind: 'heading', level: 1, text: c.title }, ...c.blocks] : c.blocks;
    for (const b of blocks) {
      const text = renderBlocks([b], labelOf);
      const imgs = imageIdsIn(b).flatMap((id) => {
        const img = imagesById.get(id);
        return img ? [img] : [];
      });
      const imgTokens = imgs.reduce((n, i) => n + i.tokens, 0);
      const tokens = estimateTokens(text);
      if (tokens > maxUnitTokens) {
        const pieces = splitSentences(text, maxUnitTokens);
        pieces.forEach((p, i) =>
          units.push({
            sourceRef: c.sourceRef,
            text: p,
            tokens: estimateTokens(p) + (i === 0 ? imgTokens : 0),
            images: i === 0 ? imgs : [],
          }),
        );
      } else {
        units.push({ sourceRef: c.sourceRef, text, tokens: tokens + imgTokens, images: imgs });
      }
    }
  }
  return units;
}

export interface Chunk {
  units: ContentUnit[];
  tokens: number;
  images: ImageInput[];
  sourceRefs: string[];
}

/** Greedy packing in order; a chunk closes at the token target or the per-request image cap. */
export function planChunks(units: readonly ContentUnit[], targetTokens: number, maxImages: number): Chunk[] {
  const chunks: Chunk[] = [];
  let cur: Chunk | undefined;
  for (const u of units) {
    const fits =
      cur !== undefined && cur.tokens + u.tokens <= targetTokens && cur.images.length + u.images.length <= maxImages;
    if (!fits) {
      cur = { units: [], tokens: 0, images: [], sourceRefs: [] };
      chunks.push(cur);
    }
    const c = cur as Chunk;
    c.units.push(u);
    c.tokens += u.tokens;
    c.images.push(...u.images.slice(0, Math.max(0, maxImages - c.images.length)));
    if (!c.sourceRefs.includes(u.sourceRef)) c.sourceRefs.push(u.sourceRef);
  }
  return chunks;
}

/** Renders a chunk, grouping consecutive units of the same source into one delimiter. */
export function renderChunk(chunk: Chunk): string {
  const groups: { ref: string; texts: string[] }[] = [];
  for (const u of chunk.units) {
    const last = groups.at(-1);
    if (last && last.ref === u.sourceRef) last.texts.push(u.text);
    else groups.push({ ref: u.sourceRef, texts: [u.text] });
  }
  return groups.map((g) => wrapSource(g.ref, g.texts.join('\n\n'))).join('\n\n');
}
