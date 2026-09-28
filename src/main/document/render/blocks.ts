// Block renderers (07 §7.1) and glossary note markup (07 §9.2).
import { renderChartFigure } from '../charts';
import { attrs, esc, escAttr } from '../html';
import { toDataUri } from '../images';
import { renderInline, renderInlineMany, type DfnAnchor, type InlineMarks } from '../inline-md';
import type { AssetRef, BlockEnhancement, DocBlock, GlossaryNote } from '../types';

/** How a merge's marks are written (07 §6.4): the `<ins>` opening tag and the hover text. */
export interface MergeMarkup {
  open(merge: string): string;
  title(merge: string): string;
}

export interface BlockContext {
  /** Unique per block in the document; used for ids inside charts and figures. */
  idBase: string;
  assets: ReadonlyMap<string, Uint8Array>;
  assetRefs: ReadonlyMap<string, AssetRef>;
  /** Glossary notes anchored in this block, in anchor order. */
  notes: readonly GlossaryNote[];
  /** Woven-merge marks of this block (07 §6.4). */
  enh?: BlockEnhancement | undefined;
  merges?: MergeMarkup | undefined;
}

/** Marks for inline string `i` of the block, when it has any. */
function marksAt(ctx: BlockContext, i: number): InlineMarks | undefined {
  const enh = ctx.enh;
  const ranges = enh?.kind === 'text' ? enh.parts[i] : undefined;
  return ranges?.length && ctx.merges ? { ranges, open: ctx.merges.open } : undefined;
}

/** A whole-block mark: attributes on the block's root element (a CSS rule draws the rule and tag). */
function markBlock(html: string, ctx: BlockContext): string {
  const enh = ctx.enh;
  if (!enh || enh.kind === 'text') return html;
  const extra = attrs([
    ['data-enh', enh.kind],
    ['data-merge', enh.merge],
    ['title', ctx.merges?.title(enh.merge)],
  ]);
  return html.replace(/^<([a-z][a-z0-9]*)/, (m) => m + extra);
}

const CALLOUT_LABELS = { note: 'Note', warning: 'Warning', keypoint: 'Key point' } as const;
const NUMERIC_CELL = /^[-−+]?[$€£¥]?\s?\(?[0-9][0-9,.]*\)?\s?(%|[kKmMbB]n?|x)?$/;

function anchorsOf(notes: readonly GlossaryNote[]): DfnAnchor[] {
  return notes.map((n) => ({ text: n.anchorText, noteId: n.id }));
}

/** `<details class="gl-note">` (07 §9.2). */
export function renderNote(n: GlossaryNote): string {
  return (
    `<details${attrs([
      ['class', 'gl-note'],
      ['id', n.id],
      ['data-note-for', `${n.id}-ref`],
    ])}>` +
    `<summary><span class="gl-icon" aria-hidden="true"></span><b>${esc(n.term)}</b>` +
    (n.expansion ? ` · ${esc(n.expansion)}` : '') +
    `</summary><p>${esc(n.explanation)}</p></details>`
  );
}

