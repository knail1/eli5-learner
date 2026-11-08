// Block conversion and semantic validation (07 §5.2): DraftBlock -> DocBlock, user-question
// stripping, table/chart/diagram/stepper/explorable limits.
import { clampSim } from '../../shared/explorable';
import type { DraftBlock } from '../llm';
import { normalizeChart } from './charts';
import { capText, collapseWs } from './html';
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
  /**
   * Explorable caps beyond one section (07 §5.2: two per tab, four per document). Called once per
   * explorable that passed every other check; false drops it. Absent: only the per-section cap.
   */
  takeExplorable?(): boolean;
}

export const MAX_PHOTO_CAPTION = 200;

/** Explorable limits (07 §5.2). */
export const MAX_EXPLORABLE_TITLE = 90;
export const MAX_EXPLORABLE_CAPTION = 300;
export const MAX_EXPLORABLE_ALT = 400;
export const MAX_EXPLORABLES_PER_SECTION = 1;
export const MAX_EXPLORABLES_PER_TAB = 2;
export const MAX_EXPLORABLES_PER_DOC = 4;
/** Canonical JSON of the clamped parameters (the data-params attribute). */
export const MAX_EXPLORABLE_PARAMS = 1536;

/**
 * Tab and document explorable caps as a ConvertContext.takeExplorable: `docUsed` and `tabUsed`
 * count explorables already kept elsewhere (a counter object lets the caller release a revised
 * section's explorables). `force` counts a kept block without checking the caps.
 */
export function explorableBudget(
  docUsed: { n: number },
  tabUsed: { n: number } | number = 0,
): (force?: boolean) => boolean {
  const tab = typeof tabUsed === 'number' ? { n: tabUsed } : tabUsed;
  return (force = false) => {
    if (!force && (tab.n >= MAX_EXPLORABLES_PER_TAB || docUsed.n >= MAX_EXPLORABLES_PER_DOC)) return false;
    tab.n++;
    docUsed.n++;
    return true;
  };
}

/** Number of explorable blocks in `blocks`. */
export function countExplorables(blocks: readonly { type: string }[]): number {
  return blocks.filter((b) => b.type === 'explorable').length;
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
      const chart = normalizeChart(b.chart, ctx.warn);
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
    case 'explorable': {
      // 07 §5.2: every number clamped into its range; text capped; an unusable one is dropped.
      const sim = clampSim(b.sim);
      const title = capText(collapseWs(b.title), MAX_EXPLORABLE_TITLE);
      if (!sim || !title || JSON.stringify(sim).length > MAX_EXPLORABLE_PARAMS) {
        ctx.warn('explorable-dropped');
        return null;
      }
      const caption = capText(collapseWs(b.caption), MAX_EXPLORABLE_CAPTION);
      const alt = capText(collapseWs(b.alt), MAX_EXPLORABLE_ALT) || title;
      return { type: 'explorable', title, caption, alt, sim };
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
  let explorables = 0;
  for (const [i, b] of blocks.entries()) {
    const c = convertBlock(b, ctx, i);
    if (!c) continue;
    if (c.type === 'explorable') {
      if (explorables >= MAX_EXPLORABLES_PER_SECTION || (ctx.takeExplorable && !ctx.takeExplorable())) {
        ctx.warn('explorable-dropped');
        continue;
      }
      explorables++;
    }
    out.push(c);
  }
  return out;
}
