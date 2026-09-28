// Privacy guard for stock photo search queries (07 §7.4). The prompts already ask for short generic
// queries; this is the code-side check before anything leaves the machine. It keeps plain lowercase
// words only: no URLs, e-mail addresses, digits, quoted text, acronyms, camelCase, runs of
// capitalized words, or words the drafts use as proper nouns.

export const QUERY_MAX_WORDS = 6;
export const QUERY_MAX_CHARS = 60;

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'at',
  'in',
  'on',
  'to',
  'and',
  'or',
  'with',
  'for',
  'by',
  'from',
  'into',
  'near',
]);
/** Photos of logos and brands are not wanted (07 §7.4). */
const DENY = new Set(['logo', 'logos', 'brand', 'brands', 'trademark', 'trademarks']);

const QUOTED = /"[^"]*"|“[^”]*”|„[^“”]*[“”]|‘[^’]*’|«[^»]*»|(^|\s)'[^']*'(?=\s|$)/g;
const URLS = /\b(?:https?:\/\/|www\.)\S+/gi;
const EMAILS = /\S+@\S+/g;
const SPLIT = /[\s,;:!?()[\]{}/\\|+*=<>#&%$~^`]+/;

/** Capitalized words that do not start a sentence, lowercased: likely names in the drafts. */
export function properNounsOf(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const sentence of t.split(/(?<=[.!?:;])\s+|\n+/)) {
      const words = sentence.match(/\p{L}[\p{L}'’-]*/gu) ?? [];
      words.forEach((w, i) => {
        if (i > 0 && /^\p{Lu}/u.test(w)) out.add(w.toLowerCase().replace(/['’]s$/, ''));
      });
    }
  }
  return out;
}

/**
 * The query as it may be sent to a public photo search, or null when nothing generic is left.
 * `properNouns` (lowercase) come from properNounsOf over the document's drafts.
 */
export function sanitizePhotoQuery(q: string, properNouns: ReadonlySet<string> = new Set()): string | null {
  const s = q.normalize('NFKC').replace(URLS, ' ').replace(EMAILS, ' ').replace(QUOTED, ' ');
  const raw = s
    .split(SPLIT)
    .map((t) => t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''))
    .filter((t) => t !== '');
  const isCap = (t: string | undefined): boolean => t !== undefined && /^[A-Z]/.test(t);
  const words: string[] = [];
  raw.forEach((t, i) => {
    if (/\d/.test(t) || /[^A-Za-z'-]/.test(t)) return; // digits, symbols, non-ASCII: dropped
    if (/[A-Z]/.test(t.slice(1))) return; // acronyms and camelCase (FBI, iPhone)
    if (isCap(t) && (i > 0 || isCap(raw[i + 1]))) return; // names: capitalized mid-query, or a capitalized run
    const w = t.toLowerCase();
    if (properNouns.has(w) || DENY.has(w)) return;
    words.push(w);
  });
  const kept = words.slice(0, QUERY_MAX_WORDS);
  while (kept.length > 1 && kept.join(' ').length > QUERY_MAX_CHARS) kept.pop();
  const out = kept.join(' ').slice(0, QUERY_MAX_CHARS);
  return kept.some((w) => w.length >= 3 && !STOPWORDS.has(w)) ? out : null;
}
