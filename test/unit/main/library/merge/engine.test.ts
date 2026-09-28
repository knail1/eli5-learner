import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  LibraryError,
  MERGE_FAILED_MESSAGE,
  MERGE_INELIGIBLE_MESSAGE,
  SuggestionsFileSchema,
  createMergeSuggestions,
  type AppendMerged,
  type CatalogEntry,
  type DocumentMeta,
  type FsLibrary,
  type LibraryChangeReason,
  type MergeJudge,
  type MergeSuggestion,
  type MergeSuggestionsOptions,
  type SectionId,
  type SuggestionsFile,
} from '../../../../../src/main/library';
import type { MergeSuggestions } from '../../../../../src/main/ipc';
import { SeededIdSource } from '../../../../helpers/ids';
import { HTML, createDoc, testLibrary, uuid } from '../fixtures';

/**
 * Merge suggestions engine (09 §10.2-10.8, §13): state machine with a fake appendMergedDocument
 * and a fake matchMerge. Synthetic "Example Widgets Inc." documents only.
 */

const MARKER = 'sec-indepth-0000abcd' as SectionId;
const MERGED_HTML = '<!doctype html><html><body>merged Example Widgets Inc.</body></html>\n';

const fakeAppend: AppendMerged = (input) => ({
  html: MERGED_HTML,
  tabs: [
    ...input.targetMeta.tabs,
    { key: 'sx0a0b0c', kind: 'section-eli5', label: 'ELI5: Returns', sectionCount: 2, createdAt: input.mergedAt },
  ],
  markerSectionIds: [MARKER],
  idMap: {},
});

type Judge = MergeJudge & ReturnType<typeof vi.fn>;

function judgeReturning(
  matches: (all: { catalogId: string }[]) => { catalogId: string; score: number; reason: string }[],
): Judge {
  return vi.fn(async (_summary: string, candidates: { catalogId: string }[]) => ({
    matches: matches(candidates),
  })) as Judge;
}

const expectCode = async (p: Promise<unknown>, code: string): Promise<void> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LibraryError);
  expect((err as LibraryError).code).toBe(code);
};

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

const readSuggestions = async (lib: FsLibrary): Promise<SuggestionsFile> =>
  SuggestionsFileSchema.parse(JSON.parse(await readFile(path.join(lib.root, '.eli5', 'suggestions.json'), 'utf8')));

interface Setup {
  lib: FsLibrary;
  open: Awaited<ReturnType<typeof testLibrary>>['open'];
  clock: Awaited<ReturnType<typeof testLibrary>>['clock'];
  target: CatalogEntry;
  source: CatalogEntry;
  other: CatalogEntry;
}

