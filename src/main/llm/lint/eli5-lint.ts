import type { DocumentDraftTab, DraftBlock, SectionDraft } from '../schemas/draft';
import { snippet, splitSentences, stripMarkdown, wordCount, words } from './sentences';

/**
 * ELI5 lint (02 §12.2, D17): deterministic findings that feed the `eli5-critique` prompt's
 * `{{lintFindings}}` and the critique accept gate. v1 rules:
 * - long: a sentence over 20 words; average: the tab's average sentence over 15 words;
 * - long word: a word of 4 or more syllables that is not an everyday word;
 * - symbol: a math symbol or Greek letter;
 * - term: a bold In depth term used in a section that has no analogy;
 * - no visual: a section without a visual block.
 */

export const ELI5_MAX_WORDS = 20;
export const ELI5_MAX_AVERAGE = 15;
export const ELI5_LONG_WORD_SYLLABLES = 4;

export type Eli5Rule = 'long-sentence' | 'average' | 'long-word' | 'symbol' | 'term-no-analogy' | 'no-visual';

export interface Eli5Finding {
  /** 0-based section index; -1 for the whole tab. */
  section: number;
  rule: Eli5Rule;
  text: string;
  detail: string;
}

export interface Eli5LintResult {
  sentences: number;
  averageWords: number;
  findings: Eli5Finding[];
}

/** Blocks that count as a picture in the ELI5 tab (D17 rule 5). */
export const ELI5_VISUAL_TYPES: ReadonlySet<DraftBlock['type']> = new Set([
  'diagram',
  'stepper',
  'analogy',
  'chart',
  'photo',
  'figure',
  'animation',
]);

const SYMBOL_RE = /[=^σμΣ∑≈≤≥λθβ]/u;

/** Everyday words of four or more syllables that a newcomer reads without effort. */
const EVERYDAY: ReadonlySet<string> = new Set([
  'actually',
  'everybody',
  'everything',
  'information',
  'understanding',
  'usually',
  'especially',
  'probably',
  'definitely',
  'immediately',
  'automatically',
  'unfortunately',
  'necessary',
  'ordinary',
  'material',
  'materials',
  'america',
  'american',
  'experience',
  'experiences',
  'television',
  'computer',
  'computers',
  'community',
  'activity',
  'activities',
  'electricity',
  'everyday',
  'interesting',
  'comfortable',
  'available',
  'situation',
  'situations',
  'education',
  'organization',
  'organizations',
  'conversation',
  'conversations',
  'opportunity',
  'temperature',
  'vegetable',
  'vegetables',
  'calculator',
  'difference',
  'differences',
  'already',
  'together',
  'similarity',
  'variety',
  'particular',
  'particularly',
]);

/** Heuristic English syllable count: vowel groups, minus a silent final e, at least 1. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w === '') return 0;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

function blockText(b: DraftBlock): string[] {
  switch (b.type) {
    case 'paragraph':
    case 'callout':
    case 'analogy':
      return [b.md];
    case 'pullquote':
      return [b.text];
    case 'list':
      return b.items;
    case 'stepper':
      return b.steps.map((s) => s.md);
    default:
      return [];
  }
}

/** Bold terms of the In depth draft (`**term**`), lower-cased, 3..60 characters. */
export function boldTerms(indepth: DocumentDraftTab | null | undefined): string[] {
  if (!indepth) return [];
  const out = new Set<string>();
  for (const s of indepth.sections)
    for (const b of s.blocks)
      for (const t of blockText(b))
        for (const m of t.matchAll(/\*\*([^*]+)\*\*/g)) {
          const term = (m[1] ?? '').trim().toLowerCase();
          if (term.length >= 3 && term.length <= 60) out.add(term);
        }
  return [...out];
}

function hasVisual(s: SectionDraft): boolean {
  return s.blocks.some((b) => ELI5_VISUAL_TYPES.has(b.type));
}

