import type { DocumentDraftTab, DraftBlock, SectionDraft, SteBlock, SteDraft } from './schemas/draft';
import { splitSentences } from './lint/sentences';

/**
 * ASD-STE100 tab helpers (02 §12, D15): how the `ste` prompt sees the In depth draft, and how its
 * SteDraft becomes a DocumentDraftTab whose visuals are the In depth ones, byte for byte.
 */

/** In depth blocks the STE tab reuses through `{"type":"keep","block":N}` and never rewrites. */
export const KEEPABLE_TYPES: ReadonlySet<DraftBlock['type']> = new Set([
  'chart',
  'diagram',
  'animation',
  'photo',
  'figure',
  'table',
]);

export function isKeepable(b: DraftBlock): boolean {
  return KEEPABLE_TYPES.has(b.type);
}

/** Where a kept STE block came from: the in-depth draft's section and block index (07 §5 KeepOrigin). */
export interface SteOrigin {
  section: number;
  block: number;
}

export interface ResolvedSte {
  tab: DocumentDraftTab;
  /** One entry per block of `tab`: the In depth origin of a kept visual, null for STE text. */
  origins: (SteOrigin | null)[][];
  /** What resolution changed: dropped keeps and inserted visuals (for the log and tests). */
  fixes: string[];
}

export class SteResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SteResolveError';
  }
}

/**
 * The In depth draft as the `ste` prompt receives it (D15): JSON, every block numbered per section.
 * Text blocks are given in full; visuals carry only what the STE text may refer to (titles, alt
 * text, table cells), never SVG markup or animation code.
 */
export function steInputJson(indepth: DocumentDraftTab): string {
  const view = (b: DraftBlock, n: number): Record<string, unknown> => {
    switch (b.type) {
      case 'chart':
        return {
          block: n,
          type: 'chart',
          title: b.chart.title,
          ...(b.chart.subtitle ? { subtitle: b.chart.subtitle } : {}),
        };
      case 'diagram':
        return { block: n, type: 'diagram', title: b.title, alt: b.alt };
      case 'animation':
        return { block: n, type: 'animation', title: b.title, caption: b.caption };
      case 'photo':
        return { block: n, type: 'photo', alt: b.alt };
      case 'figure':
        return { block: n, type: 'figure', caption: b.caption };
      default:
        return { block: n, ...b };
    }
  };
  return JSON.stringify({
    title: indepth.title,
    ...(indepth.dek ? { dek: indepth.dek } : {}),
    sections: indepth.sections.map((s) => ({ heading: s.heading, blocks: s.blocks.map(view) })),
  });
}

/**
 * SteDraft -> STE tab (D15). The section count must equal In depth's (else SteResolveError: the
 * caller already asked for one repair, so the tab is omitted). In each section, keeps that are out
 * of range, point at a text block or repeat an earlier keep are dropped; every In depth visual of the
 * section that is not kept is inserted after the nearest preceding kept visual (or at its own index
 * when none precedes it), so the tab always carries every visual exactly once.
 */
export function resolveSte(indepth: DocumentDraftTab, ste: SteDraft): ResolvedSte {
  if (ste.sections.length !== indepth.sections.length) {
    throw new SteResolveError(`section count ${ste.sections.length} != ${indepth.sections.length}`);
  }
  const fixes: string[] = [];
  const sections: SectionDraft[] = [];
  const origins: (SteOrigin | null)[][] = [];
  ste.sections.forEach((sec, si) => {
    const src = indepth.sections[si];
    if (!src) throw new SteResolveError(`section ${si} missing`);
    const items: { block: DraftBlock; origin: SteOrigin | null }[] = [];
    const kept = new Set<number>();
    sec.blocks.forEach((b: SteBlock, bi) => {
      if (b.type !== 'keep') {
        items.push({ block: b, origin: null });
        return;
      }
      const target = src.blocks[b.block];
      if (!target || !isKeepable(target) || kept.has(b.block)) {
        fixes.push(`sections[${si}].blocks[${bi}]: dropped keep ${b.block}`);
        return;
      }
      kept.add(b.block);
      items.push({ block: structuredClone(target), origin: { section: si, block: b.block } });
    });
    src.blocks.forEach((b, n) => {
      if (!isKeepable(b) || kept.has(n)) return;
      // After the nearest preceding kept visual; else at the block's own index, but never after a
      // kept visual that comes later in In depth (so visuals stay in their original order).
      let at = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        const o = items[i]?.origin;
        if (o && o.block < n) {
          at = i + 1;
          break;
        }
      }
      if (at < 0) {
        const later = items.findIndex((x) => x.origin !== null && x.origin.block > n);
        at = Math.min(n, items.length, later < 0 ? items.length : later);
      }
      items.splice(at, 0, { block: structuredClone(b), origin: { section: si, block: n } });
      kept.add(n);
      fixes.push(`sections[${si}]: inserted visual ${n}`);
    });
    if (items.length === 0) throw new SteResolveError(`section ${si} is empty`);
    sections.push({ heading: sec.heading, blocks: items.map((x) => x.block) });
    origins.push(items.map((x) => x.origin));
  });
  return {
    tab: { kind: 'ste', title: ste.title, ...(ste.dek ? { dek: ste.dek } : {}), sections },
    origins,
    fixes,
  };
}

