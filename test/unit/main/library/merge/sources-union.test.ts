/**
 * Merge accept step 7b (09 §4.4, §10.6, §10.8): the merged-away document's kept source text joins
 * the target's sidecar, best effort, idempotent, only after the commit. Synthetic documents only.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  SourceSidecarManifestSchema,
  createMergeSuggestions,
  type CatalogEntry,
  type FsLibrary,
  type MergeJudge,
  type MergeSuggestionsOptions,
  type SectionId,
  type SourceSidecarInput,
  type SourceSidecarManifest,
  type WeaveMerged,
} from '../../../../../src/main/library';
import { createLogger, MemorySink } from '../../../../../src/main/security';
import { SeededIdSource } from '../../../../helpers/ids';
import { createDoc, testLibrary } from '../fixtures';

const MARKER = 'sec-indepth-0000abcd' as SectionId;
const MERGED_HTML = '<!doctype html><html><body>merged Example Widgets Inc.</body></html>\n';
const fakeWeave: WeaveMerged = async (input) => ({
  html: MERGED_HTML,
  tabs: input.targetMeta.tabs,
  markerSectionIds: [MARKER],
  prompt: 'merge-weave@1',
});

const text = (ref: string, body: string, over: Partial<SourceSidecarInput> = {}): SourceSidecarInput => ({
  ref,
  label: ref,
  kind: 'file',
  mime: 'text/markdown',
  format: 'markdown',
  text: body,
  chars: body.length,
  extractTruncated: false,
  ...over,
});

const sidecarDir = (lib: FsLibrary, slug: string) => path.join(lib.root, slug, '.sources');
const manifest = async (dir: string): Promise<SourceSidecarManifest | undefined> => {
  const raw = await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8').catch(() => undefined);
  return raw === undefined ? undefined : SourceSidecarManifestSchema.parse(JSON.parse(raw));
};
const snapshot = async (dir: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const n of (await fsp.readdir(dir).catch(() => [] as string[])).sort())
    out[n] = createHash('sha256')
      .update(await fsp.readFile(path.join(dir, n)))
      .digest('hex');
  return out;
};

interface Setup {
  lib: FsLibrary;
  open: Awaited<ReturnType<typeof testLibrary>>['open'];
  sink: MemorySink;
  target: CatalogEntry;
  source: CatalogEntry;
}

async function setup(sidecars: { target?: SourceSidecarInput[]; source?: SourceSidecarInput[] }): Promise<Setup> {
  const sink = new MemorySink();
  const t = await testLibrary({ logger: createLogger({ sink, level: () => 'debug' }) });
  const target = await createDoc(t.lib, 'Widget ad spend and ROAS', {
    summary: 'How Example Widgets Inc. measures return on ad spend across widget campaigns.',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  await createDoc(t.lib, 'Office plants', {
    summary: 'Which plants survive in a dim office.',
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  const source = await createDoc(t.lib, 'ROAS for widget ads', {
    summary: 'Return on ad spend for Example Widgets Inc. widget campaigns.',
    createdAt: '2026-01-03T00:00:00.000Z',
  });
  for (const [e, inputs] of [
    [target, sidecars.target],
    [source, sidecars.source],
  ] as const) {
    if (inputs) await t.lib.withDocLock(e.topicSlug, () => t.lib.upsertSources(e.topicSlug, inputs));
  }
  return { lib: t.lib, open: t.open, sink, target, source };
}

function engine(s: Setup, over: Partial<MergeSuggestionsOptions> = {}) {
  const judge = vi.fn(async (_x: string, c: { catalogId: string }[]) => ({
    matches: c.map((x) => ({
      catalogId: x.catalogId,
      score: x.catalogId === s.target.id ? 0.9 : 0.2,
      reason: 'Same topic.',
    })),
  })) as unknown as MergeJudge;
  return createMergeSuggestions({
    library: s.lib,
    judge,
    weaveMerged: fakeWeave,
    ids: new SeededIdSource(11),
    judgeTimeoutMs: 50,
    logger: createLogger({ sink: s.sink, level: () => 'debug' }),
    ...over,
  });
}

async function accept(s: Setup, over: Partial<MergeSuggestionsOptions> = {}) {
  const h = engine(s, over);
  const sug = await h.runMergeCheck(s.source.id);
  if (!sug) throw new Error('fixture: no suggestion');
  const r = await h.service.accept(sug.id).then(
    (x) => x,
    (e: unknown) => e,
  );
  return { h, sug, r };
}

describe('merge accept step 7b', () => {
  it('appends the source texts the target lacks, tagged with the merge origin', async () => {
    const s = await setup({
      target: [text('shared.md', 'Shared widget fact')],
      source: [
        text('shared.md', 'Shared widget fact'),
        text('returns.md', 'Widget returns', { origin: 'merge:00000000-0000-4000-8000-0000000000aa' }),
        text('chart.png', '', { text: null, format: 'png', mime: 'image/png' }),
      ],
    });
    const { r } = await accept(s);
    expect(r).toEqual({ targetSlug: s.target.topicSlug });
    const m = await manifest(sidecarDir(s.lib, s.target.topicSlug));
    expect(m?.sources.map((e) => [e.id, e.ref, e.stored, e.origin])).toEqual([
      ['src-01', 'shared.md', 'text', undefined],
      ['src-02', 'returns.md', 'text', `merge:${s.source.id}`],
      ['src-03', 'chart.png', 'image', `merge:${s.source.id}`],
    ]);
    expect((await s.lib.readSources(s.target.topicSlug))?.texts).toEqual({
      'src-01': 'Shared widget fact',
      'src-02': 'Widget returns',
    });
    // The merged-away document went to the Trash with its own sidecar.
    const trashId = (await fsp.readdir(path.join(s.lib.root, '.trash'))).find(
      (n) => n.startsWith(`${s.source.topicSlug}--`) && !n.includes('premerge'),
    );
    expect(await manifest(path.join(s.lib.root, '.trash', trashId ?? '', '.sources'))).toBeDefined();
  });

  it('source only: the target gets a sidecar; neither: none is created; target only: untouched', async () => {
    const a = await setup({ source: [text('returns.md', 'Widget returns')] });
    await accept(a);
    expect((await manifest(sidecarDir(a.lib, a.target.topicSlug)))?.sources).toHaveLength(1);

    const b = await setup({});
    await accept(b);
    expect(await fsp.lstat(sidecarDir(b.lib, b.target.topicSlug)).catch(() => undefined)).toBeUndefined();

    const c = await setup({ target: [text('ads.md', 'Widget ads')] });
    const before = await snapshot(sidecarDir(c.lib, c.target.topicSlug));
    await accept(c);
    expect(await snapshot(sidecarDir(c.lib, c.target.topicSlug))).toEqual(before);
  });

  it('a union failure does not fail the merge', async () => {
    const s = await setup({ source: [text('returns.md', 'Widget returns')] });
    // A target `.sources` that is not a directory makes the union refuse.
    await fsp.writeFile(sidecarDir(s.lib, s.target.topicSlug), 'not a dir');
    const { r } = await accept(s);
    expect(r).toEqual({ targetSlug: s.target.topicSlug });
    expect(s.lib.getEntry(s.source.id)).toBeUndefined();
    expect(s.sink.entries().find((e) => e.event === 'merge.sources-union-failed')).toMatchObject({
      code: 'WRITE_FAILED',
    });
  });

  it('a failed (uncommitted) accept leaves the target sidecar untouched', async () => {
    const s = await setup({ target: [text('ads.md', 'Widget ads')], source: [text('returns.md', 'Widget returns')] });
    const before = await snapshot(sidecarDir(s.lib, s.target.topicSlug));
    const { r } = await accept(s, { weaveMerged: () => Promise.reject(new Error('weave failed')) });
    expect(r).toBeInstanceOf(Error);
    expect(await snapshot(sidecarDir(s.lib, s.target.topicSlug))).toEqual(before);
    expect(s.lib.getEntry(s.source.id)).toBeDefined();
  });

  it('Put Back of the merged-away document brings back its own sidecar', async () => {
    const s = await setup({ source: [text('returns.md', 'Widget returns')] });
    const before = await snapshot(sidecarDir(s.lib, s.source.topicSlug));
    await accept(s);
    const trashId = (await fsp.readdir(path.join(s.lib.root, '.trash'))).find(
      (n) => n.startsWith(`${s.source.topicSlug}--`) && !n.includes('premerge'),
    );
    const { slug } = await s.lib.putBack(trashId ?? '');
    expect(await snapshot(sidecarDir(s.lib, slug))).toEqual(before);
  });
});

describe('recovery of a committed accept (09 §10.8)', () => {
  const commitOnly = async (s: Setup, suggestionId: string) =>
    s.lib.withDocLock(s.target.topicSlug, () =>
      s.lib.writeDocumentFiles(s.target.topicSlug, {
        html: MERGED_HTML,
        meta: (m) => ({
          ...m,
          merges: [
            {
              suggestionId,
              sourceDocId: s.source.id,
              sourceTitle: s.source.title,
              sourceSlug: s.source.topicSlug,
              sourceSummary: s.source.summary,
              mergedAt: '2026-02-01T00:00:00.000Z',
              anchorSectionIds: [MARKER],
            },
          ],
        }),
      }),
    );
  const writeAccepting = async (s: Setup, sug: object) =>
    fsp.writeFile(
      path.join(s.lib.root, '.eli5', 'suggestions.json'),
      JSON.stringify({ schemaVersion: 1, suggestions: [{ ...sug, status: 'accepting' }], dismissedPairs: [] }),
    );

  it('re-runs the union idempotently before trashing the source', async () => {
    const s = await setup({ target: [text('ads.md', 'Widget ads')], source: [text('returns.md', 'Widget returns')] });
    const h = engine(s);
    const sug = await h.runMergeCheck(s.source.id);
    if (!sug) throw new Error('fixture: no suggestion');
    h.dispose();
    await commitOnly(s, sug.id);
    // A crash after step 7b already ran once: the second run must not duplicate.
    await s.lib.withDocLocks([s.target.topicSlug, s.source.topicSlug], () =>
      s.lib.unionSourceSidecars(s.target.topicSlug, s.source.topicSlug, `merge:${s.source.id}`),
    );
    await writeAccepting(s, sug);
    const lib2 = await s.open();
    const h2 = createMergeSuggestions({ library: lib2, judge: vi.fn() as unknown as MergeJudge });
    await h2.ready;
    expect(lib2.getEntry(s.source.id)).toBeUndefined();
    const m = await manifest(sidecarDir(lib2, s.target.topicSlug));
    expect(m?.sources.map((e) => [e.ref, e.origin])).toEqual([
      ['ads.md', undefined],
      ['returns.md', `merge:${s.source.id}`],
    ]);
  });

  it('is a no-op when the source folder is already in the Trash', async () => {
    const s = await setup({ target: [text('ads.md', 'Widget ads')], source: [text('returns.md', 'Widget returns')] });
    const h = engine(s);
    const sug = await h.runMergeCheck(s.source.id);
    if (!sug) throw new Error('fixture: no suggestion');
    h.dispose();
    await commitOnly(s, sug.id);
    const before = await snapshot(sidecarDir(s.lib, s.target.topicSlug));
    await s.lib.moveToTrash(path.join(s.lib.root, s.source.topicSlug), s.source.topicSlug);
    await writeAccepting(s, sug);
    const lib2 = await s.open();
    const h2 = createMergeSuggestions({ library: lib2, judge: vi.fn() as unknown as MergeJudge });
    await h2.ready;
    expect(await snapshot(sidecarDir(lib2, s.target.topicSlug))).toEqual(before);
  });
});