function renderTable(b: Extract<DocBlock, { type: 'table' }>): string {
  const numeric = b.header.map(
    (_, ci) =>
      b.rows.some((r) => (r[ci] ?? '').trim() !== '') &&
      b.rows.every((r) => (r[ci] ?? '').trim() === '' || NUMERIC_CELL.test((r[ci] ?? '').trim())),
  );
  const cls = (ci: number): string | undefined => (numeric[ci] ? 'num' : undefined);
  const head = b.header
    .map(
      (h, ci) =>
        `<th${attrs([
          ['scope', 'col'],
          ['class', cls(ci)],
        ])}>${renderInline(h)}</th>`,
    )
    .join('');
  const body = b.rows
    .map((r) => `<tr>${r.map((c, ci) => `<td${attrs([['class', cls(ci)]])}>${renderInline(c)}</td>`).join('')}</tr>`)
    .join('');
  return (
    // 07 §13: only tables of <= 30 rows get print break-inside: avoid.
    `<div class="${b.rows.length <= 30 ? 'table-wrap table-wrap--short' : 'table-wrap'}"><table>` +
    (b.caption ? `<caption>${esc(b.caption)}</caption>` : '') +
    `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
  );
}

function pct(v: number): number {
  const p = v <= 1 ? v * 100 : v;
  return Math.round(Math.max(0, Math.min(100, p)) * 100) / 100;
}

function renderFigure(b: Extract<DocBlock, { type: 'figure' }>, ctx: BlockContext): string {
  const ref = ctx.assetRefs.get(b.assetId);
  const bytes = ctx.assets.get(b.assetId);
  if (!ref || !bytes) {
    // Asset bytes missing (hand-edited file): keep the caption so the block stays readable.
    return `<figure class="annotated" data-asset-missing="${escAttr(b.assetId)}"><figcaption>${esc(b.caption)}</figcaption></figure>`;
  }
  const anns = b.annotations ?? [];
  const markers = anns
    .map(
      (a, i) =>
        `<a${attrs([
          ['class', 'fig-marker'],
          ['href', `#${ctx.idBase}-n${i + 1}`],
          ['style', `left:${pct(a.x)}%;top:${pct(a.y)}%`],
          ['aria-label', `Note ${i + 1}`],
        ])}>${i + 1}</a>`,
    )
    .join('');
  const notes = anns.length
    ? `<ol class="fig-notes">${anns.map((a, i) => `<li id="${ctx.idBase}-n${i + 1}">${esc(a.text)}</li>`).join('')}</ol>`
    : '';
  return (
    '<figure class="annotated"><div class="fig-media">' +
    `<img${attrs([
      ['src', toDataUri(ref.mime, bytes)],
      ['alt', b.alt || b.caption],
      ['width', ref.width],
      ['height', ref.height],
      ['data-asset-id', ref.id],
    ])}>` +
    markers +
    '</div>' +
    (b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : '') +
    notes +
    '</figure>'
  );
}

/** One block plus the glossary notes anchored in it (rendered right after the block, 07 §9.2). */
export function renderBlock(b: DocBlock, ctx: BlockContext): string {
  const anchors = anchorsOf(ctx.notes);
  let html: string;
  switch (b.type) {
    case 'paragraph':
      html = `<p>${renderInline(b.md, anchors, marksAt(ctx, 0))}</p>`;
      break;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const items = renderInlineMany(
        b.items,
        anchors,
        b.items.map((_, i) => marksAt(ctx, i)),
      ).html;
      html = `<${tag}>${items.map((i) => `<li>${i}</li>`).join('')}</${tag}>`;
      break;
    }
    case 'pullquote':
      html =
        `<figure class="pullquote"><blockquote><p>${esc(b.text)}</p></blockquote>` +
        (b.attribution ? `<figcaption>${esc(b.attribution)}</figcaption>` : '') +
        '</figure>';
      break;
    case 'callout':
      html =
        `<aside class="callout callout--${b.tone}"><p class="callout-label">${CALLOUT_LABELS[b.tone]}</p>` +
        `<p>${renderInline(b.md, anchors, marksAt(ctx, 0))}</p></aside>`;
      break;
    case 'analogy':
      html = `<aside class="analogy"><p class="analogy-label">Think of it like</p><p>${renderInline(b.md, anchors, marksAt(ctx, 0))}</p></aside>`;
      break;
    case 'table':
      html = renderTable(b);
      break;
    case 'chart':
      html = renderChartFigure(b.chart, ctx.idBase);
      break;
    case 'diagram':
      // svg was sanitized at build time (07 §7.3) and is stored sanitized in the model.
      html = `<figure class="diagram">${b.title ? `<h3 class="diagram-title">${esc(b.title)}</h3>` : ''}${b.svg}</figure>`;
      break;
    case 'figure':
      html = renderFigure(b, ctx);
      break;
    case 'stepper':
      html =
        `<div class="stepper">${b.title ? `<h3 class="stepper-title">${esc(b.title)}</h3>` : ''}<ol class="stepper-steps">` +
        b.steps
          .map(
            (s, i) =>
              `<li${attrs([
                ['class', 'step'],
                ['data-step', i + 1],
              ])}><p class="step-label">${esc(s.label)}</p><p>${renderInline(s.md, [], marksAt(ctx, i))}</p></li>`,
          )
          .join('') +
        '</ol></div>';
      break;
  }
  return markBlock(html, ctx) + ctx.notes.map(renderNote).join('');
}
