// Glossary anchor resolution and placement (07 §9.1) and re-anchoring after regeneration (07 §9.3,
// 08 §6.5). In-depth tab only.
import type { GlossaryDraft } from '../llm';
import { capText, collapseWs } from './html';
import { parseInline, textRuns } from './inline-md';
import { mintNoteId } from './ids';
import type { IdSource, TakenIds } from './section-id';
import type { DocBlock, GlossaryNote, Section } from './types';

export const MAX_GLOSSARY_NOTES = 40;
export const MAX_EXPLANATION = 400;

/** Inline strings of a text-bearing block, in order (07 §9.1 step 3); [] for other blocks. */
export function blockTexts(b: DocBlock): string[] {
  switch (b.type) {
    case 'paragraph':
    case 'callout':
    case 'analogy':
      return [b.md];
    case 'list':
      return b.items;
    default:
      return [];
  }
}

interface Hit {
  blockIndex: number;
  verbatim: string;
  /** Sort key within the section: [blockIndex, string index, run index, offset]. */
  key: [number, number, number, number];
}

type Mode = 'exact' | 'ci' | 'ws';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matcher(anchor: string, mode: Mode): RegExp {
  if (mode === 'exact') return new RegExp(escapeRe(anchor), 'g');
  if (mode === 'ci') return new RegExp(escapeRe(anchor), 'gi');
  const words = collapseWs(anchor).split(' ').map(escapeRe);
  return new RegExp(words.join('\\s+'), 'gi');
}

type Occupied = { blockIndex: number; si: number; ri: number; start: number; end: number }[];

function findInBlocks(
  blocks: readonly DocBlock[],
  anchor: string,
  occupied: Occupied,
): (Hit & { end: number }) | undefined {
  if (collapseWs(anchor) === '') return undefined;
  for (const mode of ['exact', 'ci', 'ws'] as const) {
    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi];
      if (!block) continue;
      const texts = blockTexts(block);
      for (let si = 0; si < texts.length; si++) {
        const runs = textRuns(parseInline(texts[si] ?? ''));
        for (let ri = 0; ri < runs.length; ri++) {
          const re = matcher(anchor, mode);
          const s = runs[ri]?.s ?? '';
          let m: RegExpExecArray | null;
          while ((m = re.exec(s)) !== null) {
            const start = m.index;
            const end = start + m[0].length;
            if (m[0].length === 0) break;
            const clash = occupied.some(
              (o) => o.blockIndex === bi && o.si === si && o.ri === ri && start < o.end && end > o.start,
            );
            if (!clash) return { blockIndex: bi, verbatim: m[0], key: [bi, si, ri, start], end };
          }
        }
      }
    }
  }
  return undefined;
}

export interface PlaceGlossaryInput {
  draft: GlossaryDraft | null;
  /** In-depth content sections in order. */
  sections: readonly Section[];
  /**
   * Draft index of each kept section (buildSections drops empty ones and caps the count), so
   * anchorSectionIndex, which indexes the draft, maps correctly. Default: identity.
   */
  draftIndices?: readonly number[];
  /** Number of draft sections, for the step 2 range check. Default: sections.length. */
  draftSectionCount?: number;
  idSource: IdSource;
  /** Every id already used in the document (section ids and more). */
  taken: TakenIds;
}

interface Placed {
  note: GlossaryNote;
  order: number[];
}