export function countVisuals(tab: DocumentDraftTab): number {
  return tab.sections.reduce((n, s) => n + s.blocks.filter((b) => ELI5_VISUAL_TYPES.has(b.type)).length, 0);
}

export function lintEli5(tab: DocumentDraftTab, indepth?: DocumentDraftTab | null): Eli5LintResult {
  const findings: Eli5Finding[] = [];
  const terms = boldTerms(indepth);
  let sentences = 0;
  let totalWords = 0;
  tab.sections.forEach((sec, section) => {
    const texts = sec.blocks.flatMap(blockText);
    const longWords = new Set<string>();
    let symbol = false;
    for (const t of texts) {
      for (const s of splitSentences(t)) {
        sentences++;
        const n = wordCount(s);
        totalWords += n;
        if (n > ELI5_MAX_WORDS) {
          findings.push({
            section,
            rule: 'long-sentence',
            text: snippet(s),
            detail: `${n} words (limit ${ELI5_MAX_WORDS})`,
          });
        }
        for (const w of words(s)) {
          const bare = w.toLowerCase().replace(/[^a-z-]/g, '');
          if (bare.includes('-') || EVERYDAY.has(bare)) continue;
          if (syllables(bare) >= ELI5_LONG_WORD_SYLLABLES) longWords.add(bare);
        }
      }
      if (SYMBOL_RE.test(stripMarkdown(t))) symbol = true;
    }
    for (const w of longWords) findings.push({ section, rule: 'long-word', text: w, detail: 'long or technical word' });
    if (symbol) findings.push({ section, rule: 'symbol', text: sec.heading, detail: 'math symbol or Greek letter' });
    if (!sec.blocks.some((b) => b.type === 'analogy')) {
      const lower = texts.join('\n').toLowerCase();
      for (const term of terms)
        if (lower.includes(term)) {
          findings.push({ section, rule: 'term-no-analogy', text: term, detail: 'technical term without an analogy' });
        }
    }
    if (!hasVisual(sec))
      findings.push({ section, rule: 'no-visual', text: sec.heading, detail: 'section has no picture' });
  });
  const averageWords = sentences ? totalWords / sentences : 0;
  if (averageWords > ELI5_MAX_AVERAGE) {
    findings.push({
      section: -1,
      rule: 'average',
      text: tab.title,
      detail: `average sentence is ${averageWords.toFixed(1)} words (aim for ${ELI5_MAX_AVERAGE} or fewer)`,
    });
  }
  return { sentences, averageWords, findings };
}

/** Findings as a compact numbered list for `{{lintFindings}}` (empty string when there are none). */
export function eli5FindingsText(r: Eli5LintResult, max = 40): string {
  const lines = r.findings.slice(0, max).map((f, i) => {
    const where = f.section >= 0 ? `section ${f.section + 1}` : 'whole view';
    return `${i + 1}. ${where}, "${f.text}": ${f.detail}`;
  });
  if (r.findings.length > max) lines.push(`...and ${r.findings.length - max} more`);
  return lines.join('\n');
}

// ---- critique accept gate (D17) ----

/** Numbers 0..10 are everyday counts ("3 steps") and never block a revision. */
const SMALL_NUMBER_MAX = 10;
/**
 * A revised number within this relative distance of a known one is a rounding of it ("37 percent"
 * -> "about 40 percent"), not a new fact.
 */
export const ROUNDING_TOLERANCE = 0.1;

function isRounding(x: string, known: ReadonlySet<string>): boolean {
  const v = Number(x);
  for (const k of known) {
    const n = Number(k);
    if (n !== 0 && Math.abs(v - n) <= ROUNDING_TOLERANCE * Math.abs(n)) return true;
  }
  return false;
}

function numbersIn(text: string, into: Set<string>): void {
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = m[0].replace(/,/g, '').replace(/\.$/, '');
    const v = Number(n);
    if (Number.isFinite(v) && Number.isInteger(v) && v >= 0 && v <= SMALL_NUMBER_MAX) continue;
    into.add(String(v));
  }
}

