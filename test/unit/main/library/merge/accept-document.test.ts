import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  appendMergedDocument,
  buildDocumentModel,
  parseDocument,
  renderDocument,
  type DocumentModel,
} from '../../../../../src/main/document';
import { createMergeSuggestions, type DocumentMeta, type MergeJudge } from '../../../../../src/main/library';
import { INDEPTH_DRAFT, RESOLVED, SKIPPED, fixtureInput } from '../../../../fixtures/documents/drafts';
import { STUB_RUNTIME } from '../../../../fixtures/documents/runtime';
import { validateDocument } from '../../../../helpers/doc-validity';
import { SeededIdSource } from '../../../../helpers/ids';
import { makeMeta, testLibrary, writeDocFolder } from '../fixtures';

/** Accept end to end with the real 07 §8.1 merge (09 §10.3, §10.6). Synthetic documents only. */

const TARGET_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const TS = '2026-01-01T00:00:00.000Z';

function doc(id: string, slug: string, title: string, seed: number): { html: string; meta: DocumentMeta } {
  const { model, assets } = buildDocumentModel({
    ...fixtureInput('full', seed),
    docId: id,
    slug,
    indepth: { ...INDEPTH_DRAFT, title },
  });
  const html = renderDocument(model, assets, { runtime: STUB_RUNTIME });
  const meta = makeMeta({
    id,
    topicSlug: slug,
    title,
    summary: `${title} at Example Widgets Inc.: return on ad spend for widget campaigns.`,
    createdAt: id === TARGET_ID ? TS : '2026-01-02T00:00:00.000Z',
    tabs: tabsOf(model),
    sourcesUsed: RESOLVED.map((r) => ({
      ref: r.resolverId === 'file' ? path.basename(r.location) : r.ref,
      kind: r.resolverId === 'clipboard' ? 'clipboard' : r.resolverId === 'url' ? 'url' : 'file',
    })),
    sourcesSkipped: SKIPPED,
  });
  return { html, meta };
}

const tabsOf = (m: DocumentModel): DocumentMeta['tabs'] =>
  m.tabs.map((t) => ({ key: t.key, kind: t.kind, label: t.label, sectionCount: t.sections.length, createdAt: TS }));

describe('accept with appendMergedDocument (09 §10.6)', () => {
  it('writes a valid merged target whose meta matches the document, and opens it at the marker', async () => {
    const { lib } = await testLibrary();
    const target = doc(TARGET_ID, 'widget-ad-spend', 'Widget ad spend', 7);
    const source = doc(SOURCE_ID, 'widget-roas', 'Widget ROAS', 7);
    await writeDocFolder(lib.root, target.meta, target.html);
    await writeDocFolder(lib.root, source.meta, source.html);
    await lib.reconcile();

    const judge = vi.fn(async (_s: string, c: { catalogId: string }[]) => ({
      matches: c.map((x) => ({ catalogId: x.catalogId, score: 0.92, reason: 'Both explain widget ROAS.' })),
    })) as unknown as MergeJudge;
    const h = createMergeSuggestions({
      library: lib,
      judge,
      appendMerged: (input) => appendMergedDocument(input, { runtime: STUB_RUNTIME, idSource: new SeededIdSource(3) }),
    });
    const sug = await h.runMergeCheck(SOURCE_ID);
    expect(sug?.target.id).toBe(TARGET_ID);
    const updated = vi.fn();
    h.service.onDocUpdated(updated);

    expect(await h.service.accept(sug?.id ?? '')).toEqual({ targetSlug: 'widget-ad-spend' });

    const html = await readFile(lib.docPath('widget-ad-spend'), 'utf8');
    const meta = await lib.getMeta('widget-ad-spend');
    expect(validateDocument(html, meta).errors).toEqual([]);
    const model = parseDocument(html).model;
    expect(model.docId).toBe(TARGET_ID);
    expect(meta.tabs.map((t) => t.key)).toEqual(model.tabs.map((t) => t.key));
    const marker = meta.merges[0]?.anchorSectionIds[0];
    const markerSection = model.tabs[0]?.sections.find((x) => x.id === marker);
    expect(markerSection?.heading).toBe('Added from: Widget ROAS');
    expect(markerSection?.mergeMarker?.suggestionId).toBe(sug?.id);
    expect(updated).toHaveBeenCalledWith({ slug: 'widget-ad-spend', sectionId: marker, tabKey: 'indepth' });
    expect(lib.list().map((e) => e.id)).toEqual([TARGET_ID]);
  });
});
