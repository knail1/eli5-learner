import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  diffEntries,
  entryFromMeta,
  newestFirst,
  sanitizeMeta,
  sanitizeSourceRecord,
  uuidFrom,
} from '../../../../src/main/library/catalog';
import { CatalogEntrySchema } from '../../../../src/main/library';
import { SeededIdSource } from '../../../helpers/ids';
import { makeMeta } from './fixtures';

describe('entryFromMeta (09 §7 step 5)', () => {
  it('derives a valid catalog entry from meta alone', () => {
    const m = makeMeta({ merges: [] });
    const e = entryFromMeta(m);
    expect(CatalogEntrySchema.parse(e)).toEqual(e);
    expect(e).toMatchObject({ id: m.id, topicSlug: m.topicSlug, tabCount: 2, mergedFromCount: 0 });
  });
});

describe('newestFirst / diffEntries', () => {
  const a = entryFromMeta(makeMeta({ topicSlug: 'a-doc', createdAt: '2026-01-01T00:00:00.000Z' }));
  const b = entryFromMeta(makeMeta({ topicSlug: 'b-doc', createdAt: '2026-01-02T00:00:00.000Z' }));
  const c = entryFromMeta(makeMeta({ topicSlug: 'c-doc', createdAt: '2026-01-02T00:00:00.000Z' }));

  it('orders by createdAt descending, ties by slug', () => {
    expect(newestFirst([a, c, b]).map((e) => e.topicSlug)).toEqual(['b-doc', 'c-doc', 'a-doc']);
  });

  it('reports added, removed and changed slugs', () => {
    expect(diffEntries([a, b], [a, b])).toEqual([]);
    expect(diffEntries([a], [a, b])).toEqual(['b-doc']);
    expect(diffEntries([a, b], [b])).toEqual(['a-doc']);
    expect(diffEntries([a], [{ ...a, title: 'Changed' }])).toEqual(['a-doc']);
    expect(diffEntries([a], [{ ...a, topicSlug: 'renamed' }])).toEqual(['a-doc', 'renamed']);
  });
});

describe('uuidFrom', () => {
  it('makes deterministic valid v4 UUIDs from the injected source', () => {
    const x = uuidFrom(new SeededIdSource(3));
    expect(uuidFrom(new SeededIdSource(3))).toBe(x);
    expect(z.uuid().safeParse(x).success).toBe(true);
    expect(x.charAt(14)).toBe('4');
  });
});

describe('meta privacy (09 §5.2, HOOK-LIB-01)', () => {
  it('keeps basenames for files and drops URL fragments', () => {
    expect(sanitizeSourceRecord({ ref: '/Users/x/deck.pptx', kind: 'file' }, 'full').ref).toBe('deck.pptx');
    expect(sanitizeSourceRecord({ ref: 'C:\\x\\deck.pptx', kind: 'file' }, 'full').ref).toBe('deck.pptx');
    expect(sanitizeSourceRecord({ ref: 'Pasted image 1', kind: 'clipboard' }, 'full').ref).toBe('Pasted image 1');
    expect(sanitizeSourceRecord({ ref: 'https://a.example/p?q=1#f', kind: 'url' }, 'full').ref).toBe(
      'https://a.example/p?q=1',
    );
    expect(sanitizeSourceRecord({ ref: 'not a url', kind: 'url' }, 'full').ref).toBe('not a url');
  });

  it("the 'redacted' policy also drops query strings", () => {
    expect(sanitizeSourceRecord({ ref: 'https://a.example/p?q=1#f', kind: 'url' }, 'redacted').ref).toBe(
      'https://a.example/p',
    );
    const m = sanitizeMeta(
      makeMeta({ sourcesSkipped: [{ ref: 'https://a.example/x?token=1', reason: 'r', code: 'login-required' }] }),
      'redacted',
    );
    expect(m.sourcesSkipped[0]?.ref).toBe('https://a.example/x');
  });
});
