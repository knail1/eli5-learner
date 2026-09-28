// Non-section identifiers minted by the builder: glossary note ids (07 §3) and diagram id
// prefixes (07 §7.3). SectionIds and tab keys live in section-id.ts.
import { mintWithPrefix, type IdSource, type TakenIds } from './section-id';

/** 'g-' + 6 hex (07 §3 GlossaryNote.id). */
export function mintNoteId(src: IdSource, taken: TakenIds): string {
  return mintWithPrefix('g-', 6, src, taken);
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
