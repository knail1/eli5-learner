// Non-section identifiers minted by the builder: glossary note ids (07 §3), answer box ids (07 §7.1)
// and diagram id prefixes (07 §7.3). SectionIds and tab keys live in section-id.ts.
import { mintWithPrefix, type IdSource, type TakenIds } from './section-id';
import type { Tab } from './types';

/** 'g-' + 6 hex (07 §3 GlossaryNote.id). */
export function mintNoteId(src: IdSource, taken: TakenIds): string {
  return mintWithPrefix('g-', 6, src, taken);
}

/** Answer box ids (07 §7.1): 'q-' + 8 hex. */
export const QA_ID_RE = /^q-[0-9a-f]{8}$/;

/**
 * 'q-' + 8 hex (07 §7.1 answer box). `taken` should hold every SectionId, glossary id, answer id
 * and retired id of the document, so an id never repeats across versions.
 */
export function mintQaId(src: IdSource, taken: TakenIds): string {
  return mintWithPrefix('q-', 8, src, taken);
}

/** 'd' + 8 hex + '-' prefix for ids inside one diagram SVG (07 §7.3). */
export function mintDiagramPrefix(src: IdSource): string {
  return `${mintWithPrefix('d', 8, src, { has: () => false })}-`;
}

/** Every SectionId in the model (all tabs), for collision checks (07 §4.2 rule 2). */
export function sectionIdsOf(tabs: readonly { sections: readonly { id: string }[] }[]): Set<string> {
  const s = new Set<string>();
  for (const t of tabs) for (const sec of t.sections) s.add(sec.id);
  return s;
}

/** Every answer box id in the model (07 §7.1). */
export function qaIdsOf(tabs: readonly Tab[]): Set<string> {
  const s = new Set<string>();
  for (const t of tabs) for (const sec of t.sections) for (const b of sec.blocks) if (b.type === 'qa') s.add(b.id);
  return s;
}
