import { describe, expect, it } from 'vitest';
import {
  baseSlug,
  chooseSlug,
  isReservedSlug,
  isValidSlug,
  RESERVED_SLUGS,
  slugify,
} from '../../../../src/main/library/slug';

const NOW = new Date(2026, 8, 27, 12, 0, 0);

describe('slugify (09 §6.1)', () => {
  it.each([
    ['ROAS & Marketing Mix Models', 'roas-and-marketing-mix-models'],
    ['Q3 FY26 Revenue Recognition (ASC 606)', 'q3-fy26-revenue-recognition-asc-606'],
    ['  --Hello,   World!--  ', 'hello-world'],
    ['Café Crème Brûlée', 'cafe-creme-brulee'],
    ['ﬁnance ①', 'finance-1'],
    ['a&b', 'a-and-b'],
  ])('%j -> %s', (input, expected) => {
    expect(slugify(input, NOW)).toBe(expected);
  });

  it('cuts at the last dash at or before 60 chars', () => {
    const input = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
    const s = slugify(input, NOW);
    expect(s).toBe('alpha-beta-gamma-delta-epsilon-zeta-eta-theta-iota-kappa');
    expect(s.length).toBeLessThanOrEqual(60);
  });

  it('keeps a word ending exactly at 60', () => {
    const input = `${'a'.repeat(29)} ${'b'.repeat(30)} tail`;
    expect(slugify(input, NOW)).toBe(`${'a'.repeat(29)}-${'b'.repeat(30)}`);
  });

  it('hard cuts at 60 when there is no dash', () => {
    expect(slugify('x'.repeat(80), NOW)).toBe('x'.repeat(60));
  });

  it('falls back to learning-<yyyymmdd> when empty', () => {
    expect(slugify('日本語のタイトル', NOW)).toBe('learning-20260927');
    expect(slugify('!!!', NOW)).toBe('learning-20260927');
  });

  it('always yields a valid slug', () => {
    for (const s of ['A', 'Über-Straße 2', '---', 'x'.repeat(200), 'a - - b']) {
      expect(isValidSlug(slugify(s, NOW))).toBe(true);
    }
  });
});

describe('reserved slugs (09 §6.3)', () => {
  it('reserves the listed names and dot-names', () => {
    for (const r of ['catalog', 'index', 'sample', 'assets', 'static', 'api', 'docs']) {
      expect(RESERVED_SLUGS.has(r)).toBe(true);
      expect(isReservedSlug(r)).toBe(true);
    }
    expect(isReservedSlug('.trash')).toBe(true);
    expect(isReservedSlug('samples')).toBe(false);
  });

  it('suffixes -doc to a reserved base', () => {
    expect(baseSlug('Sample', undefined, NOW)).toBe('sample-doc');
    expect(baseSlug('API', undefined, NOW)).toBe('api-doc');
  });
});

describe('baseSlug hint handling (09 §6.1 step 1)', () => {
  it('prefers a non-empty hint', () => {
    expect(baseSlug('Long Title Here', 'roas', NOW)).toBe('roas');
  });
  it('falls back to the title when the hint slugifies to empty', () => {
    expect(baseSlug('Long Title Here', '???', NOW)).toBe('long-title-here');
    expect(baseSlug('Long Title Here', '', NOW)).toBe('long-title-here');
  });
});

describe('chooseSlug collisions (09 §6.2)', () => {
  it('returns the base when free', () => {
    expect(chooseSlug('Topic', undefined, [], { now: NOW })).toBe('topic');
  });

  it('suffixes -2, -3 ...', () => {
    expect(chooseSlug('Topic', undefined, ['topic'], { now: NOW })).toBe('topic-2');
    expect(chooseSlug('Topic', undefined, ['topic', 'topic-2'], { now: NOW })).toBe('topic-3');
  });

  it('compares case-insensitively', () => {
    expect(chooseSlug('Topic', undefined, ['TOPIC', 'Topic-2'], { now: NOW })).toBe('topic-3');
  });

  it('applies suffixes after the reserved -doc rule', () => {
    expect(chooseSlug('Index', undefined, ['index-doc'], { now: NOW })).toBe('index-doc-2');
  });

  it('falls back to -<8 hex> after -999', () => {
    const taken = ['topic', ...Array.from({ length: 998 }, (_, i) => `topic-${i + 2}`)];
    const hexes = ['deadbeef', 'cafef00d'];
    const out = chooseSlug('Topic', undefined, [...taken, 'topic-deadbeef'], {
      now: NOW,
      randomHex: () => hexes.shift() ?? '00000000',
    });
    expect(out).toBe('topic-cafef00d');
  });

  it('uses a random hex when no generator is given', () => {
    const taken = ['t', ...Array.from({ length: 998 }, (_, i) => `t-${i + 2}`)];
    expect(chooseSlug('T', undefined, taken, { now: NOW })).toMatch(/^t-[0-9a-f]{8}$/);
  });

  it('keeps suffixed slugs within 60 chars', () => {
    const title = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';
    const base = chooseSlug(title, undefined, [], { now: NOW });
    const next = chooseSlug(title, undefined, [base], { now: NOW });
    expect(next.length).toBeLessThanOrEqual(60);
    expect(next.endsWith('-2')).toBe(true);
    expect(isValidSlug(next)).toBe(true);
  });
});
