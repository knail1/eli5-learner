/**
 * Sanitized remote views (16 §4.4, §9): the manifest and trees copy allowlisted fields only, labels
 * never carry a reader's question, and `sync.history` picks the snapshots to upload.
 */
import { describe, expect, it } from 'vitest';
import type { DocumentMeta, VersionNodeRecord, VersionTreeFile } from '../../../../src/main/library';
import {
  ALL_MAX_SNAPSHOTS,
  RECENT_SNAPSHOTS,
  buildDocEntry,
  buildManifest,
  buildTree,
  placementOf,
  remoteLabel,
  selectHistory,
} from '../../../../src/main/sync';
import { LibraryManifestSchema, VersionTreeSchema } from '../../../../src/main/sync/protocol';

const DOC = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const TS = '2026-10-01T10:00:00.000Z';
const sha = (n: number) => n.toString(16).padStart(64, '0');
const vid = (n: number) => `v-${n.toString(16).padStart(12, '0')}`;

function node(n: number, over: Partial<VersionNodeRecord> = {}): VersionNodeRecord {
  return {
    id: vid(n),
    parentId: n === 1 ? null : vid(n - 1),
    createdAt: new Date(Date.parse(TS) + n * 60_000).toISOString(),
    kind: n === 1 ? 'initial' : 'expand',
    label: n === 1 ? 'first version' : `expanded 'Section ${n}'`,
    topic: `Section ${n}`,
    sha256: sha(n),
    bytes: 1000,
    ...over,
  };
}

function tree(count: number, currentN = count): VersionTreeFile {
  const nodes = Array.from({ length: count }, (_, i) => node(i + 1));
  return { schemaVersion: 1, rootId: vid(1), currentId: vid(currentN), nodes };
}

/** A meta full of content that must never leave the desktop. Secret-shaped values are assembled at runtime. */
function leakyMeta(): DocumentMeta {
  const marker = (s: string) => ['LEAK', s, 'MARKER'].join('-');
  return {
    schemaVersion: 1,
    id: DOC,
    topicSlug: 'widget-pricing',
    title: 'Widget pricing at Example Widgets Inc.',
    summary: 'How Example Widgets Inc. prices its widgets.',
    summarySource: 'llm',
    createdAt: TS,
    updatedAt: TS,
    jobId: marker('job'),
    edition: 'public',
    clarifyingInput: marker('clarifying'),
    glossaryEnabled: true,
    sourcesUsed: [{ ref: `https://intranet.example.com/${marker('url')}`, kind: 'url' }],
    sourcesSkipped: [],
    tabs: [
      { key: 'indepth', kind: 'indepth', label: 'In depth', sectionCount: 4, createdAt: TS },
      { key: 'eli5', kind: 'eli5', label: 'ELI5', sectionCount: 3, createdAt: TS },
      { key: 'not a tab key', kind: 'eli5', label: 'odd', sectionCount: 1, createdAt: TS },
    ],
    retiredIds: [],
    generation: { provider: 'claude', model: marker('model'), prompts: [marker('prompt')] },
    warnings: [],
    merges: [],
    asks: [
      {
        at: TS,
        sectionId: 'sec-pricing-0a1b2c3d' as DocumentMeta['retiredIds'][number],
        tabKey: 'indepth',
        question: marker('question'),
        qaId: 'q-0a1b2c3d',
        jobId: 'j',
      },
    ],
    publications: [],
  };
}

describe('selectHistory (16 §4.5 step 2)', () => {
  it("'current' uploads the live version only", () => {
    expect(selectHistory(tree(12), 'current').map((n) => n.id)).toEqual([vid(12)]);
  });

  it("'recent' uploads the 10 newest snapshots, the current one always included", () => {
    const recent = selectHistory(tree(12), 'recent');
    expect(recent).toHaveLength(RECENT_SNAPSHOTS);
    expect(recent[0]!.id).toBe(vid(12));
    expect(recent.map((n) => n.id)).not.toContain(vid(1));
    // After a checkout of an old version, that version is still uploaded.
    const old = selectHistory(tree(12, 1), 'recent');
    expect(old[0]!.id).toBe(vid(1));
    expect(old).toHaveLength(RECENT_SNAPSHOTS);
  });

  it("'all' stays within 60 snapshots and 48 MiB, and never selects a pruned node", () => {
    expect(selectHistory(tree(70), 'all')).toHaveLength(ALL_MAX_SNAPSHOTS);
    const big = tree(5);
    for (const n of big.nodes) n.bytes = 20 * 1024 * 1024;
    expect(selectHistory(big, 'all')).toHaveLength(2);
    const pruned = tree(4);
    pruned.nodes[0]!.sha256 = null;
    expect(selectHistory(pruned, 'all').map((n) => n.id)).not.toContain(vid(1));
  });
});

describe('remote labels (08 §6.7, 16 §4.4)', () => {
  it('names the section heading for an ask, never the question or its topic', () => {
    const ask = node(2, {
      kind: 'ask',
      label: "asked about 'why prices rose'",
      topic: 'why prices rose',
      heading: 'Pricing history',
      question: 'Why did prices rise in 2024?',
    });
    expect(remoteLabel(ask)).toBe("asked about 'Pricing history'");
    expect(remoteLabel({ ...ask, heading: undefined })).toBe('asked a question');
  });

  it('keeps other labels, cut to 200 code points', () => {
    expect(remoteLabel(node(3))).toBe("expanded 'Section 3'");
    expect([...remoteLabel(node(3, { label: '😀'.repeat(300) }))]).toHaveLength(200);
  });
});

