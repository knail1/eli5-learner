import { describe, expect, it } from 'vitest';
import {
  DocumentBuildError,
  DocumentFormatError,
  MAX_SECTION_ELI5_TABS,
  SECTION_ID_RE,
  addSectionEli5Tab,
  appendMergedDocument,
  buildDocumentModel,
  parseDocument,
  renderDocument,
  type AppendMergedInput,
  type DocumentModel,
  type SectionId,
} from '../../../../src/main/document';
import { GLOSSARY_DRAFT, INDEPTH_DRAFT, fixtureInput } from '../../../fixtures/documents/drafts';
import { SECTION_ELI5_DRAFT } from '../../../fixtures/documents/models';
import { STUB_RUNTIME } from '../../../fixtures/documents/runtime';
import { SeededIdSource } from '../../../helpers/ids';
import { validateDocument } from '../../../helpers/doc-validity';

/** appendMergedDocument (09 §10.3, 07 §8.1). Synthetic "Example Widgets Inc." documents only. */

const TARGET_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const SUGGESTION_ID = '33333333-3333-4333-8333-333333333333';
const MERGED_AT = '2026-09-28T10:00:00.000Z';
const TAB_TS = '2026-09-27T12:00:00.000Z';

interface Built {
  html: string;
  model: DocumentModel;
}

/** Same seed as the target by default, so every source SectionId collides with a target one. */
function build(opts: {
  docId: string;
  slug: string;
  title: string;
  seed?: number;
  placeholder?: boolean;
  glossary?: typeof GLOSSARY_DRAFT | null;
  sxTabs?: number;
}): Built {
  const base = fixtureInput(opts.placeholder ? 'placeholder' : 'full', opts.seed ?? 7);
  const built = buildDocumentModel({
    ...base,
    docId: opts.docId,
    slug: opts.slug,
    indepth: { ...INDEPTH_DRAFT, title: opts.title },
    ...(opts.glossary !== undefined ? { glossary: opts.glossary } : {}),
  });
  const assets = built.assets;
  let model = built.model;
  const ids = new SeededIdSource((opts.seed ?? 7) + 100);
  for (let i = 0; i < (opts.sxTabs ?? 0); i++) {
    const from = model.tabs[0]?.sections[0]?.id;
    if (!from) throw new Error('fixture');
    model = addSectionEli5Tab(model, from, 'ROAS', SECTION_ELI5_DRAFT, TAB_TS, { idSource: ids }).model;
  }
  return { html: renderDocument(model, assets, { runtime: STUB_RUNTIME }), model };
}

function metaOf(b: Built, over: Partial<AppendMergedInput['targetMeta']> = {}): AppendMergedInput['targetMeta'] {
  return {
    id: b.model.docId,
    title: b.model.title,
    retiredIds: [],
    tabs: b.model.tabs.map((t) => ({
      key: t.key,
      kind: t.kind,
      label: t.label,
      sectionCount: t.sections.length,
      createdAt: TAB_TS,
      ...(t.origin ? { sourceSectionId: t.origin.sectionId } : {}),
    })),
    ...over,
  };
}

const target = build({ docId: TARGET_ID, slug: 'widget-ads', title: 'Widget ad spend' });
const sourceGlossary = {
  entries: [
    ...GLOSSARY_DRAFT.entries,
    {
      term: 'Paid search',
      explanation: 'Ads shown next to search results.',
      anchorSectionIndex: 0,
      anchorText: 'Paid search',
    },
  ],
};
const source = build({
  docId: SOURCE_ID,
  slug: 'widget-returns',
  title: 'Widget returns *and* refunds',
  glossary: sourceGlossary,
  sxTabs: 1,
});

function merge(t: Built = target, s: Built = source, extra: Partial<AppendMergedInput> = {}) {
  return appendMergedDocument(
    {
      targetHtml: t.html,
      targetMeta: metaOf(t),
      sourceHtml: s.html,
      sourceMeta: metaOf(s),
      suggestionId: SUGGESTION_ID,
      mergedAt: MERGED_AT,
      ...extra,
    },
    { idSource: new SeededIdSource(42), runtime: STUB_RUNTIME },
  );
}

const allIds = (m: DocumentModel): string[] => m.tabs.flatMap((t) => t.sections.map((s) => s.id));