/**
 * The In depth outline the ELI5 critique fact-checks against (D17): each heading, the section's
 * first sentence, and every sentence that contains a number.
 */
export function indepthOutline(indepth: DocumentDraftTab): string {
  const lines: string[] = [];
  indepth.sections.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.heading}`);
    const sentences = s.blocks.flatMap((b) => {
      switch (b.type) {
        case 'paragraph':
        case 'callout':
        case 'analogy':
          return splitSentences(b.md);
        case 'list':
          return b.items.flatMap(splitSentences);
        case 'stepper':
          return b.steps.flatMap((st) => splitSentences(st.md));
        case 'pullquote':
          return splitSentences(b.text);
        case 'chart':
          return [b.chart.title];
        case 'table':
          return [b.caption ?? '', ...b.rows.map((r) => r.join(' | '))].filter(Boolean);
        default:
          return [];
      }
    });
    const picked = sentences.filter((x, k) => k === 0 || /\d/.test(x));
    for (const x of new Set(picked)) lines.push(`   - ${x}`);
  });
  return lines.join('\n');
}

/**
 * The keep marker of an animation the critique sees but must not rewrite (08 §6.2, 07 ANIMATION_KEEP),
 * numbered per animation in document order (`keep:0`, `keep:1`, ...) so a revision that moves or
 * reorders sections restores each animation's own code under its own title and caption.
 */
export const ANIMATION_KEEP_MARKER = 'keep';

export function animationKeepMarker(i: number): string {
  return `${ANIMATION_KEEP_MARKER}:${i}`;
}

function keepIndex(v: string): number | null {
  const m = /^keep:(\d+)$/.exec(v.trim());
  return m ? Number(m[1]) : null;
}

type AnimationDraft = Extract<DraftBlock, { type: 'animation' }>;

function mapBlocks(tab: DocumentDraftTab, f: (b: DraftBlock) => DraftBlock | null): DocumentDraftTab {
  return {
    ...tab,
    sections: tab.sections.map((s) => ({
      ...s,
      blocks: s.blocks.flatMap((b) => {
        const out = f(b);
        return out ? [out] : [];
      }),
    })),
  };
}

/**
 * The ELI5 draft as the critique sees it (D17): each animation's code and poster become its numbered
 * keep marker, so the editor may improve its words but never sees or rewrites its code.
 */
export function critiqueInput(eli5: DocumentDraftTab): DocumentDraftTab {
  let i = 0;
  return mapBlocks(eli5, (b) => {
    if (b.type !== 'animation') return b;
    const marker = animationKeepMarker(i++);
    return { type: 'animation', title: b.title, caption: b.caption, alt: b.alt, poster: marker, js: marker };
  });
}

/**
 * The critique's revision with the draft's animations restored (D17): each numbered keep marker takes
 * that animation of the draft, with the revised title, caption and alt (blank ones keep the draft's).
 * Unknown or repeated markers and animations with new code are dropped: the critique never adds code.
 * A dropped original fails the accept gate ('media').
 */
export function restoreAnimations(revised: DocumentDraftTab, eli5: DocumentDraftTab): DocumentDraftTab {
  const originals: AnimationDraft[] = eli5.sections.flatMap((s) =>
    s.blocks.filter((b): b is AnimationDraft => b.type === 'animation'),
  );
  const used = new Set<number>();
  return mapBlocks(revised, (b) => {
    if (b.type !== 'animation') return b;
    const n = keepIndex(b.js);
    if (n === null || keepIndex(b.poster) !== n || used.has(n)) return null;
    const old = originals[n];
    if (!old) return null;
    used.add(n);
    return {
      ...old,
      title: b.title.trim() || old.title,
      caption: b.caption.trim() || old.caption,
      alt: b.alt.trim() || old.alt,
    };
  });
}
