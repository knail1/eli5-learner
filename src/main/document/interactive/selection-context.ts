// "ELI5 this selection" grounding context (08 §7.5): the covered headings plus the block just before
// and just after the selection, from the embedded model. Grounding only; the prompt explains the selection.
import { sectionText, type DraftBlock } from '../../llm';
import { capText } from '../html';
import { sectionToDraft } from '../mutate';
import type { DocumentModel, Section, SectionId } from '../types';

/** Each excerpt in the context is cut to this many characters. */
export const SELECTION_CONTEXT_CHARS = 600;
/** Words of the selection's start and end used to locate it among the blocks. */
const PROBE_WORDS = 6;

/** Lowercase letters and digits only, single spaces: for locating the selection among blocks. */
const loose = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Block text for the prompt: Markdown emphasis and link targets dropped, one line. */
function plain(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const blockText = (b: DraftBlock): string => plain(sectionText({ heading: '', blocks: [b] }));

interface Located {
  blocks: string[];
  start: number;
  end: number;
}

/** Index of the first block whose text contains `probe`, or -1. */
function find(blocks: readonly string[], probe: string): number {
  if (probe === '') return -1;
  return blocks.findIndex((b) => loose(b).includes(probe));
}

function locate(model: DocumentModel, sections: readonly Section[], selection: string): Located | undefined {
  const blocks: string[] = [];
  for (const s of sections) {
    for (const b of sectionToDraft(model, s).blocks) {
      const t = blockText(b);
      if (t !== '') blocks.push(t);
    }
  }
  const words = loose(selection).split(' ');
  const head = words.slice(0, PROBE_WORDS).join(' ');
  const tail = words.slice(-PROBE_WORDS).join(' ');
  const start = find(blocks, head);
  if (start < 0) return undefined;
  const fromStart = blocks.slice(start);
  const offset = find(fromStart, tail);
  return { blocks, start, end: offset < 0 ? start : start + offset };
}

/**
 * 08 Ask: index in `section.blocks` of the block where the selection ENDS, so an answer box goes right
 * after the passage it was asked about. Answer boxes count (their answer text can be selected to ask a
 * follow-up). The start of the selection is found first and the end is searched from there; undefined
 * when the selection cannot be located (the caller then appends at the end of the section).
 */
export function blockIndexOfSelection(model: DocumentModel, section: Section, selection: string): number | undefined {
  const texts = section.blocks.map((b) => {
    if (b.type === 'qa') return loose(plain(b.paragraphs.join(' ')));
    const d = sectionToDraft(model, { ...section, blocks: [b] }).blocks[0];
    return d ? loose(blockText(d)) : '';
  });
  const words = loose(selection).split(' ');
  const head = words.slice(0, PROBE_WORDS).join(' ');
  const tail = words.slice(-PROBE_WORDS).join(' ');
  if (head === '') return undefined;
  const start = texts.findIndex((t) => t.includes(head));
  if (start < 0) {
    // The start may sit in text the model cannot see (a chart label); try the end alone.
    const end = texts.findIndex((t) => t.includes(tail));
    return end < 0 ? undefined : end;
  }
  if (texts[start]?.includes(loose(selection))) return start;
  // A selection across blocks: its last words may straddle a block boundary, so the end probe
  // shrinks until a later block holds it.
  for (let n = Math.min(PROBE_WORDS, words.length); n >= 2; n--) {
    const probe = words.slice(-n).join(' ');
    const end = texts.findIndex((t, i) => i > start && t.includes(probe));
    if (end >= 0) return end;
  }
  return start;
}

/**
 * 08 §7.5: `Section: …` (or `Sections: a; b`) plus `Just before the selection:` and `Just after the
 * selection:` blocks, each capped at SELECTION_CONTEXT_CHARS. When the selection cannot be found in
 * the model text (for example a chart label), the opening of the first section stands in.
 */
export function selectionContext(model: DocumentModel, sectionIds: readonly SectionId[], selection: string): string {
  const all = model.tabs.flatMap((t) => t.sections);
  const sections = sectionIds.map((id) => all.find((s) => s.id === id)).filter((s): s is Section => s !== undefined);
  if (sections.length === 0) return '';
  const headings = sections.map((s) => s.heading.trim()).filter((h) => h !== '');
  const lines = [headings.length > 1 ? `Sections: ${headings.join('; ')}` : `Section: ${headings[0] ?? ''}`];
  const cap = (s: string): string => capText(s, SELECTION_CONTEXT_CHARS);
  const hit = locate(model, sections, selection);
  if (!hit) {
    const first = sections[0];
    const opening = first
      ? sectionToDraft(model, first)
          .blocks.map(blockText)
          .find((t) => t !== '')
      : undefined;
    if (opening) lines.push('', 'Section opening:', cap(opening));
    return lines.join('\n');
  }
  const before = hit.blocks[hit.start - 1];
  const after = hit.blocks[hit.end + 1];
  if (before) lines.push('', 'Just before the selection:', cap(before));
  if (after) lines.push('', 'Just after the selection:', cap(after));
  return lines.join('\n');
}
