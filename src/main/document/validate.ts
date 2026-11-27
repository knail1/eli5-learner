// Block conversion and semantic validation (07 §5.2): DraftBlock -> DocBlock, user-question
// stripping, table/chart/diagram/stepper/animation limits.
import type { DraftBlock } from '../llm';
import {
  ANIMATION_KEEP,
  MAX_ANIMATIONS_PER_DOC,
  MAX_ANIMATIONS_PER_SECTION,
  MAX_ANIMATIONS_PER_TAB,
  MAX_ANIMATION_ALT,
  MAX_ANIMATION_CAPTION,
  MAX_ANIMATION_POSTER,
  MAX_ANIMATION_TITLE,
  animationCodeProblems,
} from './animation';
import { normalizeChart } from './charts';
import { capText, collapseWs, stripControls } from './html';
import { mintDiagramPrefix } from './ids';
import { inlineText } from './inline-md';
import type { IdSource } from './section-id';
import { sanitizeSvg } from './svg-sanitize';
import type { DocBlock } from './types';

export const MAX_TABLE_ROWS = 200;
export const MAX_DIAGRAM_BYTES = 100 * 1024;

const QUESTION_RE = /^(would you like|do you want|shall i|should i|let me know|can you (tell|clarify))\b[\s\S]*\?$/i;

/** A paragraph that asks the reader for input (07 §5.2; 06 clarifying-input rule). */
export function isUserQuestion(md: string): boolean {
  return QUESTION_RE.test(collapseWs(inlineText(md)));
}

export interface ConvertContext {
  idSource: IdSource;
  /** Figure image label -> asset id, or undefined when the label is unknown (07 §5.1 step 5). */
  resolveFigure(label: string): string | undefined;
  /**
   * Stock photo slot at `blockIndex` of the section -> its embedded asset (07 §7.4), or undefined
   * when the slot was not resolved. Absent (section rewrites): every photo slot is dropped.
   */
  resolvePhoto?(blockIndex: number): { assetId: string; alt: string; caption: string } | undefined;
  warn(w: string): void;
  /** The section heading: a chart with a blank title takes it (07 §5.2). */
  heading?: string;
  /**
   * The heading a blank-titled chart at `blockIndex` takes instead of `heading`: the ASD-STE100
   * tab passes the In depth heading of a kept chart's origin, so the mirror stays identical to its
   * original (D15). Undefined: `heading`.
   */
  chartHeading?(blockIndex: number): string | undefined;
  /**
   * Animation caps beyond one section (07 §5.2: two per tab, four per document). Called once per
   * animation that passed every other check; false drops it. `force` is true for a block that
   * resolved through the keep marker: kept blocks always stay (07 §5.2) and are only counted.
   * Absent: only the per-section cap.
   */
  takeAnimation?(force?: boolean): boolean;
  /**
   * A regenerated section's own animation, for a draft block whose `poster` and `js` are the keep
   * marker (08 §6.2, ANIMATION_KEEP). Each call returns the next one not yet taken. Absent: the
   * marker is dropped.
   */
  keepAnimation?(): AnimationDocBlock | undefined;
}

type AnimationDocBlock = Extract<DocBlock, { type: 'animation' }>;

const SVG_ID_PREFIX_RE = /\bid="(d[0-9a-f]{8}-)/;

/** The id prefix a sanitized diagram or poster SVG carries (07 §7.3), if it has any ids. */
export function svgIdPrefix(svg: string): string | undefined {
  return SVG_ID_PREFIX_RE.exec(svg)?.[1];
}

export const MAX_PHOTO_CAPTION = 200;

/**
 * Tab and document animation caps as a ConvertContext.takeAnimation: `docUsed` and `tabUsed`
 * count animations already kept elsewhere (a counter object lets the caller release a revised
 * section's animations). `force` counts a kept block without checking the caps.
 */
export function animationBudget(
  docUsed: { n: number },
  tabUsed: { n: number } | number = 0,
): (force?: boolean) => boolean {
  const tab = typeof tabUsed === 'number' ? { n: tabUsed } : tabUsed;
  return (force = false) => {
    if (!force && (tab.n >= MAX_ANIMATIONS_PER_TAB || docUsed.n >= MAX_ANIMATIONS_PER_DOC)) return false;
    tab.n++;
    docUsed.n++;
    return true;
  };
}

/** Number of animation blocks in `blocks`. */
export function countAnimations(blocks: readonly { type: string }[]): number {
  return blocks.filter((b) => b.type === 'animation').length;
}