describe('appendMergedDocument (07 §8.1)', () => {
  const r = merge();
  const merged = parseDocument(r.html).model;
  const indepth = merged.tabs[0];
  const eli5 = merged.tabs[1];

  it('keeps every target SectionId, title, dek and createdAt; sets updatedAt to mergedAt', () => {
    const before = new Set(allIds(target.model));
    for (const id of before) expect(allIds(merged)).toContain(id);
    expect(merged.docId).toBe(TARGET_ID);
    expect(merged.title).toBe(target.model.title);
    expect(merged.dek).toBe(target.model.dek);
    expect(merged.createdAt).toBe(target.model.createdAt);
    expect(merged.updatedAt).toBe(MERGED_AT);
  });

  it('gives every incoming section a fresh unique id under the target tab key', () => {
    const ids = allIds(merged);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(SECTION_ID_RE);
    const incoming = merged.tabs.flatMap((t) =>
      t.sections.filter((s) => s.origin === 'merged' || s.origin === 'merge-marker').map((s) => [t.key, s.id]),
    );
    expect(incoming.length).toBeGreaterThan(0);
    for (const [key, id] of incoming) expect(id?.startsWith(`sec-${key}-`)).toBe(true);
    // Old source ids map to new ones, never kept.
    for (const [oldId, newId] of Object.entries(r.idMap)) {
      expect(newId).not.toBe(oldId);
      expect(ids).toContain(newId);
    }
  });

  it('inserts the in-depth marker and moved sections before the references section', () => {
    const secs = indepth?.sections ?? [];
    const last = secs[secs.length - 1];
    expect(last?.kind).toBe('references');
    const targetRefs = target.model.tabs[0]?.sections.find((s) => s.kind === 'references');
    expect(last?.id).toBe(targetRefs?.id);
    const markerIdx = secs.findIndex((s) => s.origin === 'merge-marker');
    const targetContent = target.model.tabs[0]?.sections.filter((s) => s.kind === 'content').length ?? 0;
    expect(markerIdx).toBe(targetContent);
    const marker = secs[markerIdx];
    expect(marker?.heading).toBe('Added from: Widget returns *and* refunds');
    expect(marker?.mergeMarker).toMatchObject({
      suggestionId: SUGGESTION_ID,
      fromDocId: SOURCE_ID,
      fromTitle: 'Widget returns *and* refunds',
      mergedAt: MERGED_AT,
    });
    expect(marker?.mergeMarker?.sourceRefs).toContain('widget-sales-q3.pptx');
    const moved = secs.slice(markerIdx + 1, -1);
    const sourceContent = source.model.tabs[0]?.sections.filter((s) => s.kind === 'content') ?? [];
    expect(moved.map((s) => s.heading)).toEqual(sourceContent.map((s) => s.heading));
    for (const s of moved) {
      expect(s.origin).toBe('merged');
      expect(s.merge).toEqual({ fromDocId: SOURCE_ID, fromTitle: 'Widget returns *and* refunds', mergedAt: MERGED_AT });
    }
    expect(moved.map((s) => s.blocks.length)).toEqual(sourceContent.map((s) => s.blocks.length));
  });

  it('marker text says when and from what; the title is literal, not markdown', () => {
    const marker = indepth?.sections.find((s) => s.origin === 'merge-marker');
    const p = marker?.blocks[0];
    expect(p?.type).toBe('paragraph');
    const md = p && p.type === 'paragraph' ? p.md : '';
    expect(md).toContain('Merged on 28 Sep 2026.');
    expect(md).toContain('Originally generated from: widget-sales-q3.pptx');
    expect(r.html).toContain('data-merge-marker="' + SUGGESTION_ID + '"');
    expect(r.html).toContain('data-merged-from="' + SOURCE_ID + '"');
    expect(r.html).not.toContain('<em>and</em> refunds</h2>');
  });

  it('escapes markdown in source reference labels so the marker text stays literal', () => {
    const model = {
      ...source.model,
      references: source.model.references.map((x, i) => (i === 0 ? { ...x, label: 'q3_*final*.pptx' } : x)),
    };
    const html = renderDocument(model, parseDocument(source.html).assets, { runtime: STUB_RUNTIME });
    const r2 = merge(target, { html, model });
    const m = parseDocument(r2.html).model.tabs[0]?.sections.find((x) => x.origin === 'merge-marker');
    const p = m?.blocks[0];
    expect(p && p.type === 'paragraph' ? p.md : '').toContain('q3\\_\\*final\\*.pptx');
    expect(m?.mergeMarker?.sourceRefs[0]).toBe('q3_*final*.pptx');
    expect(r2.html).toContain('q3_*final*.pptx');
    expect(r2.html).not.toContain('<em>final</em>');
  });

  it('appends an ELI5 marker and the ELI5 sections to the ELI5 tab', () => {
    const secs = eli5?.sections ?? [];
    const markerIdx = secs.findIndex((s) => s.origin === 'merge-marker');
    expect(markerIdx).toBe(target.model.tabs[1]?.sections.length);
    expect(secs.slice(markerIdx + 1).map((s) => s.heading)).toEqual(
      source.model.tabs[1]?.sections.map((s) => s.heading),
    );
    expect(r.markerSectionIds).toHaveLength(2);
    expect(r.markerSectionIds[0]).toBe(indepth?.sections.find((s) => s.origin === 'merge-marker')?.id);
    expect(r.markerSectionIds[0]?.startsWith('sec-indepth-')).toBe(true);
    expect(r.markerSectionIds[1]?.startsWith('sec-eli5-')).toBe(true);
    expect(secs[markerIdx]?.id).toBe(r.markerSectionIds[1]);
  });

  it('carries section ELI5 tabs with fresh keys and ids, rewritten origin and a (2) label on collision', () => {
    const sx = merged.tabs.filter((t) => t.kind === 'section-eli5');
    expect(sx).toHaveLength(1);
    const carried = sx[0];
    const sourceSx = source.model.tabs[2];
    expect(carried?.key).toMatch(/^sx[0-9a-f]{6}$/);
    for (const s of carried?.sections ?? []) expect(s.id.startsWith(`sec-${carried?.key}-`)).toBe(true);
    const oldOrigin = sourceSx?.origin?.sectionId;
    expect(oldOrigin).toBeDefined();
    expect(carried?.origin?.sectionId).toBe(r.idMap[oldOrigin as SectionId]);
    // Merging a target that already has the same label gets a suffix.
    const t2 = build({ docId: TARGET_ID, slug: 'widget-ads', title: 'Widget ad spend', sxTabs: 1 });
    const r2 = merge(t2);
    const labels = parseDocument(r2.html).model.tabs.map((t) => t.label);
    expect(labels.filter((l) => l.startsWith('ELI5: '))).toEqual([sourceSx?.label, `${sourceSx?.label} (2)`]);
  });

  it('returns TabRecords in display order with target createdAt kept and carried tabs stamped', () => {
    expect(r.tabs.map((t) => t.key)).toEqual(merged.tabs.map((t) => t.key));
    expect(r.tabs[0]).toMatchObject({ key: 'indepth', kind: 'indepth', createdAt: TAB_TS });
    expect(r.tabs[0]?.sectionCount).toBe(indepth?.sections.length);
    const carried = r.tabs[2];
    expect(carried).toMatchObject({ kind: 'section-eli5', createdAt: MERGED_AT });
    expect(carried?.sourceSectionId).toBe(merged.tabs[2]?.origin?.sectionId);
  });

  it('carries glossary notes of moved sections through idMap and drops terms the target defines', () => {
    const terms = merged.glossary.map((n) => n.term.toLowerCase());
    expect(terms.filter((t) => t === 'roas')).toHaveLength(1);
    const paid = merged.glossary.find((n) => n.term === 'Paid search');
    expect(paid).toBeDefined();
    expect(Object.values(r.idMap)).toContain(paid?.sectionId);
    const ids = merged.glossary.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Target notes are unchanged.
    for (const n of target.model.glossary) expect(merged.glossary).toContainEqual(n);
  });

  it('appends the source references with addedBy and keeps the target references', () => {
    const added = merged.references.filter((x) => x.addedBy);
    expect(added.length).toBe(source.model.references.length);
    for (const x of added)
      expect(x.addedBy).toEqual({ mergeFromTitle: 'Widget returns *and* refunds', mergedAt: MERGED_AT });
    expect(merged.references.slice(0, target.model.references.length)).toEqual(target.model.references);
    expect(r.html).toContain('Added by merge');
  });

  it('combines assets, deduplicated by sha256', () => {
    expect(merged.assets).toHaveLength(target.model.assets.length);
    const parsed = parseDocument(r.html);
    for (const a of merged.assets) expect(parsed.assets.has(a.id)).toBe(true);
  });

  it('produces a valid document that round-trips', () => {
    expect(validateDocument(r.html).errors).toEqual([]);
    const again = renderDocument(merged, parseDocument(r.html).assets, {
      runtime: STUB_RUNTIME,
      theme: parseDocument(r.html).theme,
    });
    expect(again).toBe(r.html);
  });

  it('never reuses a retired id of the target', () => {
    // Retire every id the seeded source would draw first; the allocator must skip them.
    const probe = merge();
    const retired = [...probe.markerSectionIds, ...Object.values(probe.idMap)];
    const r2 = appendMergedDocument(
      {
        targetHtml: target.html,
        targetMeta: metaOf(target, { retiredIds: retired }),
        sourceHtml: source.html,
        sourceMeta: metaOf(source),
        suggestionId: SUGGESTION_ID,
        mergedAt: MERGED_AT,
      },
      { idSource: new SeededIdSource(42), runtime: STUB_RUNTIME },
    );
    const ids = allIds(parseDocument(r2.html).model);
    for (const id of retired) expect(ids).not.toContain(id);
  });
});

