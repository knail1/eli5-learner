// Block renderers (07 §7.1) and glossary note markup (07 §9.2).
import { renderChartFigure } from '../charts';
import { attrs, esc, escAttr } from '../html';
import { toDataUri } from '../images';
import { renderInline, renderInlineMany, type DfnAnchor, type InlineMarks } from '../inline-md';
import { creditHtml } from './credit';
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

/** Marker diameter bounds (px) and the share of the image's short side it may take (07 §7.1). */
const MARKER_MAX = 24;
const MARKER_MIN = 18;
const MARKER_SHARE = 0.45;
/** Widest the image is shown in the text column; markers are laid out at this size or smaller. */
const COLUMN_PX = 680;

export interface MarkerLayout {
  /** Marker diameter in px. */
  size: number;
  /** Centers in percent of the image box, in annotation order. */
  points: { left: number; top: number }[];
}

/**
 * Annotation marker layout (07 §7.1 figure): the diameter scales with the shown image (24 px, down
 * to 18 px on small images), centers stay inside the image, and markers that would overlap are
 * pushed apart deterministically, in order, each moving away from the earlier one it hits.
 */
export function layoutMarkers(anns: readonly { x: number; y: number }[], imgW: number, imgH: number): MarkerLayout {
  const scale = imgW > COLUMN_PX ? COLUMN_PX / imgW : 1;
  const w = Math.max(1, imgW * scale);
  const h = Math.max(1, imgH * scale);
  const size = Math.round(Math.max(MARKER_MIN, Math.min(MARKER_MAX, Math.min(w, h) * MARKER_SHARE)));
  const half = size / 2;
  const clampX = (x: number): number => (w <= size ? w / 2 : Math.min(w - half, Math.max(half, x)));
  const clampY = (y: number): number => (h <= size ? h / 2 : Math.min(h - half, Math.max(half, y)));
  const gap = size + 2; // centers at least a diameter plus the 2 px paper ring apart
  const placed: { x: number; y: number }[] = [];
  for (const a of anns) {
    let x = clampX((pct(a.x) / 100) * w);
    let y = clampY((pct(a.y) / 100) * h);
    for (let round = 0; round < 8; round++) {
      const hit = placed.find((p) => Math.hypot(p.x - x, p.y - y) < gap - 0.01);
      if (!hit) break;
      const dx = x - hit.x;
      const dy = y - hit.y;
      const d = Math.hypot(dx, dy);
      // Coincident centers move right (then down once the edge is reached).
      const [ux, uy] = d < 0.01 ? (hit.x + gap <= w - half ? [1, 0] : [0, 1]) : [dx / d, dy / d];
      x = clampX(hit.x + ux * gap);
      y = clampY(hit.y + uy * gap);
    }
    placed.push({ x, y });
  }
  const r = (v: number): number => Math.round(v * 100) / 100;
  return { size, points: placed.map((p) => ({ left: r((p.x / w) * 100), top: r((p.y / h) * 100) })) };
}

function renderFigure(b: Extract<DocBlock, { type: 'figure' }>, ctx: BlockContext): string {
  const ref = ctx.assetRefs.get(b.assetId);
  const bytes = ctx.assets.get(b.assetId);
  if (!ref || !bytes) {
    // Asset bytes missing (hand-edited file): keep the caption so the block stays readable.
    return `<figure class="annotated" data-asset-missing="${escAttr(b.assetId)}"><figcaption>${esc(b.caption)}</figcaption></figure>`;
  }
  const anns = b.annotations ?? [];
  const layout = layoutMarkers(anns, ref.width, ref.height);
  const markers = anns
    .map((_, i) => {
      const p = layout.points[i] ?? { left: 0, top: 0 };
      const size = layout.size === MARKER_MAX ? '' : `;--fm:${layout.size}px`;
      return `<a${attrs([
        ['class', 'fig-marker'],
        ['href', `#${ctx.idBase}-n${i + 1}`],
        ['style', `left:${p.left}%;top:${p.top}%${size}`],
        ['aria-label', `Note ${i + 1}`],
      ])}>${i + 1}</a>`;
    })
    .join('');
  const notes = anns.length
    ? `<ol class="fig-notes">${anns.map((a, i) => `<li id="${ctx.idBase}-n${i + 1}">${esc(a.text)}</li>`).join('')}</ol>`
    : '';
  // 07 §7.4: a stock photo always carries its credit in the caption.
  const credit = ref.credit ? `<span class="fig-credit">${creditHtml(ref.credit)}</span>` : '';
  const caption = b.caption ? esc(b.caption) : '';
  return (
    `<figure class="${ref.credit ? 'annotated stock-photo' : 'annotated'}"><div class="fig-media">` +
    `<img${attrs([
      ['src', toDataUri(ref.mime, bytes)],
      ['alt', b.alt || b.caption],
      ['width', ref.width],
      ['height', ref.height],
      ['data-asset-id', ref.id],
    ])}>` +
    markers +
    '</div>' +
    (caption || credit ? `<figcaption>${caption}${caption && credit ? ' ' : ''}${credit}</figcaption>` : '') +
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