/** 07 §9.1: returns notes sorted in document order. */
export function placeGlossary(input: PlaceGlossaryInput, warn: (w: string) => void): GlossaryNote[] {
  if (!input.draft) return [];
  const seen = new Set<string>();
  const placed: Placed[] = [];
  const occupiedBySection = new Map<number, Occupied>();
  const noteIds = new Set<string>();
  const taken: TakenIds = { has: (id) => noteIds.has(id) || input.taken.has(id) };
  for (const entry of input.draft.entries) {
    const term = collapseWs(entry.term);
    const explanation = collapseWs(entry.explanation);
    if (term === '' || explanation === '') continue; // step 1
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const draftCount = input.draftSectionCount ?? input.sections.length;
    const draftIdx = (k: number): number => input.draftIndices?.[k] ?? k;
    if (entry.anchorSectionIndex < 0 || entry.anchorSectionIndex >= draftCount) {
      warn('glossary-anchor-missing'); // step 2: out of range
      continue;
    }
    // Step 2: the kept section for that draft index (or the next kept one if it was dropped).
    let start = input.sections.length;
    for (let k = 0; k < input.sections.length; k++) {
      if (draftIdx(k) >= entry.anchorSectionIndex) {
        start = k;
        break;
      }
    }
    const search = (from: number, to: number): (Hit & { end: number; si: number }) | undefined => {
      for (let s = from; s < to; s++) {
        const h = findInBlocks(input.sections[s]?.blocks ?? [], entry.anchorText, occupiedBySection.get(s) ?? []);
        if (h) return { ...h, si: s };
      }
      return undefined;
    };
    // Steps 3-4: that section, then the following ones; not found there means dropped.
    let hit = search(start, input.sections.length);
    if (!hit) {
      warn('glossary-anchor-missing');
      continue;
    }
    // Step 5: move to an earlier occurrence ("where it first appears").
    hit = search(0, hit.si) ?? hit;
    const section = input.sections[hit.si];
    if (!section) continue;
    const occ = occupiedBySection.get(hit.si) ?? [];
    occ.push({ blockIndex: hit.blockIndex, si: hit.key[1], ri: hit.key[2], start: hit.key[3], end: hit.end });
    occupiedBySection.set(hit.si, occ);
    const id = mintNoteId(input.idSource, taken);
    noteIds.add(id);
    const expansion = entry.expansion ? collapseWs(entry.expansion) : '';
    placed.push({
      note: {
        id,
        term,
        ...(expansion ? { expansion } : {}),
        explanation: capText(explanation, MAX_EXPLANATION),
        sectionId: section.id,
        blockIndex: hit.blockIndex,
        anchorText: hit.verbatim,
      },
      order: [hit.si, ...hit.key],
    });
  }
  placed.sort((a, b) => compareOrder(a.order, b.order));
  if (placed.length > MAX_GLOSSARY_NOTES) warn('glossary-capped');
  return placed.slice(0, MAX_GLOSSARY_NOTES).map((p) => p.note);
}

function compareOrder(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 07 §9.3 as constrained by 08 §6.5: notes of the replaced section are re-anchored inside its new
 * blocks and dropped (warning 'glossary-dropped') when their anchor no longer appears. Notes are
 * never moved to other sections, so no other section's bytes change (07 §5.5).
 */
export function reanchorSection(
  glossary: readonly GlossaryNote[],
  section: Section,
  sectionOrder: readonly string[],
  warn: (w: string) => void,
): GlossaryNote[] {
  const occ: Occupied = [];
  const keys = new Map<string, number[]>();
  const out: GlossaryNote[] = [];
  for (const n of glossary) {
    if (n.sectionId !== section.id) {
      out.push(n);
      continue;
    }
    const hit = findInBlocks(section.blocks, n.anchorText, occ) ?? findInBlocks(section.blocks, n.term, occ);
    if (!hit) {
      warn('glossary-dropped');
      continue;
    }
    occ.push({ blockIndex: hit.blockIndex, si: hit.key[1], ri: hit.key[2], start: hit.key[3], end: hit.end });
    keys.set(n.id, hit.key);
    out.push({ ...n, blockIndex: hit.blockIndex, anchorText: hit.verbatim });
  }
  // Stable document order: section order, then position inside the replaced section.
  const idx = (n: GlossaryNote): number => sectionOrder.indexOf(n.sectionId);
  return out
    .map((n, i) => ({ n, i }))
    .sort((a, b) => {
      const d = idx(a.n) - idx(b.n);
      if (d !== 0) return d;
      const ka = keys.get(a.n.id);
      const kb = keys.get(b.n.id);
      if (ka && kb) return compareOrder(ka, kb);
      return a.i - b.i;
    })
    .map((x) => x.n);
}
