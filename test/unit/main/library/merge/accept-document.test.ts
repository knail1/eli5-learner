import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  parseDocument,
  weaveMergedDocument,
  type DocumentModel,
  type MergePlanner,
} from '../../../../../src/main/document';
import {
  createMergeSuggestions,
  quoteLabel,
  type DocumentMeta,
  type MergeJudge,
} from '../../../../../src/main/library';
import {
  MERGED_AT,
  MERGE_SOURCE_ID,
  MERGE_SOURCE_TITLE,
  MERGE_TARGET_ID,
  WEAVE_PLAN,
  mergeSource,
  mergeTarget,
} from '../../../../fixtures/documents/merge';
import { STUB_RUNTIME } from '../../../../fixtures/documents/runtime';
import { validateDocument } from '../../../../helpers/doc-validity';
import { SeededIdSource } from '../../../../helpers/ids';
import { makeMeta, testLibrary, writeDocFolder } from '../fixtures';

/** Accept end to end with the real woven merge and a mocked planner (09 §10.3, §10.6, §4.1). */

const tabsOf = (m: DocumentModel): DocumentMeta['tabs'] =>
  m.tabs.map((t) => ({
    key: t.key,
    kind: t.kind,
    label: t.label,
    sectionCount: t.sections.length,
    createdAt: MERGED_AT,
  }));

async function setup() {
  const { lib, clock } = await testLibrary();
  const target = mergeTarget();
  const source = mergeSource();
  const targetMeta = makeMeta({
    id: MERGE_TARGET_ID,
    topicSlug: 'widget-ad-spend',
    title: 'Widget ad spend',
    summary: 'Widget ad spend at Example Widgets Inc.: return on ad spend for widget campaigns.',
    createdAt: '2026-01-01T00:00:00.000Z',
    tabs: tabsOf(target.model),
    sourcesUsed: [{ ref: 'widget-sales-q3.pptx', kind: 'file' }],
  });
  const sourceMeta = makeMeta({
    id: MERGE_SOURCE_ID,
    topicSlug: 'widget-returns',
    title: MERGE_SOURCE_TITLE,
    summary: 'Widget returns at Example Widgets Inc.: return on ad spend net of refunds.',
    createdAt: '2026-01-02T00:00:00.000Z',
    tabs: tabsOf(source.model),
    sourcesUsed: [{ ref: 'https://www.example.org/widgets/returns', kind: 'url' }],
  });
  await writeDocFolder(lib.root, targetMeta, target.html);
  await writeDocFolder(lib.root, sourceMeta, source.html);
  await lib.reconcile();
  const judge = vi.fn(async (_s: string, c: { catalogId: string }[]) => ({
    matches: c.map((x) => ({ catalogId: x.catalogId, score: 0.92, reason: 'Both explain widget ROAS.' })),
  })) as unknown as MergeJudge;
  const planner = vi.fn(async () => ({ draft: WEAVE_PLAN, prompt: 'merge-weave@1' })) as MergePlanner &
    ReturnType<typeof vi.fn>;
  const h = createMergeSuggestions({
    library: lib,
    judge,
    clock,
    weaveMerged: (input) =>
      weaveMergedDocument(input, planner, { runtime: STUB_RUNTIME, idSource: new SeededIdSource(3) }),
  });
  return { lib, h, target, planner };
}

describe('accept with the woven merge (09 §10.6)', () => {
  it('writes a valid enhanced target whose meta matches, and opens it at the first enhanced section', async () => {
    const { lib, h, planner } = await setup();
    const sug = await h.runMergeCheck(MERGE_SOURCE_ID);
    expect(sug?.target.id).toBe(MERGE_TARGET_ID);
    const updated = vi.fn();
    h.service.onDocUpdated(updated);

    expect(await h.service.accept(sug?.id ?? '')).toEqual({ targetSlug: 'widget-ad-spend' });
    expect(planner).toHaveBeenCalledTimes(1);

    const html = await readFile(lib.docPath('widget-ad-spend'), 'utf8');
    const meta = await lib.getMeta('widget-ad-spend');
    expect(validateDocument(html, meta).errors).toEqual([]);
    const model = parseDocument(html).model;
    expect(model.docId).toBe(MERGE_TARGET_ID);
    expect(meta.tabs.map((t) => t.key)).toEqual(model.tabs.map((t) => t.key));
    expect(meta.tabs.map((t) => t.sectionCount)).toEqual(model.tabs.map((t) => t.sections.length));
    // Both tabs changed, with marks; no appended "Added from" block.
    expect(html).toContain('<ins class="enh" data-merge="m1"');
    expect(html).not.toContain('Added from:');
    expect(model.tabs[1]?.sections.some((s) => s.enh)).toBe(true);
    const first = meta.merges[0]?.anchorSectionIds[0];
    expect(first).toBe(model.tabs[0]?.sections[0]?.id);
    expect(meta.merges[0]).toMatchObject({ sourceDocId: MERGE_SOURCE_ID, sourceTitle: MERGE_SOURCE_TITLE });
    expect(meta.generation.prompts).toContain('merge-weave@1');
    expect(updated).toHaveBeenCalledWith({ slug: 'widget-ad-spend', sectionId: first, tabKey: 'indepth' });
    // The merged-away document went to the library's trash.
    expect(lib.list().map((e) => e.id)).toEqual([MERGE_TARGET_ID]);
  });

  it('one Undo restores the pre-merge document (09 §4.1)', async () => {
    const { lib, h, target } = await setup();
    const sug = await h.runMergeCheck(MERGE_SOURCE_ID);
    await h.service.accept(sug?.id ?? '');
    expect(await lib.history('widget-ad-spend')).toEqual({
      canUndo: true,
      canRedo: false,
      undoLabel: `merged '${quoteLabel(MERGE_SOURCE_TITLE)}' in`,
    });
    await lib.undo('widget-ad-spend');
    expect(await readFile(lib.docPath('widget-ad-spend'), 'utf8')).toBe(target.html);
    expect((await lib.getMeta('widget-ad-spend')).merges).toEqual([]);
    expect(await lib.history('widget-ad-spend')).toMatchObject({ canUndo: false, canRedo: true });
  });
});
