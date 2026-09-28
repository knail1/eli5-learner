import { describe, expect, it } from 'vitest';
import {
  CATALOG_SCHEMA_VERSION,
  CatalogEntrySchema,
  CatalogFileSchema,
  DocumentMetaSchema,
  META_SCHEMA_VERSION,
  SuggestionsFileSchema,
} from '../../../../src/main/library/schema';

const ID = '0b7f1c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e';
const TS = '2026-09-27T12:34:56.789Z';

const entry = {
  id: ID,
  title: 'ROAS & Marketing Mix Models',
  topicSlug: 'roas-and-marketing-mix-models',
  createdAt: TS,
  updatedAt: TS,
  summary: 'How ROAS and MMM relate.',
  summarySource: 'llm',
  tabCount: 2,
  mergedFromCount: 0,
};

const meta = {
  schemaVersion: META_SCHEMA_VERSION,
  id: ID,
  topicSlug: 'roas-and-marketing-mix-models',
  title: 'ROAS & Marketing Mix Models',
  summary: 'How ROAS and MMM relate.',
  summarySource: 'fallback',
  createdAt: TS,
  updatedAt: TS,
  jobId: 'job-1',
  edition: 'public',
  clarifyingInput: '',
  glossaryEnabled: true,
  sourcesUsed: [{ ref: 'deck.pdf', kind: 'file', mimeType: 'application/pdf', sha256: 'a'.repeat(64) }],
  sourcesSkipped: [{ ref: 'https://x.test/a', reason: 'Needs sign-in', code: 'login-required' }],
  tabs: [
    { key: 'indepth', kind: 'indepth', label: 'In depth', sectionCount: 5, createdAt: TS },
    { key: 'eli5', kind: 'eli5', label: 'ELI5', sectionCount: 3, createdAt: TS },
    {
      key: 'sx4e1a07',
      kind: 'section-eli5',
      label: 'ELI5: Revenue',
      sectionCount: 2,
      sourceSectionId: 'sec-indepth-9b04e1aa',
      createdAt: TS,
    },
  ],
  generation: { provider: 'claude', model: 'm', prompts: ['in-depth@1'] },
  warnings: [{ kind: 'glossary-omitted', message: 'Glossary omitted' }],
  merges: [],
  actions: [
    {
      at: TS,
      action: 'eli5-tab',
      sectionId: 'sec-indepth-9b04e1aa',
      tabKey: 'indepth',
      jobId: 'j2',
      resultTabKey: 'sx4e1a07',
    },
  ],
};

describe('CatalogEntrySchema (09 §5.1)', () => {
  it('accepts a valid entry', () => {
    expect(CatalogEntrySchema.parse(entry)).toEqual(entry);
  });

  it.each([
    ['empty title', { title: '' }],
    ['title > 200', { title: 'x'.repeat(201) }],
    ['summary > 300', { summary: 'x'.repeat(301) }],
    ['bad slug', { topicSlug: 'Has Spaces' }],
    ['bad uuid', { id: 'nope' }],
    ['non-UTC timestamp', { createdAt: '2026-09-27T12:00:00+02:00' }],
    ['bad summarySource', { summarySource: 'human' }],
    ['negative tabCount', { tabCount: -1 }],
    ['fractional mergedFromCount', { mergedFromCount: 1.5 }],
  ])('rejects %s', (_name, patch) => {
    expect(CatalogEntrySchema.safeParse({ ...entry, ...patch }).success).toBe(false);
  });

  it('validates a catalog file', () => {
    const file = { schemaVersion: CATALOG_SCHEMA_VERSION, appVersion: '0.1.0', updatedAt: TS, entries: [entry] };
    expect(CatalogFileSchema.parse(file).entries).toHaveLength(1);
    expect(CatalogFileSchema.safeParse({ ...file, schemaVersion: 0 }).success).toBe(false);
    expect(CatalogFileSchema.safeParse({ ...file, entries: [{ ...entry, id: 1 }] }).success).toBe(false);
  });
});

describe('DocumentMetaSchema (09 §5.2)', () => {
  it('accepts a valid meta and defaults retiredIds/publications to []', () => {
    const out = DocumentMetaSchema.parse(meta);
    expect(out.retiredIds).toEqual([]);
    expect(out.publications).toEqual([]);
    expect(out.tabs).toHaveLength(3);
  });

  it('preserves unknown fields (not strict)', () => {
    const out = DocumentMetaSchema.parse({ ...meta, futureField: { x: 1 } });
    expect(out.futureField).toEqual({ x: 1 });
  });

  it('accepts publications and retiredIds when present', () => {
    const out = DocumentMetaSchema.parse({
      ...meta,
      retiredIds: ['sec-sx4e1a07-00000000'],
      publications: [
        { targetId: 'local', kind: 'local', publishedAt: TS, primaryUrl: 'file:///x', contentSha256: 'b'.repeat(64) },
      ],
    });
    expect(out.retiredIds).toEqual(['sec-sx4e1a07-00000000']);
    expect(out.publications).toHaveLength(1);
  });

  it.each([
    ['missing schemaVersion', { schemaVersion: undefined }],
    ['bad edition', { edition: 'free' }],
    ['bad source kind', { sourcesUsed: [{ ref: 'a', kind: 'ftp' }] }],
    ['bad sha256', { sourcesUsed: [{ ref: 'a', kind: 'file', sha256: 'xyz' }] }],
    ['bad skipped shape', { sourcesSkipped: [{ ref: 'a' }] }],
    ['bad tab key', { tabs: [{ key: 'other', kind: 'eli5', label: 'x', sectionCount: 0, createdAt: TS }] }],
    ['bad retired id', { retiredIds: ['section-1'] }],
    ['bad warning', { warnings: [{ kind: 'x' }] }],
    ['bad action', { actions: [{ ...meta.actions[0], action: 'delete' }] }],
    ['missing generation', { generation: undefined }],
    [
      'bad merge anchor',
      {
        merges: [
          {
            suggestionId: 's',
            sourceDocId: 'd',
            sourceTitle: 't',
            sourceSlug: 's',
            sourceSummary: '',
            mergedAt: TS,
            anchorSectionIds: ['x'],
          },
        ],
      },
    ],
  ])('rejects %s', (_name, patch) => {
    expect(DocumentMetaSchema.safeParse({ ...meta, ...patch }).success).toBe(false);
  });
});

describe('SuggestionsFileSchema (09 §10.5)', () => {
  it('accepts a valid file and rejects an out-of-range score', () => {
    const s = {
      id: ID,
      createdAt: TS,
      status: 'pending',
      source: { id: 'a', slug: 'a', title: 'A' },
      target: { id: 'b', slug: 'b', title: 'B' },
      score: 0.8,
      reason: 'Same topic',
      scorer: 'lexical+llm',
    };
    const file = { schemaVersion: 1, suggestions: [s], dismissedPairs: [{ a: 'a', b: 'b', at: TS }] };
    expect(SuggestionsFileSchema.safeParse(file).success).toBe(true);
    expect(SuggestionsFileSchema.safeParse({ ...file, suggestions: [{ ...s, score: 1.2 }] }).success).toBe(false);
  });
});