/** Every number a tab states: its text, table cells, chart labels and values (diagram SVG and animation code excluded). */
export function tabNumbers(tab: DocumentDraftTab): Set<string> {
  const out = new Set<string>();
  numbersIn(`${tab.title}\n${tab.dek ?? ''}`, out);
  for (const s of tab.sections) {
    numbersIn(s.heading, out);
    for (const b of s.blocks) {
      for (const t of blockText(b)) numbersIn(t, out);
      if (b.type === 'stepper') numbersIn(`${b.title}\n${b.steps.map((x) => x.label).join('\n')}`, out);
      else if (b.type === 'pullquote') numbersIn(b.attribution ?? '', out);
      else if (b.type === 'table') numbersIn([b.caption ?? '', ...b.header, ...b.rows.flat()].join('\n'), out);
      else if (b.type === 'chart') {
        const c = b.chart;
        numbersIn([c.title, c.subtitle ?? '', c.unit ?? '', ...c.categories].join('\n'), out);
        for (const se of c.series) for (const v of se.values) if (v !== null) numbersIn(String(v), out);
      } else if (b.type === 'diagram') numbersIn(`${b.title}\n${b.alt}`, out);
      else if (b.type === 'animation') numbersIn(`${b.title}\n${b.caption}\n${b.alt}`, out);
      else if (b.type === 'figure') numbersIn(b.caption, out);
      else if (b.type === 'photo') numbersIn(`${b.alt}\n${b.caption ?? ''}`, out);
    }
  }
  return out;
}

export type CritiqueRejection = 'sections' | 'visuals' | 'media' | 'lint' | 'new-number';

export interface CritiqueGateResult {
  ok: boolean;
  reason?: CritiqueRejection;
  lintBefore: number;
  lintAfter: number;
}

/**
 * Figure image labels, photo queries and animation code of a tab: the critique must keep them as
 * they are (D17 rule 7). An animation is keyed by its code, which the critique never rewrites.
 */
function mediaKeys(tab: DocumentDraftTab): Set<string> {
  const out = new Set<string>();
  for (const s of tab.sections)
    for (const b of s.blocks) {
      if (b.type === 'figure') out.add(`figure:${b.imageLabel}`);
      else if (b.type === 'photo') out.add(`photo:${b.query}`);
      else if (b.type === 'animation') out.add(`animation:${b.js}`);
    }
  return out;
}

/**
 * D17 accept gate: the revision replaces the first draft only when its section count is within one
 * of the draft's and at least 3, it has no fewer visual blocks, it keeps every figure, photo and
 * animation of the draft, its lint finding count is not higher, and it states no number that is in neither the
 * draft nor the In depth view (a number within 10% of a known one counts as a rounding of it).
 */
export function critiqueGate(
  first: DocumentDraftTab,
  revised: DocumentDraftTab,
  indepth: DocumentDraftTab,
): CritiqueGateResult {
  const lintBefore = lintEli5(first, indepth).findings.length;
  const lintAfter = lintEli5(revised, indepth).findings.length;
  const base = { lintBefore, lintAfter };
  const n = revised.sections.length;
  if (n < 3 || Math.abs(n - first.sections.length) > 1) return { ok: false, reason: 'sections', ...base };
  if (countVisuals(revised) < countVisuals(first)) return { ok: false, reason: 'visuals', ...base };
  const theirs = mediaKeys(revised);
  if ([...mediaKeys(first)].some((k) => !theirs.has(k))) return { ok: false, reason: 'media', ...base };
  if (lintAfter > lintBefore) return { ok: false, reason: 'lint', ...base };
  const known = new Set([...tabNumbers(first), ...tabNumbers(indepth)]);
  for (const x of tabNumbers(revised))
    if (!known.has(x) && !isRounding(x, known)) return { ok: false, reason: 'new-number', ...base };
  return { ok: true, ...base };
}