/**
 * Animations counted against the document cap (07 §5.2): every tab except the ASD-STE100 and
 * Deadpan tabs, whose animations only mirror in-depth ones that already count.
 */
export function countDocAnimations(
  tabs: readonly { kind: string; sections: readonly { blocks: readonly { type: string }[] }[] }[],
): number {
  return tabs.reduce(
    (n, t) =>
      t.kind === 'ste' || t.kind === 'deadpan' ? n : n + t.sections.reduce((k, s) => k + countAnimations(s.blocks), 0),
    0,
  );
}

/**
 * The checks an animation must pass to be kept (07 §5.2): a title, an alt text, a poster that
 * survives the diagram sanitizer, and code within the caps that passes the lint (`stored`: code
 * already saved skips the lint, see animationCodeProblems). Returns the
 * stored block, or null. `posterPrefix` keeps an already sanitized poster byte-identical (parse).
 */
export function checkAnimation(
  b: Omit<AnimationDocBlock, 'type'>,
  posterPrefix: string,
  opts: { stored?: boolean } = {},
): AnimationDocBlock | null {
  const title = capText(collapseWs(b.title), MAX_ANIMATION_TITLE);
  const alt = capText(collapseWs(b.alt), MAX_ANIMATION_ALT);
  const caption = capText(collapseWs(b.caption), MAX_ANIMATION_CAPTION);
  if (!title || !alt) return null;
  const poster = sanitizeSvg(b.poster, {
    idPrefix: posterPrefix,
    ariaLabel: alt,
    rootClass: 'anim-poster-svg',
    labelContrast: true,
  });
  if (poster === null || poster.length > MAX_ANIMATION_POSTER) return null;
  // Control characters would be stripped by attribute escaping, so the frame's script would no
  // longer match its hash: normalize them here, once.
  const code = (s: string | undefined): string | undefined => {
    const v = s === undefined ? '' : stripControls(s);
    return v.trim() === '' ? undefined : v;
  };
  const js = code(b.js) ?? '';
  const html = code(b.html);
  const css = code(b.css);
  if (animationCodeProblems({ js, html, css }, { lint: opts.stored !== true }).length > 0) return null;
  return {
    type: 'animation',
    title,
    caption,
    alt,
    poster,
    ...(html !== undefined ? { html } : {}),
    ...(css !== undefined ? { css } : {}),
    js,
  };
}

export const MAX_PHOTO_ALT = 300;

