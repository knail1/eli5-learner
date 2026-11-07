import { describe, expect, it } from 'vitest';
import {
  CATALOG_SCHEMA_VERSION,
  CatalogEntrySchema,
  CatalogFileSchema,
  DocumentMetaSchema,
  META_SCHEMA_VERSION,
  SuggestionsFileSchema,
  VersionNodeRecordSchema,
  VersionTreeFileSchema,
} from '../../../../src/main/library/schema';
import type { LoggedAction, MenuAction } from '../../../../src/main/library';

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
    {
      at: TS,
      action: 'eli5-selection',
      sectionId: 'sec-indepth-9b04e1aa',
      sectionIds: ['sec-indepth-9b04e1aa', 'sec-indepth-0badc0de'],
      tabKey: 'indepth',
      jobId: 'j3',
      resultTabKey: 'sx4e1a08',
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

describe('meta.versionId and meta.asks (09 §5.2, no schema bump)', () => {
  const ask = {
    at: TS,
    sectionId: 'sec-indepth-9b04e1aa',
    tabKey: 'indepth',
    question: 'Why does the price move?',
    qaId: 'q-0a1b2c3d',
    jobId: 'j4',
  };

  it('accepts both, and a meta without them still parses at the same schemaVersion', () => {
    const out = DocumentMetaSchema.parse({ ...meta, versionId: 'v-0123456789ab', asks: [ask] });
    expect(out.versionId).toBe('v-0123456789ab');
    expect(out.asks).toEqual([ask]);
    expect(out.schemaVersion).toBe(META_SCHEMA_VERSION);
    expect(META_SCHEMA_VERSION).toBe(1);
    expect(DocumentMetaSchema.parse(meta).versionId).toBeUndefined();
  });

  it.each([
    ['bad versionId', { versionId: 'v-xyz' }],
    ['bad qaId', { asks: [{ ...ask, qaId: 'q-1' }] }],
    ['question > 500', { asks: [{ ...ask, question: 'x'.repeat(501) }] }],
    ['empty question', { asks: [{ ...ask, question: '' }] }],
  ])('rejects %s', (_name, patch) => {
    expect(DocumentMetaSchema.safeParse({ ...meta, ...patch }).success).toBe(false);
  });

  it('keeps ask out of the action log: the strict action enum still refuses it', () => {
    expect(DocumentMetaSchema.safeParse({ ...meta, actions: [{ ...meta.actions[0], action: 'ask' }] }).success).toBe(
      false,
    );
    // LoggedAction is MenuAction without 'ask' (compile-time drift check).
    const same: [LoggedAction] extends [Exclude<MenuAction, 'ask'>]
      ? [Exclude<MenuAction, 'ask'>] extends [LoggedAction]
        ? true
        : false
      : false = true;
    expect(same).toBe(true);
  });
});

describe('version tree schemas (09 §4.1)', () => {
  const node = {
    id: 'v-0123456789ab',
    parentId: null,
    createdAt: TS,
    kind: 'initial',
    label: 'Original',
    topic: 'Original',
    sha256: 'a'.repeat(64),
    bytes: 10,
  };

  it('accepts nodes, stubs and a tree', () => {
    expect(VersionNodeRecordSchema.parse(node)).toEqual(node);
    expect(VersionNodeRecordSchema.parse({ ...node, sha256: null }).sha256).toBeNull();
    const child = { ...node, id: 'v-0123456789ac', parentId: node.id, kind: 'ask', question: 'Why?' };
    const tree = { schemaVersion: 1, rootId: node.id, currentId: child.id, nodes: [node, child] };
    expect(VersionTreeFileSchema.parse(tree).nodes).toHaveLength(2);
    expect(VersionTreeFileSchema.safeParse({ ...tree, nodes: [] }).success).toBe(false);
  });

  it.each([
    ['bad id', { id: 'v-1' }],
    ['bad kind', { kind: 'delete' }],
    ['topic > 48', { topic: 'x'.repeat(49) }],
    ['empty label', { label: '' }],
    ['bad sha', { sha256: 'x' }],
    ['bad target section', { target: { sectionId: 'nope' } }],
  ])('rejects %s', (_name, patch) => {
    expect(VersionNodeRecordSchema.safeParse({ ...node, ...patch }).success).toBe(false);
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
