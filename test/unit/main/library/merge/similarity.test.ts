import { describe, expect, it } from 'vitest';
import {
  JUDGE_TIMEOUT_MS,
  K,
  LexicalScorer,
  MERGE_THRESHOLD,
  PREFILTER_MIN,
  STOPWORDS,
  stem,
  tokenize,
  type CatalogEntry,
} from '../../../../../src/main/library';

/** Lexical prefilter (09 §10.2 step 3). Synthetic "Example Widgets Inc." corpus only. */

const TS = '2026-01-01T00:00:00.000Z';
let n = 0;
function entry(title: string, summary: string, over: Partial<CatalogEntry> = {}): CatalogEntry {
  n++;
  return {
    id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
    title,
    topicSlug: `doc-${n}`,
    createdAt: TS,
    updatedAt: TS,
    summary,
    summarySource: 'llm',
    tabCount: 2,
    mergedFromCount: 0,
    ...over,
  };
}

describe('merge constants (09 §10.2)', () => {
  it('match the spec', () => {
    expect({ K, PREFILTER_MIN, MERGE_THRESHOLD, JUDGE_TIMEOUT_MS }).toEqual({
      K: 8,
      PREFILTER_MIN: 0.05,
      MERGE_THRESHOLD: 0.75,
      JUDGE_TIMEOUT_MS: 30000,
    });
  });
});

describe('stem (09 §10.2 step 3.3)', () => {
  it.each([
    ['companies', 'company'],
    ['boxes', 'box'],
    ['classes', 'class'],
    ['widgets', 'widget'],
    ['pricing', 'pric'],
    ['priced', 'pric'],
    ['class', 'class'],
    ['sing', 'sing'],
    ['bed', 'bed'],
    ['ties', 'ties'],
    ['gas', 'gas'],
  ])('%s -> %s', (w, want) => {
    expect(stem(w)).toBe(want);
  });
});

describe('tokenize (09 §10.2 steps 3.1-3.3)', () => {
  it('lowercases, applies NFKD, splits on non-alphanumerics, drops short tokens and stopwords', () => {
    expect(tokenize('The Café and a widget-pricing guide, e.g. 2 of them')).toEqual([
      'cafe',
      'widget',
      'pric',
      'guide',
    ]);
  });

  it('keeps all-caps acronyms even when they are stopwords, and does not stem them', () => {
    expect(tokenize('ROAS for IT at US offices')).toEqual(['roas', 'it', 'us', 'office']);
    expect(tokenize('it is us')).toEqual([]);
  });

  it('has a built-in English stopword list of about 150 words', () => {
    expect(STOPWORDS.size).toBeGreaterThanOrEqual(120);
    expect(STOPWORDS.size).toBeLessThanOrEqual(200);
    for (const w of ['the', 'and', 'of', 'with', 'this']) expect(STOPWORDS.has(w)).toBe(true);
  });
});

describe('LexicalScorer (09 §10.2 step 3)', () => {
  const scorer = new LexicalScorer();

  it('ranks the related document first, scores in [0,1], descending', async () => {
    const related = entry('Widget ad spend and ROAS', 'How Example Widgets Inc. measures return on ad spend.');
    const other = entry('Office plants', 'Which plants survive in a dim office.');
    const partial = entry('Widget returns', 'How refunds for returned widgets work.');
    const out = await scorer.score(
      { title: 'ROAS for widget ads', summary: 'Return on ad spend for Example Widgets Inc. campaigns.' },
      [other, partial, related],
    );
    expect(out.map((x) => x.id)).toEqual([related.id, partial.id, other.id]);
    for (const x of out) {
      expect(x.score).toBeGreaterThanOrEqual(0);
      expect(x.score).toBeLessThanOrEqual(1);
    }
    expect(out[2]?.score).toBe(0);
    expect(scorer.id).toBe('lexical');
  });

  it('weights title tokens twice', async () => {
    const inTitle = entry('Churn', 'Customers leaving over time.');
    const inSummary = entry('Customers', 'Churn over time.');
    const out = await scorer.score({ title: 'Churn', summary: 'Nothing else here.' }, [inSummary, inTitle]);
    expect(out[0]?.id).toBe(inTitle.id);
    expect(out[0]?.score ?? 0).toBeGreaterThan(out[1]?.score ?? 0);
  });

  it('returns [] for an empty corpus and 1 for an identical text', async () => {
    expect(await scorer.score({ title: 'a b', summary: '' }, [])).toEqual([]);
    const same = entry('Widget pricing tiers', 'Three pricing tiers for widgets.');
    const out = await scorer.score({ title: same.title, summary: same.summary }, [same]);
    expect(out[0]?.score).toBeCloseTo(1, 6);
  });
});