/** Converts one draft block; null drops it. */
export function convertBlock(b: DraftBlock, ctx: ConvertContext, blockIndex = -1): DocBlock | null {
  switch (b.type) {
    case 'paragraph': {
      if (collapseWs(b.md) === '') return null;
      if (isUserQuestion(b.md)) {
        ctx.warn('user-question-dropped');
        return null;
      }
      return { type: 'paragraph', md: b.md.trim() };
    }
    case 'list': {
      const items = b.items.map((i) => i.trim()).filter((i) => i !== '');
      return items.length ? { type: 'list', ordered: b.ordered, items } : null;
    }
    case 'pullquote': {
      const text = collapseWs(b.text);
      if (!text) return null;
      const attribution = b.attribution ? collapseWs(b.attribution) : '';
      return { type: 'pullquote', text, ...(attribution ? { attribution } : {}) };
    }
    case 'callout':
      return collapseWs(b.md) ? { type: 'callout', tone: b.tone, md: b.md.trim() } : null;
    case 'analogy':
      return collapseWs(b.md) ? { type: 'analogy', md: b.md.trim() } : null;
    case 'table': {
      const width = b.header.length;
      if (width === 0) return null;
      let rows = b.rows.map((r) => {
        if (r.length === width) return r;
        ctx.warn('table-row-width');
        return r.length > width ? r.slice(0, width) : [...r, ...Array<string>(width - r.length).fill('')];
      });
      let caption = b.caption?.trim();
      if (rows.length > MAX_TABLE_ROWS) {
        rows = rows.slice(0, MAX_TABLE_ROWS);
        caption = `${caption ? `${caption} ` : ''}(first ${MAX_TABLE_ROWS} rows)`;
        ctx.warn('table-truncated');
      }
      return { type: 'table', ...(caption ? { caption } : {}), header: b.header, rows };
    }
    case 'chart': {
      // Wong rules (07 §5.2): normalized quietly; a chart with no plottable series becomes a table.
      const heading = (blockIndex >= 0 ? ctx.chartHeading?.(blockIndex) : undefined) ?? ctx.heading;
      const chart = normalizeChart(b.chart, ctx.warn, heading === undefined ? {} : { heading });
      if (chart === null) return null;
      return 'table' in chart ? { type: 'table', ...chart.table } : { type: 'chart', chart };
    }
    case 'diagram': {
      const title = collapseWs(b.title);
      const alt = collapseWs(b.alt) || title;
      const svg = sanitizeSvg(b.svg, {
        idPrefix: mintDiagramPrefix(ctx.idSource),
        ariaLabel: alt,
        rootClass: 'diagram-svg',
        labelContrast: true,
      });
      if (svg === null || svg.length > MAX_DIAGRAM_BYTES) {
        ctx.warn('diagram-dropped');
        return null;
      }
      return { type: 'diagram', title, svg, alt };
    }
    case 'figure': {
      const assetId = ctx.resolveFigure(b.imageLabel);
      if (!assetId) {
        ctx.warn('figure-image-missing');
        return null;
      }
      const caption = collapseWs(b.caption);
      const annotations = (b.annotations ?? [])
        .filter((a) => Number.isFinite(a.x) && Number.isFinite(a.y) && collapseWs(a.text) !== '')
        .map((a) => ({ x: a.x, y: a.y, text: collapseWs(a.text) }));
      return {
        type: 'figure',
        assetId,
        caption,
        alt: caption,
        ...(annotations.length ? { annotations } : {}),
      };
    }
    case 'photo': {
      const r = blockIndex >= 0 ? ctx.resolvePhoto?.(blockIndex) : undefined;
      if (!r) {
        ctx.warn('photo-unresolved');
        return null;
      }
      const caption = capText(collapseWs(r.caption), MAX_PHOTO_CAPTION);
      const alt = capText(collapseWs(r.alt), MAX_PHOTO_ALT) || caption;
      return { type: 'figure', assetId: r.assetId, caption, alt };
    }
    case 'animation': {
      // 07 §5.2: a keep marker resolves to the section's existing animation (new text allowed);
      // anything else must pass every check, or it is dropped (never a repair).
      if (b.js === ANIMATION_KEEP && b.poster === ANIMATION_KEEP) {
        const old = ctx.keepAnimation?.();
        if (!old) {
          ctx.warn('animation-dropped');
          return null;
        }
        const title = capText(collapseWs(b.title), MAX_ANIMATION_TITLE) || old.title;
        const caption = capText(collapseWs(b.caption), MAX_ANIMATION_CAPTION) || old.caption;
        const alt = capText(collapseWs(b.alt), MAX_ANIMATION_ALT) || old.alt;
        // The kept code was linted when it was written (stored: no re-lint, audit round 3).
        const again = checkAnimation(
          { ...old, title, caption, alt },
          svgIdPrefix(old.poster) ?? mintDiagramPrefix(ctx.idSource),
          { stored: true },
        );
        if (!again) ctx.warn('animation-dropped');
        return again;
      }
      const kept = checkAnimation(b, mintDiagramPrefix(ctx.idSource));
      if (!kept) ctx.warn('animation-dropped');
      return kept;
    }
    case 'stepper': {
      const steps = b.steps.filter((s) => collapseWs(s.label) !== '' || collapseWs(s.md) !== '');
      if (steps.length < 2) {
        const items = steps.map((s) =>
          collapseWs(s.label) ? `**${collapseWs(s.label)}:** ${s.md.trim()}` : s.md.trim(),
        );
        return items.length ? { type: 'list', ordered: true, items } : null;
      }
      return {
        type: 'stepper',
        title: collapseWs(b.title),
        steps: steps.map((s) => ({ label: collapseWs(s.label), md: s.md.trim() })),
      };
    }
  }
}

export function convertBlocks(blocks: readonly DraftBlock[], ctx: ConvertContext): DocBlock[] {
  const out: DocBlock[] = [];
  let animations = 0;
  for (const [i, b] of blocks.entries()) {
    const c = convertBlock(b, ctx, i);
    if (!c) continue;
    if (c.type === 'animation') {
      const kept = b.type === 'animation' && b.js === ANIMATION_KEEP && b.poster === ANIMATION_KEEP;
      if (animations >= MAX_ANIMATIONS_PER_SECTION || (ctx.takeAnimation && !ctx.takeAnimation(kept))) {
        ctx.warn('animation-dropped');
        continue;
      }
      animations++;
    }
    out.push(c);
  }
  return out;
}
