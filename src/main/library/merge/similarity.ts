/**
 * Lexical prefilter (09 §10.2 step 3): TF-IDF cosine over `title + summary` from the catalog only
 * (09 §1 rule 2: nothing re-reads index.html). The `SimilarityScorer` seam lets a future embedding
 * scorer replace it.
 */
import type { CatalogEntry } from '../types';

export interface SimilarityScorer {
  readonly id: 'lexical' | 'embedding';
  /** Scores in 0..1, descending. */
  score(query: { title: string; summary: string }, corpus: CatalogEntry[]): Promise<{ id: string; score: number }[]>;
}

/** Built-in English stopword list (09 §10.2 step 3.2). */
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'about above after again against all also am an and any are aren as at be because been before being below ' +
    'between both but by can cannot could did do does doing don down during each else etc few for from further ' +
    'get gets got had has have having he her here hers herself him himself his how however if in into is it its ' +
    'itself just let like made make many may me might more most much must my myself no nor not now of off on ' +
    'once only or other ought our ours ourselves out over own per same shall she should so some such than that ' +
    'the their theirs them themselves then there these they this those through thus to too under until up upon ' +
    'us use used using very via was we were what when where whether which while who whom whose why will with ' +
    'within without would yet you your yours yourself yourselves'
  ).split(' '),
);

/** All-caps token from the original text, e.g. `ROAS`, `ASC`, `Q3` (step 3.2). */
const ACRONYM_RE = /^[A-Z0-9]*[A-Z][A-Z0-9]*$/;
const SPLIT_RE = /[^\p{L}\p{N}]+/u;
const MARKS_RE = /\p{M}+/gu;
const MIN_STEM = 3;

/** Light suffix stemming (step 3.3): the first matching rule applies only if the stem keeps ≥ 3 chars. */
export function stem(w: string): string {
  const cut = (n: number, add = ''): string => {
    const s = w.slice(0, w.length - n) + add;
    return s.length >= MIN_STEM ? s : w;
  };
  if (w.endsWith('ies')) return cut(3, 'y');
  if (w.endsWith('ing')) return cut(3);
  if (w.endsWith('ed')) return cut(2);
  if (/(?:s|x|z|ch|sh)es$/.test(w)) return cut(2);
  if (w.endsWith('s') && !w.endsWith('ss')) return cut(1);
  return w;
}

/** Steps 3.1-3.3: NFKD, strip marks, split on non-alphanumerics, lowercase, filter, stem. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.normalize('NFKD').replace(MARKS_RE, '').split(SPLIT_RE)) {
    if (raw === '') continue;
    const lower = raw.toLowerCase();
    if (raw.length >= 2 && ACRONYM_RE.test(raw)) {
      out.push(lower);
      continue;
    }
    if (lower.length < 2 || STOPWORDS.has(lower)) continue;
    out.push(stem(lower));
  }
  return out;
}

type Vector = Map<string, number>;

/** Term counts with title tokens weighted ×2 (step 3.4). */
function termCounts(title: string, summary: string): Vector {
  const v: Vector = new Map();
  for (const t of tokenize(title)) v.set(t, (v.get(t) ?? 0) + 2);
  for (const t of tokenize(summary)) v.set(t, (v.get(t) ?? 0) + 1);
  return v;
}

function cosine(a: Vector, b: Vector): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [t, x] of a) {
    na += x * x;
    const y = b.get(t);
    if (y !== undefined) dot += x * y;
  }
  for (const y of b.values()) nb += y * y;
  if (dot === 0 || na === 0 || nb === 0) return 0;
  return Math.min(1, Math.max(0, dot / Math.sqrt(na * nb)));
}

/** TF-IDF cosine (step 3.4-3.5). IDF is smoothed over `corpus ∪ {query}`. */
export class LexicalScorer implements SimilarityScorer {
  readonly id = 'lexical' as const;

  score(query: { title: string; summary: string }, corpus: CatalogEntry[]): Promise<{ id: string; score: number }[]> {
    if (corpus.length === 0) return Promise.resolve([]);
    const q = termCounts(query.title, query.summary);
    const docs = corpus.map((e) => ({ id: e.id, v: termCounts(e.title, e.summary) }));
    const df = new Map<string, number>();
    for (const v of [q, ...docs.map((d) => d.v)]) for (const t of v.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const n = docs.length + 1;
    const weigh = (v: Vector): Vector => {
      const w: Vector = new Map();
      for (const [t, tf] of v) w.set(t, tf * (Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1));
      return w;
    };
    const qw = weigh(q);
    const scored = docs.map((d) => ({ id: d.id, score: cosine(qw, weigh(d.v)) }));
    // Descending; ties keep corpus order (stable sort).
    scored.sort((a, b) => b.score - a.score);
    return Promise.resolve(scored);
  }
}