/** Target (older, related), an unrelated document, then the new source document. */
async function setup(): Promise<Setup> {
  const t = await testLibrary();
  const target = await createDoc(t.lib, 'Widget ad spend and ROAS', {
    summary: 'How Example Widgets Inc. measures return on ad spend across widget campaigns.',
    createdAt: '2026-01-01T00:00:00.000Z',
    sourcesUsed: [{ ref: 'widget-ads.pdf', kind: 'file' }],
  });
  const other = await createDoc(t.lib, 'Office plants', {
    summary: 'Which plants survive in a dim office.',
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  const source = await createDoc(t.lib, 'ROAS for widget ads', {
    summary: 'Return on ad spend for Example Widgets Inc. widget campaigns.',
    createdAt: '2026-01-03T00:00:00.000Z',
    sourcesUsed: [
      { ref: 'widget-ads.pdf', kind: 'file' },
      { ref: 'https://www.example.com/widgets/roas', kind: 'url' },
    ],
    sourcesSkipped: [
      { ref: 'https://portal.example.com/login', reason: 'Page required login.', code: 'login-required' },
    ],
  });
  return { lib: t.lib, open: t.open, clock: t.clock, target, source, other };
}

function engine(s: Setup, over: Partial<MergeSuggestionsOptions> = {}) {
  const judge =
    (over.judge as Judge | undefined) ??
    judgeReturning((c) =>
      c.map((x) => ({ catalogId: x.catalogId, score: x.catalogId === s.target.id ? 0.9 : 0.2, reason: 'Same topic.' })),
    );
  const h = createMergeSuggestions({
    library: s.lib,
    judge,
    appendMerged: fakeAppend,
    clock: s.clock,
    ids: new SeededIdSource(11),
    judgeTimeoutMs: 50,
    ...over,
  });
  return { h, judge };
}

/** A pending suggestion source -> target. */
async function suggested(s: Setup, over: Partial<MergeSuggestionsOptions> = {}) {
  const e = engine(s, over);
  const sug = await e.h.runMergeCheck(s.source.id);
  if (!sug) throw new Error('fixture: no suggestion');
  return { ...e, sug };
}

describe('runMergeCheck (09 §10.2)', () => {
  it('suggests the related document, persists it and emits on both channels', async () => {
    const s = await setup();
    const { h, judge } = engine(s);
    const changed: MergeSuggestion[][] = [];
    const pending: MergeSuggestion[][] = [];
    h.service.onChanged((l) => changed.push(l));
    s.lib.on('suggestions', (l) => pending.push(l));
    await h.ready;
    changed.length = 0;
    pending.length = 0;

    const sug = await h.runMergeCheck(s.source.id);
    expect(sug).toMatchObject({
      status: 'pending',
      source: { id: s.source.id, slug: s.source.topicSlug, title: s.source.title },
      target: { id: s.target.id, slug: s.target.topicSlug, title: s.target.title },
      score: 0.9,
      reason: 'Same topic.',
      scorer: 'lexical+llm',
      createdAt: s.clock.now().toISOString(),
    });
    expect(sug?.id).toMatch(/^[0-9a-f-]{36}$/);
    // Judge input: "<title>: <summary>" and candidate catalog fields only.
    const [summary, candidates] = judge.mock.calls[0] as [
      string,
      { catalogId: string; title: string; summary: string }[],
    ];
    expect(summary).toBe(`${s.source.title}: ${s.source.summary}`);
    expect(candidates[0]).toEqual({ catalogId: s.target.id, title: s.target.title, summary: s.target.summary });
    expect(candidates.map((c) => c.catalogId)).not.toContain(s.source.id);
    expect(candidates.map((c) => c.catalogId)).not.toContain(s.other.id); // below PREFILTER_MIN

    const file = await readSuggestions(s.lib);
    expect(file.suggestions).toEqual([sug]);
    expect(changed.at(-1)).toEqual([sug]);
    expect(pending.at(-1)).toEqual([sug]);
    expect(await h.service.list()).toEqual([sug]);
    expect(s.lib.suggestions()).toEqual([sug]);
  });

  it('provides the MergeSuggestions IPC service (src/main/ipc/suggestions.ts)', async () => {
    const s = await setup();
    const svc: MergeSuggestions = engine(s).h.service;
    expect(await svc.list()).toEqual([]);
  });

  it('is what FsLibrary.runMergeCheck delegates to once attached', async () => {
    const s = await setup();
    expect(await s.lib.runMergeCheck(s.source.id)).toBeNull();
    engine(s);
    expect((await s.lib.runMergeCheck(s.source.id))?.target.id).toBe(s.target.id);
  });

  it('makes no LLM call when the corpus is empty or nothing passes the prefilter', async () => {
    const t = await testLibrary();
    const only = await createDoc(t.lib, 'Widget pricing');
    const judge = judgeReturning(() => []);
    const h = createMergeSuggestions({ library: t.lib, judge, appendMerged: fakeAppend });
    expect(await h.runMergeCheck(only.id)).toBeNull();
    await createDoc(t.lib, 'Office plants', { summary: 'Plants in a dim office.' });
    expect(await h.runMergeCheck(only.id)).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it('needs a score of at least 0.75, clamps scores, discards unknown ids and caps the reason', async () => {
    const s = await setup();
    const low = engine(s, { judge: judgeReturning((c) => c.map((x) => ({ ...x, score: 0.74, reason: 'close' }))) });
    expect(await low.h.runMergeCheck(s.source.id)).toBeNull();
    low.h.dispose();

    const odd = engine(s, {
      judge: judgeReturning((c) => [
        { catalogId: uuid(), score: 1, reason: 'not a candidate' },
        { catalogId: s.source.id, score: 1, reason: 'itself' },
        ...c.map((x) => ({ catalogId: x.catalogId, score: 7, reason: 'x'.repeat(500) })),
      ]),
    });
    const sug = await odd.h.runMergeCheck(s.source.id);
    expect(sug?.target.id).toBe(s.target.id);
    expect(sug?.score).toBe(1);
    expect(sug?.reason).toHaveLength(200);
  });

  it('breaks score ties in favour of the newer document', async () => {
    const t = await testLibrary();
    const older = await createDoc(t.lib, 'Widget returns policy', {
      summary: 'Widget returns and refunds at Example Widgets Inc.',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = await createDoc(t.lib, 'Widget returns process', {
      summary: 'Widget returns and refunds at Example Widgets Inc.',
      createdAt: '2026-01-05T00:00:00.000Z',
    });
    const fresh = await createDoc(t.lib, 'Widget returns and refunds', {
      summary: 'Widget returns and refunds at Example Widgets Inc.',
      createdAt: '2026-01-09T00:00:00.000Z',
    });
    const h = createMergeSuggestions({
      library: t.lib,
      judge: judgeReturning((c) => c.map((x) => ({ ...x, score: 0.8, reason: 'r' }))),
      appendMerged: fakeAppend,
    });
    expect((await h.runMergeCheck(fresh.id))?.target.id).toBe(newer.id);
    expect(older.id).not.toBe(newer.id);
  });

  it('makes no suggestion when the judge fails or times out, and logs no content', async () => {
    const s = await setup();
    const warn = vi.fn();
    const logger = { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn };
    const failing = engine(s, {
      logger,
      judge: vi.fn(async () => {
        throw Object.assign(new Error('rate limited: secret prompt text'), { kind: 'rate_limit' });
      }) as Judge,
    });
    expect(await failing.h.runMergeCheck(s.source.id)).toBeNull();
    failing.h.dispose();
    const hanging = engine(s, { logger, judge: vi.fn(() => new Promise(() => {})) as unknown as Judge });
    expect(await hanging.h.runMergeCheck(s.source.id)).toBeNull();
    expect(await hanging.h.service.list()).toEqual([]);
    expect(warn).toHaveBeenCalledWith('merge.judge-failed', { errorKind: 'rate_limit' });
    expect(warn).toHaveBeenCalledWith('merge.judge-failed', { errorKind: 'timeout' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });

  it('applies HOOK-LIB-02 eligibility to the top candidates with their meta.json', async () => {
    const s = await setup();
    const eligibility = vi.fn((a: DocumentMeta, b: DocumentMeta) => a.id === b.id);
    const { h, judge } = engine(s, { eligibility });
    expect(await h.runMergeCheck(s.source.id)).toBeNull();
    expect(judge).not.toHaveBeenCalled();
    const [a, b] = eligibility.mock.calls[0] as [DocumentMeta, DocumentMeta];
    expect(a.id).toBe(s.source.id);
    expect(b.id).toBe(s.target.id);
    expect(a.sourcesUsed.length).toBeGreaterThan(0);
  });

  it('stops in read-only mode and for unknown documents', async () => {
    const s = await setup();
    const { h, judge } = engine(s);
    expect(await h.runMergeCheck(uuid())).toBeNull();
    s.lib.enterReadOnly('locked');
    expect(await h.runMergeCheck(s.source.id)).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it('posts at most one suggestion per new document', async () => {
    const s = await setup();
    const { h } = engine(s);
    expect(await h.runMergeCheck(s.source.id)).not.toBeNull();
    expect(await h.runMergeCheck(s.source.id)).toBeNull();
    expect(await h.service.list()).toHaveLength(1);
  });

  it('discards the result when a document left the Library while the judge ran (step 8)', async () => {
    const s = await setup();
    const judge = vi.fn(async (_s: string, c: { catalogId: string }[]) => {
      await s.lib.trashDocument(s.target.topicSlug);
      return { matches: c.map((x) => ({ catalogId: x.catalogId, score: 0.95, reason: 'r' })) };
    }) as Judge;
    const { h } = engine(s, { judge });
    expect(await h.runMergeCheck(s.source.id)).toBeNull();
    expect(await h.service.list()).toEqual([]);
  });

  it('skips documents involved in an accepting suggestion', async () => {
    const s = await setup();
    const { h, sug, judge } = await suggested(s);
    let release!: () => void;
    const hold = s.lib.withDocLock(s.target.topicSlug, () => new Promise<void>((r) => (release = r)));
    const accepting = h.service.accept(sug.id);
    await vi.waitFor(async () => expect((await h.service.list())[0]?.status).toBe('accepting'));
    const third = await createDoc(s.lib, 'Widget ROAS by channel', {
      summary: 'Return on ad spend for Example Widgets Inc. widget campaigns by channel.',
    });
    judge.mockClear();
    await h.runMergeCheck(third.id);
    for (const call of judge.mock.calls) {
      const ids = (call[1] as { catalogId: string }[]).map((c) => c.catalogId);
      expect(ids).not.toContain(s.target.id);
      expect(ids).not.toContain(s.source.id);
    }
    release();
    await hold;
    await accepting;
  });
});

describe('accept (09 §10.6)', () => {
  it('appends to the target, trashes the source, updates catalog and suggestions, and emits', async () => {
    const s = await setup();
    const { h, sug } = await suggested(s);
    // A second pending suggestion that also involves the source goes stale on accept.
    const extra = await createDoc(s.lib, 'Widget ROAS by channel', {
      summary: 'Return on ad spend for Example Widgets Inc. widget campaigns by channel.',
    });
    const file = await readSuggestions(s.lib);
    file.suggestions.push({
      ...sug,
      id: uuid(),
      source: { id: extra.id, slug: extra.topicSlug, title: extra.title },
      target: sug.source,
    });
    await writeFile(path.join(s.lib.root, '.eli5', 'suggestions.json'), JSON.stringify(file));
    const reopened = await s.open();
    const r = createMergeSuggestions({
      library: reopened,
      judge: vi.fn() as unknown as MergeJudge,
      appendMerged: fakeAppend,
      clock: s.clock,
    });
    await r.ready;
    h.dispose();

    const changes: { reason: LibraryChangeReason; slugs: string[] }[] = [];
    reopened.on('changed', (e) => changes.push(e));
    const docUpdated = vi.fn();
    r.service.onDocUpdated(docUpdated);
    const statuses: string[] = [];
    r.service.onChanged((l) =>
      statuses.push(l.map((x) => `${x.id === sug.id ? 'main' : 'other'}:${x.status}`).join(',')),
    );
    s.clock.advance(60_000);

    await expect(r.service.accept(sug.id)).resolves.toEqual({ targetSlug: s.target.topicSlug });

    // Target files: merged index.html and the committed meta.json.
    const root = reopened.root;
    expect(await readFile(path.join(root, s.target.topicSlug, 'index.html'), 'utf8')).toBe(MERGED_HTML);
    const meta = await reopened.getMeta(s.target.topicSlug);
    expect(meta.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5', 'sx0a0b0c']);
    expect(meta.merges).toEqual([
      {
        suggestionId: sug.id,
        sourceDocId: s.source.id,
        sourceTitle: s.source.title,
        sourceSlug: s.source.topicSlug,
        sourceSummary: s.source.summary,
        mergedAt: s.clock.now().toISOString(),
        anchorSectionIds: [MARKER],
      },
    ]);
    expect(meta.sourcesUsed).toEqual([
      { ref: 'widget-ads.pdf', kind: 'file' },
      { ref: 'https://www.example.com/widgets/roas', kind: 'url', origin: `merge:${s.source.id}` },
    ]);
    expect(meta.sourcesSkipped.map((x) => x.ref)).toEqual(['https://portal.example.com/login']);
    expect(meta.title).toBe(s.target.title);
    expect(meta.summary).toBe(s.target.summary);
    expect(meta.createdAt).toBe(s.target.createdAt);

    // Source folder in .trash, pre-merge backup of the target next to it.
    expect(await exists(path.join(root, s.source.topicSlug))).toBe(false);
    const trash = await readdir(path.join(root, '.trash'));
    expect(trash.some((n) => n.startsWith(`${s.source.topicSlug}--`))).toBe(true);
    const backup = trash.find((n) => n.startsWith(`${s.target.topicSlug}--`) && n.endsWith('-premerge'));
    expect(backup).toBeDefined();
    expect(await readFile(path.join(root, '.trash', backup ?? '', 'index.html'), 'utf8')).toBe(HTML);

    // Catalog: source gone, target updated.
    expect(reopened.getEntry(s.source.id)).toBeUndefined();
    const entry = reopened.getEntry(s.target.id);
    expect(entry).toMatchObject({ mergedFromCount: 1, tabCount: 3, createdAt: s.target.createdAt });
    expect(entry?.updatedAt).toBe(s.clock.now().toISOString());
    expect(reopened.recents().map((e) => e.id)).not.toContain(s.source.id);

    // Suggestions: accepted, the other one stale; nothing open is left.
    const after = await readSuggestions(reopened);
    expect(after.suggestions.find((x) => x.id === sug.id)).toMatchObject({
      status: 'accepted',
      resolvedAt: s.clock.now().toISOString(),
    });
    expect(after.suggestions.find((x) => x.id !== sug.id)?.status).toBe('stale');
    expect(await r.service.list()).toEqual([]);
    expect(statuses[0]).toContain('main:accepting');
    expect(statuses.at(-1)).toBe('');

    expect(changes).toContainEqual({ reason: 'merged', slugs: [s.target.topicSlug, s.source.topicSlug] });
    expect(docUpdated).toHaveBeenCalledWith({ slug: s.target.topicSlug, sectionId: MARKER, tabKey: 'indepth' });
  });

  it('refuses a suggestion that is not pending with SUGGESTION_STALE', async () => {
    const s = await setup();
    const { h, sug } = await suggested(s);
    await expectCode(h.service.accept(uuid()), 'SUGGESTION_STALE');
    await h.service.dismiss(sug.id);
    await expectCode(h.service.accept(sug.id), 'SUGGESTION_STALE');
  });

  it('leaves both documents unchanged and the suggestion pending with lastError on a merge failure', async () => {
    const s = await setup();
    const { h, sug } = await suggested(s, {
      appendMerged: () => {
        throw new Error('bad model');
      },
    });
    const beforeMeta = await readFile(path.join(s.lib.root, s.target.topicSlug, 'meta.json'), 'utf8');
    await expectCode(h.service.accept(sug.id), 'MERGE_FAILED');
    expect(await readFile(path.join(s.lib.root, s.target.topicSlug, 'meta.json'), 'utf8')).toBe(beforeMeta);
    expect(await readFile(path.join(s.lib.root, s.target.topicSlug, 'index.html'), 'utf8')).toBe(HTML);
    expect(await exists(path.join(s.lib.root, s.source.topicSlug, 'index.html'))).toBe(true);
    expect(s.lib.getEntry(s.source.id)).toBeDefined();
    const [open] = await h.service.list();
    expect(open).toMatchObject({ id: sug.id, status: 'pending', lastError: MERGE_FAILED_MESSAGE });
  });

  it('keeps the suggestion pending with the ineligible message when HOOK-LIB-02 refuses at accept', async () => {
    const s = await setup();
    let allow = true;
    const { h, sug } = await suggested(s, { eligibility: () => allow });
    allow = false;
    await expectCode(h.service.accept(sug.id), 'MERGE_FAILED');
    expect((await h.service.list())[0]).toMatchObject({ status: 'pending', lastError: MERGE_INELIGIBLE_MESSAGE });
    // A later success clears lastError.
    allow = true;
    await h.service.accept(sug.id);
    expect((await readSuggestions(s.lib)).suggestions[0]?.lastError).toBeUndefined();
  });

  it('marks the suggestion stale when a document is gone', async () => {
    const s = await setup();
    const { h, sug } = await suggested(s);
    await s.lib.trashDocument(s.source.topicSlug);
    await expectCode(h.service.accept(sug.id), 'SUGGESTION_STALE');
    await vi.waitFor(async () => expect((await readSuggestions(s.lib)).suggestions[0]?.status).toBe('stale'));
    expect(await h.service.list()).toEqual([]);
  });

  it('refuses accept and dismiss in read-only mode', async () => {
    const s = await setup();
    const { h, sug } = await suggested(s);
    s.lib.enterReadOnly('locked');
    await expectCode(h.service.accept(sug.id), 'LIBRARY_READ_ONLY');
    await expectCode(h.service.dismiss(sug.id), 'LIBRARY_READ_ONLY');
    expect((await h.service.list())[0]?.status).toBe('pending');
  });

  it('waits for a running section job on the target (withDocLock)', async () => {
    const s = await setup();
    const { h, sug } = await suggested(s);
    let release!: () => void;
    const job = s.lib.withDocLock(s.target.topicSlug, () => new Promise<void>((r) => (release = r)));
    let done = false;
    const p = h.service.accept(sug.id).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    expect((await h.service.list())[0]?.status).toBe('accepting');
    release();
    await job;
    await p;
    expect(done).toBe(true);
  });
});

describe('dismiss (09 §10.7)', () => {
  it('keeps both documents, records the pair and never suggests it again', async () => {
    const s = await setup();
    const { h, sug, judge } = await suggested(s);
    const pairs = [s.source.id, s.target.id].sort();
    await h.service.dismiss(sug.id);
    const file = await readSuggestions(s.lib);
    expect(file.suggestions[0]).toMatchObject({ status: 'dismissed', resolvedAt: s.clock.now().toISOString() });
    expect(file.dismissedPairs).toEqual([{ a: pairs[0], b: pairs[1], at: s.clock.now().toISOString() }]);
    expect(s.lib.getEntry(s.source.id)).toBeDefined();
    expect(s.lib.getEntry(s.target.id)).toBeDefined();
    expect(await h.service.list()).toEqual([]);
    judge.mockClear();
    expect(await h.runMergeCheck(s.source.id)).toBeNull();
    for (const call of judge.mock.calls) {
      expect((call[1] as { catalogId: string }[]).map((c) => c.catalogId)).not.toContain(s.target.id);
    }
    // No-op for a suggestion that is not pending.
    await h.service.dismiss(sug.id);
    expect((await readSuggestions(s.lib)).dismissedPairs).toHaveLength(1);
  });
});

describe('persistence and recovery (09 §10.5, §10.8)', () => {
  const write = (lib: FsLibrary, f: SuggestionsFile) =>
    writeFile(path.join(lib.root, '.eli5', 'suggestions.json'), JSON.stringify(f, null, 2));

  it('keeps pending suggestions across restarts', async () => {
    const s = await setup();
    const { sug } = await suggested(s);
    const lib2 = await s.open();
    const h2 = createMergeSuggestions({ library: lib2, judge: vi.fn() as unknown as MergeJudge });
    expect(await h2.service.list()).toEqual([sug]);
    expect(lib2.suggestions()).toEqual([sug]);
  });

  it('marks a pending suggestion stale when a document is missing at startup, and when one is removed later', async () => {
    const s = await setup();
    const { h, sug } = await suggested(s);
    h.dispose();
    await write(s.lib, {
      schemaVersion: 1,
      suggestions: [sug, { ...sug, id: uuid(), target: { id: uuid(), slug: 'gone', title: 'Gone' } }],
      dismissedPairs: [],
    });
    const h2 = createMergeSuggestions({ library: s.lib, judge: vi.fn() as unknown as MergeJudge, clock: s.clock });
    expect((await h2.service.list()).map((x) => x.id)).toEqual([sug.id]);
    const onChanged = vi.fn();
    h2.service.onChanged(onChanged);
    await s.lib.trashDocument(s.target.topicSlug);
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith([]));
    expect((await readSuggestions(s.lib)).suggestions.every((x) => x.status === 'stale')).toBe(true);
  });

  it('rolls an uncommitted accepting suggestion back to pending', async () => {
    const s = await setup();
    const { h, sug } = await suggested(s);
    h.dispose();
    await write(s.lib, { schemaVersion: 1, suggestions: [{ ...sug, status: 'accepting' }], dismissedPairs: [] });
    const h2 = createMergeSuggestions({ library: s.lib, judge: vi.fn() as unknown as MergeJudge });
    expect(await h2.service.list()).toEqual([{ ...sug, status: 'pending' }]);
    expect(s.lib.getEntry(s.source.id)).toBeDefined();
  });

  it('finishes a committed accept idempotently', async () => {
    const s = await setup();
    const { h, sug } = await suggested(s);
    h.dispose();
    // Commit point reached (meta.json has the MergeRecord), crash before steps 8-10.
    await s.lib.withDocLock(s.target.topicSlug, () =>
      s.lib.writeDocumentFiles(s.target.topicSlug, {
        html: MERGED_HTML,
        meta: (m) => ({
          ...m,
          merges: [
            {
              suggestionId: sug.id,
              sourceDocId: s.source.id,
              sourceTitle: s.source.title,
              sourceSlug: s.source.topicSlug,
              sourceSummary: s.source.summary,
              mergedAt: s.clock.now().toISOString(),
              anchorSectionIds: [MARKER],
            },
          ],
        }),
      }),
    );
    await write(s.lib, { schemaVersion: 1, suggestions: [{ ...sug, status: 'accepting' }], dismissedPairs: [] });
    const lib2 = await s.open();
    const h2 = createMergeSuggestions({ library: lib2, judge: vi.fn() as unknown as MergeJudge });
    await h2.ready;
    expect(await h2.service.list()).toEqual([]);
    expect((await readSuggestions(lib2)).suggestions[0]?.status).toBe('accepted');
    expect(lib2.getEntry(s.source.id)).toBeUndefined();
    expect(lib2.getEntry(s.target.id)?.mergedFromCount).toBe(1);
    expect(await exists(path.join(lib2.root, s.source.topicSlug))).toBe(false);

    // Crash after the source folder moved: reconcile drops the entry, recovery skips the rename.
    const t = await setup();
    const e = await suggested(t);
    e.h.dispose();
    await t.lib.withDocLock(t.target.topicSlug, () =>
      t.lib.writeDocumentFiles(t.target.topicSlug, {
        meta: (m) => ({
          ...m,
          merges: [
            {
              suggestionId: e.sug.id,
              sourceDocId: t.source.id,
              sourceTitle: t.source.title,
              sourceSlug: t.source.topicSlug,
              sourceSummary: t.source.summary,
              mergedAt: t.clock.now().toISOString(),
              anchorSectionIds: [MARKER],
            },
          ],
        }),
      }),
    );
    await t.lib.moveToTrash(path.join(t.lib.root, t.source.topicSlug), t.source.topicSlug);
    await write(t.lib, { schemaVersion: 1, suggestions: [{ ...e.sug, status: 'accepting' }], dismissedPairs: [] });
    const lib3 = await t.open();
    const h3 = createMergeSuggestions({ library: lib3, judge: vi.fn() as unknown as MergeJudge });
    await h3.ready;
    expect((await readSuggestions(lib3)).suggestions[0]?.status).toBe('accepted');
    expect(lib3.getEntry(t.target.id)?.mergedFromCount).toBe(1);
  });

  it('prunes resolved suggestions after the retention period and pairs of departed documents', async () => {
    const s = await setup();
    const { h, sug } = await suggested(s);
    h.dispose();
    const old = '2025-01-01T00:00:00.000Z';
    await write(s.lib, {
      schemaVersion: 1,
      suggestions: [
        { ...sug, id: uuid(), status: 'dismissed', resolvedAt: old },
        { ...sug, id: uuid(), status: 'accepted', resolvedAt: s.clock.now().toISOString() },
        sug,
      ],
      dismissedPairs: [
        { a: s.other.id, b: s.target.id, at: old },
        { a: uuid(), b: s.target.id, at: old },
      ],
    });
    const h2 = createMergeSuggestions({
      library: s.lib,
      judge: vi.fn() as unknown as MergeJudge,
      clock: s.clock,
      retentionDays: 30,
    });
    await h2.ready;
    const f = await readSuggestions(s.lib);
    expect(f.suggestions.map((x) => x.status)).toEqual(['accepted', 'pending']);
    expect(f.dismissedPairs).toEqual([{ a: s.other.id, b: s.target.id, at: old }]);
  });

  it('starts empty from a corrupt file and goes read-only on a newer schema', async () => {
    const s = await setup();
    await writeFile(path.join(s.lib.root, '.eli5', 'suggestions.json'), '{not json');
    const h = createMergeSuggestions({ library: s.lib, judge: vi.fn() as unknown as MergeJudge, clock: s.clock });
    expect(await h.service.list()).toEqual([]);
    const names = await readdir(path.join(s.lib.root, '.eli5'));
    expect(names.some((n) => n.startsWith('suggestions.json.corrupt-'))).toBe(true);
    h.dispose();

    await mkdir(path.join(s.lib.root, '.eli5'), { recursive: true });
    await writeFile(
      path.join(s.lib.root, '.eli5', 'suggestions.json'),
      JSON.stringify({ schemaVersion: 2, suggestions: [], dismissedPairs: [] }),
    );
    const h2 = createMergeSuggestions({ library: s.lib, judge: vi.fn() as unknown as MergeJudge });
    await h2.ready;
    expect(s.lib.readOnly).toBe(true);
  });
});