describe('appendMergedDocument edge cases (07 §8.1)', () => {
  it('adds no ELI5 marker when the source ELI5 tab is a placeholder', () => {
    const s = build({ docId: SOURCE_ID, slug: 'widget-returns', title: 'Widget returns', placeholder: true });
    const r = merge(target, s);
    expect(r.markerSectionIds).toHaveLength(1);
    const eli5 = parseDocument(r.html).model.tabs[1];
    expect(eli5?.sections.map((x) => x.id)).toEqual(target.model.tabs[1]?.sections.map((x) => x.id));
  });

  it('keeps a target ELI5 placeholder section and appends after it', () => {
    const t = build({ docId: TARGET_ID, slug: 'widget-ads', title: 'Widget ad spend', placeholder: true });
    const r = merge(t, source);
    const eli5 = parseDocument(r.html).model.tabs[1];
    expect(eli5?.sections[0]?.origin).toBe('placeholder');
    expect(eli5?.sections[1]?.origin).toBe('merge-marker');
  });

  it('throws invalid_merge when source and target are the same document', () => {
    const same = build({ docId: TARGET_ID, slug: 'widget-ads', title: 'Widget ad spend' });
    expect(() => merge(target, same)).toThrow(DocumentBuildError);
    try {
      merge(target, same);
    } catch (e) {
      expect((e as DocumentBuildError).code).toBe('invalid_merge');
    }
  });

  it('propagates DocumentFormatError for a file without a model', () => {
    expect(() =>
      appendMergedDocument(
        {
          targetHtml: '<!doctype html><html><body>no model</body></html>',
          targetMeta: metaOf(target),
          sourceHtml: source.html,
          sourceMeta: metaOf(source),
          suggestionId: SUGGESTION_ID,
          mergedAt: MERGED_AT,
        },
        { runtime: STUB_RUNTIME },
      ),
    ).toThrow(DocumentFormatError);
  });

  it('drops the oldest carried tabs over the tab limit, with a warning', () => {
    const t = build({
      docId: TARGET_ID,
      slug: 'widget-ads',
      title: 'Widget ad spend',
      sxTabs: MAX_SECTION_ELI5_TABS - 1,
    });
    const s = build({ docId: SOURCE_ID, slug: 'widget-returns', title: 'Widget returns', sxTabs: 2, seed: 9 });
    const r = merge(t, s);
    const sx = parseDocument(r.html).model.tabs.filter((x) => x.kind === 'section-eli5');
    expect(sx).toHaveLength(MAX_SECTION_ELI5_TABS);
    expect(r.warnings).toContain('merge-tabs-dropped');
    // The newest carried tab survives.
    const lastSource = s.model.tabs[s.model.tabs.length - 1];
    expect(sx[sx.length - 1]?.origin?.sectionId).toBe(r.idMap[lastSource?.origin?.sectionId as SectionId]);
  });
});
