// Section hash (08 §6.3): the staleness precondition checked at save time.
import { canonicalJson } from '../canonical-json';
import { sha256Hex } from '../images';
import type { Section } from '../types';

/** sha256 of the canonical (sorted-key) Section, computed from the parsed model, never from HTML. */
export function sectionHash(section: Section): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson(section)));
}
