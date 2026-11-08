import type { SteDraft } from '../schemas/draft';
import { snippet, splitSentences, wordCount } from './sentences';

/**
 * ASD-STE100 lint (02 §12.2, D16): deterministic checks of the STE tab's own text. Kept visuals are
 * not checked (they are In depth blocks). v1 rules:
 * - length: procedural sentences (stepper steps, ordered-list items) at most 20 words, every other
 *   sentence at most 25;
 * - one instruction: a procedural sentence that chains two actions with "and then" or a semicolon;
 * - passive voice: a form of "be" followed by a past participle ending in -ed or -en. STE requires
 *   the active voice in procedural writing and asks for it "as much as possible" in descriptive
 *   writing, so only procedural passives are scored; descriptive ones are listed for the repair;
 * - terms: a declared `terms[i].term` that the text never uses (v1 does not detect synonyms).
 * Score = failing sentences / sentences (term and descriptive-passive findings are listed but not scored).
 */

export const STE_PROCEDURAL_MAX_WORDS = 20;
export const STE_DESCRIPTIVE_MAX_WORDS = 25;
/** D16: above this share of failing sentences, the STE step asks for one repair. */
export const STE_REPAIR_THRESHOLD = 0.2;
/** D16: a repair is kept only when it keeps at least this share of the first draft's sentences. */
export const STE_REPAIR_MIN_SENTENCES = 0.8;

export type SteRule = 'length' | 'one-instruction' | 'passive' | 'term-unused';

export interface SteFinding {
  /** 0-based section index; -1 for a document-level finding. */
  section: number;
  rule: SteRule;
  /** The sentence (shortened) or the term. */
  text: string;
  detail: string;
}

export interface SteLintResult {
  sentences: number;
  failing: number;
  /** failing / sentences (0 when there is no text). */
  score: number;
  findings: SteFinding[];
}

const PASSIVE_RE = /\b(?:is|are|was|were|be|been|being)\s+([A-Za-z]+(?:ed|en))\b/gi;
/** Words ending in -en or -ed that are not participles. */
const NOT_PARTICIPLES: ReadonlySet<string> = new Set([
  'often',
  'even',
  'then',
  'when',
  'open',
  'seven',
  'eleven',
  'ten',
  'men',
  'women',
  'children',
  'garden',
  'kitchen',
  'golden',
  'sudden',
  'green',
  'token',
  'need',
  'speed',
  'red',
  'bed',
  'hundred',
  'indeed',
  'seed',
  'limited',
  'fixed',
  'related',
  'skewed',
  'hidden',
  'broken',
]);

export function isPassive(sentence: string): boolean {
  for (const m of sentence.matchAll(PASSIVE_RE)) {
    if (!NOT_PARTICIPLES.has((m[1] ?? '').toLowerCase())) return true;
  }
  return false;
}

function twoInstructions(sentence: string): boolean {
  return /\band then\b/i.test(sentence) || /;\s/.test(sentence);
}

interface Unit {
  section: number;
  text: string;
  procedural: boolean;
}

function units(draft: SteDraft): Unit[] {
  const out: Unit[] = [];
  draft.sections.forEach((sec, section) => {
    for (const b of sec.blocks) {
      switch (b.type) {
        case 'paragraph':
        case 'callout':
        case 'analogy':
          out.push({ section, text: b.md, procedural: false });
          break;
        case 'pullquote':
          out.push({ section, text: b.text, procedural: false });
          break;
        case 'list':
          for (const item of b.items) out.push({ section, text: item, procedural: b.ordered });
          break;
        case 'stepper':
          for (const st of b.steps) out.push({ section, text: st.md, procedural: true });
          break;
        case 'keep':
          break;
      }
    }
  });
  return out;
}

/** All of the tab's own text (headings, title and dek included), lower-cased, for the term check. */
function allText(draft: SteDraft): string {
  const parts = [draft.title, draft.dek ?? ''];
  for (const sec of draft.sections) {
    parts.push(sec.heading);
    for (const b of sec.blocks) {
      if (b.type === 'paragraph' || b.type === 'callout' || b.type === 'analogy') parts.push(b.md);
      else if (b.type === 'pullquote') parts.push(b.text);
      else if (b.type === 'list') parts.push(...b.items);
      else if (b.type === 'stepper') parts.push(b.title, ...b.steps.flatMap((s) => [s.label, s.md]));
    }
  }
  return parts.join('\n').toLowerCase();
}

export function lintSte(draft: SteDraft): SteLintResult {
  const findings: SteFinding[] = [];
  let sentences = 0;
  let failing = 0;
  for (const u of units(draft)) {
    for (const s of splitSentences(u.text)) {
      sentences++;
      let fails = false;
      const n = wordCount(s);
      const max = u.procedural ? STE_PROCEDURAL_MAX_WORDS : STE_DESCRIPTIVE_MAX_WORDS;
      const kind = u.procedural ? 'procedural' : 'descriptive';
      if (n > max) {
        findings.push({
          section: u.section,
          rule: 'length',
          text: snippet(s),
          detail: `${n} words (${kind} limit ${max})`,
        });
        fails = true;
      }
      if (u.procedural && twoInstructions(s)) {
        findings.push({
          section: u.section,
          rule: 'one-instruction',
          text: snippet(s),
          detail: 'two instructions in one sentence',
        });
        fails = true;
      }
      if (isPassive(s)) {
        findings.push({
          section: u.section,
          rule: 'passive',
          text: snippet(s),
          detail: u.procedural ? 'passive voice' : 'passive voice (use the active voice where you can)',
        });
        if (u.procedural) fails = true;
      }
      if (fails) failing++;
    }
  }
  const text = allText(draft);
  for (const t of draft.terms) {
    const term = t.term.trim().toLowerCase();
    if (term && !text.includes(term)) {
      findings.push({ section: -1, rule: 'term-unused', text: t.term, detail: 'declared term never used' });
    }
  }
  return { sentences, failing, score: sentences ? failing / sentences : 0, findings };
}

/** Findings as the numbered list the repair turn receives (D16): "section, sentence, rule". */
export function steFindingsText(r: SteLintResult, max = 30): string {
  const lines = r.findings.slice(0, max).map((f, i) => {
    const where = f.section >= 0 ? `section ${f.section + 1}` : 'terms';
    return `${i + 1}. ${where}, "${f.text}": ${f.detail}`;
  });
  if (r.findings.length > max) lines.push(`...and ${r.findings.length - max} more`);
  return lines.join('\n');
}
