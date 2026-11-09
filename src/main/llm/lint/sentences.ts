/**
 * Sentence tools for the deterministic writing lints (02 §12.2): Markdown is stripped, then the text
 * is split at sentence ends. Abbreviations ("e.g.", "Dr.", "No. 5"), initials ("J. Smith") and
 * decimals ("3.5") do not end a sentence; a short answer "No." does.
 */

/** Lower-case abbreviations (without the final dot) that never end a sentence. */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'e.g',
  'i.e',
  'etc',
  'vs',
  'cf',
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'st',
  'fig',
  'approx',
  'inc',
  'ltd',
  'co',
  'corp',
  'jr',
  'sr',
  'u.s',
  'u.k',
  'a.m',
  'p.m',
]);

/** Inline Markdown (02 §10 subset) to plain text: links keep their text, markers and code ticks go. */
export function stripMarkdown(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=$|[^\w*])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words that usually open a sentence: after "plan A." they mean the letter ended the sentence. */
const SENTENCE_STARTERS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'for',
  'he',
  'i',
  'if',
  'in',
  'it',
  'its',
  'no',
  'now',
  'on',
  'our',
  'she',
  'so',
  'that',
  'the',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'we',
  'when',
  'yes',
  'you',
]);

/**
 * The piece ends with an abbreviation or an initial, so it runs on into `next`. "No." is the
 * number abbreviation only before a digit ("No. 5"); a single letter is an initial ("J. Smith")
 * unless the next word usually opens a sentence ("plan A. Then ...").
 */
function endsWithAbbreviation(piece: string, next: string): boolean {
  const m = /([A-Za-z.]+)\.$/.exec(piece);
  if (!m) return false;
  const word = (m[1] ?? '').toLowerCase();
  if (word === 'no') return /^\d/.test(next);
  if (/^[a-z]$/.test(word)) {
    const first = /^["'“‘([]*([A-Za-z]+)/.exec(next)?.[1]?.toLowerCase();
    return first !== undefined && !SENTENCE_STARTERS.has(first);
  }
  return ABBREVIATIONS.has(word);
}

/** Splits plain or inline-Markdown text into sentences (trimmed, non-empty). */
export function splitSentences(text: string): string[] {
  const plain = stripMarkdown(text);
  if (plain === '') return [];
  // A boundary: . ! or ? (plus closing quotes or brackets), whitespace, then a capital, digit or opening quote.
  const pieces = plain.split(/(?<=[.!?]["'”’)\]]*)\s+(?=["'“‘([]?[A-Z0-9])/);
  const out: string[] = [];
  for (const piece of pieces) {
    const prev = out[out.length - 1];
    if (prev !== undefined && endsWithAbbreviation(prev, piece)) out[out.length - 1] = `${prev} ${piece}`;
    else out.push(piece);
  }
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

/** Words of a sentence: whitespace-separated tokens that hold a letter or digit. */
export function words(sentence: string): string[] {
  return sentence.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
}

export function wordCount(sentence: string): number {
  return words(sentence).length;
}

/** A sentence shortened for a finding: at most `max` characters, with an ellipsis. */
export function snippet(sentence: string, max = 80): string {
  const chars = [...sentence];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : sentence;
}