describe('buildTree / buildDocEntry / buildManifest (16 §4.4)', () => {
  it('marks only uploaded selected snapshots as uploaded and validates against the wire schema', () => {
    const t = buildTree({ docId: DOC, seq: 3, tree: tree(4), uploaded: new Set([sha(4), sha(3)]), fallbackTime: TS });
    expect(VersionTreeSchema.safeParse(t).success).toBe(true);
    expect(t.nodes.filter((n) => n.uploaded).map((n) => n.id)).toEqual([vid(3), vid(4)]);
    expect(t).toMatchObject({ v: 1, docId: DOC, seq: 3, currentId: vid(4) });
  });

  it('copies allowlisted fields only: no clarifying input, sources, questions, model or job ids leak', () => {
    const meta = leakyMeta();
    const entry = buildDocEntry({
      entry: { id: DOC, title: meta.title, summary: meta.summary, createdAt: TS, updatedAt: TS },
      meta,
      current: { versionId: vid(2), sha: sha(2), sizeBytes: 1234, headings: ['Overview', '  Pricing   history '] },
      placement: { kind: 'folder', folderId: 'f-0a1b2c3d' },
      busy: true,
      fallbackTime: TS,
    });
    const m = buildManifest({
      seq: 1,
      generatedAt: TS,
      folders: [{ id: 'f-0a1b2c3d', name: 'Work' }],
      docs: [entry],
    });
    expect(LibraryManifestSchema.safeParse(m).success).toBe(true);
    const askTree = tree(2);
    askTree.nodes[1] = node(2, { kind: 'ask', heading: 'Pricing', question: meta.asks![0]!.question });
    const t = buildTree({ docId: DOC, seq: 1, tree: askTree, uploaded: new Set(), fallbackTime: TS });
    const wire = JSON.stringify(m) + JSON.stringify(t);
    expect(wire).not.toContain('LEAK');
    expect(wire).not.toContain('intranet');
    expect(m.docs[0]).toEqual({
      docId: DOC,
      title: meta.title,
      summary: meta.summary,
      headings: ['Overview', 'Pricing history'],
      tabs: ['indepth', 'eli5'],
      createdAt: TS,
      updatedAt: TS,
      placement: { kind: 'folder', folderId: 'f-0a1b2c3d' },
      currentVersionId: vid(2),
      currentSha: sha(2),
      sizeBytes: 1234,
      busy: true,
    });
    expect(Object.keys(m.docs[0]!).sort()).toEqual(
      [
        'busy',
        'createdAt',
        'currentSha',
        'currentVersionId',
        'docId',
        'headings',
        'placement',
        'sizeBytes',
        'summary',
        'tabs',
        'title',
        'updatedAt',
      ].sort(),
    );
  });

  it('omits the ASD-STE100 tab key, which 0.3.0 phones do not parse (16 §4.4, D21)', () => {
    const meta = leakyMeta();
    meta.tabs = [
      { key: 'indepth', kind: 'indepth', label: 'In depth', sectionCount: 4, createdAt: TS },
      { key: 'eli5', kind: 'eli5', label: 'ELI5', sectionCount: 3, createdAt: TS },
      { key: 'ste', kind: 'ste', label: 'ASD-STE100', sectionCount: 4, createdAt: TS },
      { key: 'sx0a1b2c', kind: 'section-eli5', label: 'ELI5: Pricing', sectionCount: 1, createdAt: TS },
    ];
    const entry = buildDocEntry({
      entry: { id: DOC, title: meta.title, summary: meta.summary, createdAt: TS, updatedAt: TS },
      meta,
      current: { versionId: vid(1), sha: sha(1), sizeBytes: 1, headings: [] },
      placement: { kind: 'unfiled' },
      busy: false,
      fallbackTime: TS,
    });
    expect(entry.tabs).toEqual(['indepth', 'eli5', 'sx0a1b2c']);
    const m = buildManifest({ seq: 1, generatedAt: TS, folders: [], docs: [entry] });
    expect(LibraryManifestSchema.safeParse(m).success).toBe(true);
  });

  it('sets replaces only for a different id, and unfiles a placement whose folder is gone', () => {
    const meta = leakyMeta();
    const base = {
      entry: { id: DOC, title: 't', summary: '', createdAt: TS, updatedAt: TS },
      meta,
      current: { versionId: vid(1), sha: sha(1), sizeBytes: 1, headings: [] },
      busy: false,
      fallbackTime: TS,
    };
    expect(buildDocEntry({ ...base, placement: { kind: 'unfiled' }, replaces: DOC }).replaces).toBeUndefined();
    const other = '00000000-0000-4000-8000-000000000001';
    expect(buildDocEntry({ ...base, placement: { kind: 'unfiled' }, replaces: other }).replaces).toBe(other);
    const m = buildManifest({
      seq: 2,
      generatedAt: TS,
      folders: [],
      docs: [buildDocEntry({ ...base, placement: { kind: 'folder', folderId: 'f-deadbeef' } })],
    });
    expect(m.docs[0]!.placement).toEqual({ kind: 'unfiled' });
  });

  it('places documents from the organization view', () => {
    const org = {
      folders: [{ id: 'f-0a1b2c3d' as const, name: 'Work', createdAt: TS }],
      placement: { a: 'archive' as const, b: 'f-0a1b2c3d' as const, c: 'f-ffffffff' as const },
    };
    expect(placementOf(org, 'a')).toEqual({ kind: 'archive' });
    expect(placementOf(org, 'b')).toEqual({ kind: 'folder', folderId: 'f-0a1b2c3d' });
    expect(placementOf(org, 'c')).toEqual({ kind: 'unfiled' });
    expect(placementOf(org, 'd')).toEqual({ kind: 'unfiled' });
  });
});
