import { describe, expect, it, vi } from 'vitest';
import {
  DocumentBuildError,
  DocumentFormatError,
  SECTION_ID_RE,
  parseDocument,
  renderDocument,
  weaveMergedDocument,
  type DocumentModel,
  type MergePlanner,
  type Section,
} from '../../../../src/main/document';
import type { MergePlanDraft } from '../../../../src/main/llm';
import {
  MERGED_AT,
  MERGE_SOURCE_ID,
  MERGE_SOURCE_TITLE,
  MERGE_TAB_TS,
  MERGE_TARGET_ID,
  WEAVE_PLAN,
  mergeSource,
  mergeTarget,
  wovenFixture,
} from '../../../fixtures/documents/merge';
import { STUB_RUNTIME } from '../../../fixtures/documents/runtime';
import { validateDocument } from '../../../helpers/doc-validity';
import { SeededIdSource } from '../../../helpers/ids';

/** Woven merges (09 §10.3, 07 §8.1, §6.4). Synthetic "Example Widgets Inc." documents only. */

const allIds = (m: DocumentModel): string[] => m.tabs.flatMap((t) => t.sections.map((s) => s.id));
const content = (m: DocumentModel, tab: number): Section[] =>
  (m.tabs[tab]?.sections ?? []).filter((s) => s.kind === 'content');
const planner = (plan: MergePlanDraft = WEAVE_PLAN): MergePlanner & ReturnType<typeof vi.fn> =>
  vi.fn(async () => ({ draft: plan, prompt: 'merge-weave@1' })) as MergePlanner & ReturnType<typeof vi.fn>;

describe('prepareMergeWeave (07 §8.1 step 1)', () => {
  const { prep } = wovenFixture();

  it('aliases both documents and numbers every block', () => {
    expect(prep.input.targetTitle).toBe(mergeTarget().model.title);
    expect(prep.input.incomingTitle).toBe(MERGE_SOURCE_TITLE);
    expect(prep.input.target).toContain('### I1 · Why ad spend is judged by ROAS');
    expect(prep.input.target).toContain('### E2 · Picking the best ads');
    expect(prep.input.target).toContain('b4 chart (bar): "Paid search returns the most per dollar"');
    expect(prep.input.target).toMatch(/Glossary terms already defined\n.*ROAS/);
    expect(prep.input.incoming).toContain('### X1 · Returns by channel');
    expect(prep.input.incoming).toContain('### Y1 · Sending it back');
    expect(prep.input.incoming).toContain('| Affiliate | 11% |');
    expect(prep.input.imageLabels).toEqual(['Image 1']);
    // No section id ever reaches the prompt.
    expect(prep.input.target).not.toMatch(/sec-(indepth|eli5)-/);
  });

  it('throws invalid_merge for the same document and DocumentFormatError without a model', async () => {
    const t = mergeTarget();
    await expect(
      weaveMergedDocument(
        { targetHtml: t.html, targetMeta: t.meta, sourceHtml: t.html, sourceMeta: t.meta, mergedAt: MERGED_AT },
        planner(),
      ),
    ).rejects.toBeInstanceOf(DocumentBuildError);
    const s = mergeSource();
    await expect(
      weaveMergedDocument(
        {
          targetHtml: '<!doctype html><html></html>',
          targetMeta: t.meta,
          sourceHtml: s.html,
          sourceMeta: s.meta,
          mergedAt: MERGED_AT,
        },
        planner(),
      ),
    ).rejects.toBeInstanceOf(DocumentFormatError);
  });
});

describe('applyMergePlan (07 §8.1)', () => {
  const r = wovenFixture();
  const target = r.target.model;
  const m = r.model;

  it('revises sections in place, keeping every target SectionId, title, dek and createdAt', () => {
    for (const id of allIds(target)) expect(allIds(m)).toContain(id);
    expect(m.docId).toBe(MERGE_TARGET_ID);
    expect(m.title).toBe(target.title);
    expect(m.dek).toBe(target.dek);
    expect(m.createdAt).toBe(target.createdAt);
    expect(m.updatedAt).toBe(MERGED_AT);
    const i1 = content(m, 0)[0];
    expect(i1?.id).toBe(content(target, 0)[0]?.id);
    expect(i1?.blocks[0]?.type === 'paragraph' && i1.blocks[0].md).toContain('net of refunds since Q3');
    // Kept blocks are the originals, byte for byte.
    expect(i1?.blocks.slice(2, 5)).toEqual(content(target, 0)[0]?.blocks.slice(2));
  });

  it('inserts new sections after their anchor with fresh ids in both tabs; references stay last', () => {
    const indepth = m.tabs[0]?.sections ?? [];
    const at = indepth.findIndex((s) => s.heading === 'Returns eat into the return');
    expect(indepth[at - 1]?.id).toBe(content(target, 0)[1]?.id);
    const added = indepth[at];
    expect(added?.id).toMatch(SECTION_ID_RE);
    expect(added?.id.startsWith('sec-indepth-')).toBe(true);
    expect(allIds(target)).not.toContain(added?.id);
    expect(added).toMatchObject({
      origin: 'merged',
      merge: { fromDocId: MERGE_SOURCE_ID, fromTitle: MERGE_SOURCE_TITLE, mergedAt: MERGED_AT },
      enh: { added: 'm1', blocks: [] },
    });
    // The incoming table is copied, not retyped.
    expect(added?.blocks[1]).toEqual(r.source.model.tabs[0]?.sections[0]?.blocks[1]);
    expect(indepth[indepth.length - 1]?.kind).toBe('references');
    const eli5 = m.tabs[1]?.sections ?? [];
    expect(eli5.map((s) => s.heading)).toEqual([
      'Money in, money out',
      'Picking the best ads',
      'When things come back',
    ]);
    expect(eli5[2]?.id.startsWith('sec-eli5-')).toBe(true);
    const ids = allIds(m);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks inserted words, not unchanged ones, in both tabs (07 §6.4)', () => {
    const i1 = content(m, 0)[0];
    const p = i1?.enh?.blocks.find((b) => b.block === 0);
    expect(p?.kind).toBe('text');
    const text =
      'Example Widgets Inc. judges every channel by ROAS, the revenue earned for each dollar spent, net of refunds since Q3.';
    const ranges = p?.kind === 'text' ? p.parts[0] : [];
    expect(ranges?.map((x) => text.slice(x.start, x.end))).toEqual(['net of refunds since Q3']);
    const list = i1?.enh?.blocks.find((b) => b.block === 1);
    expect(list?.kind === 'text' && list.parts.map((x) => x.length)).toEqual([0, 0, 0, 1]);
    // Kept blocks carry no marks; a written block with no counterpart is marked new as a whole.
    expect(i1?.enh?.blocks.map((b) => b.block)).toEqual([0, 1, 5]);
    expect(i1?.enh?.blocks[2]).toEqual({ block: 5, kind: 'new', merge: 'm1' });
    const e1 = content(m, 1)[0];
    expect(e1?.enh?.blocks).toEqual([
      {
        block: 0,
        kind: 'text',
        parts: [[expect.objectContaining({ merge: 'm1' })]],
      },
    ]);
    // Untouched sections carry no marks at all.
    expect(content(m, 0)[1]?.enh).toBeUndefined();
    expect(r.enhancedSectionIds[0]).toBe(i1?.id);
    expect(
      r.enhancedSectionIds.every(
        (id, i, a) => i === 0 || !id.startsWith('sec-indepth-') || a[i - 1]?.startsWith('sec-indepth-'),
      ),
    ).toBe(true);
  });

  it('records the merge in the legend and lists the new sources as added by it', () => {
    expect(r.mergeId).toBe('m1');
    expect(m.merges).toEqual([{ id: 'm1', fromTitle: MERGE_SOURCE_TITLE, mergedAt: MERGED_AT }]);
    const added = m.references.filter((x) => x.addedBy);
    expect(added.map((x) => x.label)).toEqual(['Example Widgets Inc. returns report']);
    expect(added[0]?.addedBy).toEqual({ mergeFromTitle: MERGE_SOURCE_TITLE, mergedAt: MERGED_AT, mergeId: 'm1' });
    // The shared pricing page is already listed: not duplicated.
    expect(m.references.filter((x) => x.label === 'Example Widgets Inc. pricing')).toHaveLength(1);
    expect(m.references.slice(0, target.references.length)).toEqual(target.references);
  });

  it('keeps target glossary notes, re-anchors revised sections and adds new terms only once', () => {
    const terms = m.glossary.map((n) => n.term);
    expect(terms.filter((t) => t.toLowerCase() === 'roas')).toHaveLength(1);
    const refund = m.glossary.find((n) => n.term === 'Refund rate');
    expect(refund?.sectionId).toBe(m.tabs[0]?.sections.find((s) => s.heading === 'Returns eat into the return')?.id);
    expect(refund?.anchorText).toBe('refund rate');
    const ids = m.glossary.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const n of target.glossary) expect(m.glossary.map((x) => x.id)).toContain(n.id);
  });

  it('renders a valid document with marks, a legend and merged references that round-trips', () => {
    const html = renderDocument(m, r.assets, { runtime: STUB_RUNTIME });
    expect(validateDocument(html).errors).toEqual([]);
    expect(html).toContain(
      '<ins class="enh" data-merge="m1" title="Enhanced on 28 Sep 2026 with material from Widget returns and refunds">net of refunds since Q3</ins>',
    );
    expect(html).toMatch(
      /<section id="sec-indepth-[0-9a-f]{8}" data-section-id="[^"]+" data-origin="merged" data-merged-from="[^"]+" data-enh="new" data-merge="m1"/,
    );
    expect(html).toContain('class="enh-legend"');
    expect(html).toContain(
      '<aside data-enh="new" data-merge="m1" title="Enhanced on 28 Sep 2026 with material from Widget returns and refunds" class="callout callout--note">',
    );
    expect(html).toContain(
      '<span class="enh-swatch" aria-hidden="true"></span>Enhanced on 28 Sep 2026 with material from <cite>Widget returns and refunds</cite>',
    );
    expect(html).toContain(
      '<button type="button" class="enh-toggle" aria-pressed="false" hidden>Hide highlights</button>',
    );
    expect(html).toContain('Added in merge on 28 Sep 2026 from Widget returns and refunds');
    const parsed = parseDocument(html);
    expect(renderDocument(parsed.model, parsed.assets, { runtime: STUB_RUNTIME, theme: parsed.theme })).toBe(html);
  });

  it('a second merge gets m2 and carries the first merge marks through its own diff', () => {
    const second: MergePlanDraft = {
      indepth: {
        revise: [
          {
            section: 'I1',
            heading: 'Why ad spend is judged by ROAS',
            blocks: [
              {
                type: 'paragraph',
                md: 'Example Widgets Inc. judges every channel by **ROAS**, the revenue earned for each dollar spent, net of refunds since Q3 and of shipping. A channel with a ROAS of 4 returns *four dollars* for every dollar. See [the pricing page](https://www.example.com/widgets/pricing).',
              },
              { type: 'keep', block: 1 },
            ],
          },
        ],
        insert: [],
      },
      eli5: { revise: [], insert: [] },
      glossary: [],
    };
    const html1 = renderDocument(m, r.assets, { runtime: STUB_RUNTIME });
    const s = mergeSource();
    return weaveMergedDocument(
      {
        targetHtml: html1,
        targetMeta: r.target.meta,
        sourceHtml: s.html.replace(MERGE_SOURCE_ID, '33333333-3333-4333-8333-333333333333'),
        sourceMeta: { ...s.meta, id: '33333333-3333-4333-8333-333333333333', title: 'Widget shipping costs' },
        mergedAt: '2026-09-29T10:00:00.000Z',
      },
      planner(second),
      { runtime: STUB_RUNTIME, idSource: new SeededIdSource(5) },
    ).then((w) => {
      expect(w.mergeId).toBe('m2');
      const model = parseDocument(w.html).model;
      expect(model.merges?.map((x) => x.id)).toEqual(['m1', 'm2']);
      const p = content(model, 0)[0]?.enh?.blocks.find((b) => b.block === 0);
      const text =
        'Example Widgets Inc. judges every channel by ROAS, the revenue earned for each dollar spent, net of refunds since Q3 and of shipping.';
      const marks = p?.kind === 'text' ? (p.parts[0] ?? []) : [];
      expect(marks.map((x) => [x.merge, text.slice(x.start, x.end)])).toEqual([
        ['m1', 'net of refunds since Q3'],
        ['m2', 'and of shipping'],
      ]);
      // The list's earlier marks survive a keep.
      expect(content(model, 0)[0]?.enh?.blocks.find((b) => b.block === 1)?.kind).toBe('text');
      expect(w.html).toContain('with material from <cite>Widget shipping costs</cite>');
    });
  });

  it('skips unknown aliases and invalid blocks with warnings, never failing the merge', () => {
    const plan: MergePlanDraft = {
      indepth: {
        revise: [{ section: 'I99', heading: 'Nope', blocks: [{ type: 'paragraph', md: 'x' }] }],
        insert: [
          {
            after: 'I42',
            heading: 'Late addition',
            blocks: [
              { type: 'incoming', section: 'X9', block: 0 },
              { type: 'paragraph', md: 'Widgets ship from two plants.' },
            ],
          },
        ],
      },
      eli5: { revise: [], insert: [{ after: 'START', heading: 'First', blocks: [{ type: 'keep', block: 0 }] }] },
      glossary: [],
    };
    const w = wovenFixture(STUB_RUNTIME, plan);
    expect(w.warnings).toEqual(
      expect.arrayContaining(['merge-unknown-section', 'merge-block-dropped', 'merge-section-empty']),
    );
    const indepth = w.model.tabs[0]?.sections ?? [];
    // An unknown anchor goes after the last content section, still before the references.
    expect(indepth[indepth.length - 2]?.heading).toBe('Late addition');
    expect(w.model.tabs[1]?.sections).toEqual(r.target.model.tabs[1]?.sections);
  });
});

describe('weaveMergedDocument (09 §10.6 step 5)', () => {
  it('calls the planner once with the prepared input and returns html, tab records and markers', async () => {
    const t = mergeTarget();
    const s = mergeSource();
    const p = planner();
    const w = await weaveMergedDocument(
      { targetHtml: t.html, targetMeta: t.meta, sourceHtml: s.html, sourceMeta: s.meta, mergedAt: MERGED_AT },
      p,
      { runtime: STUB_RUNTIME, idSource: new SeededIdSource(42) },
    );
    expect(p).toHaveBeenCalledTimes(1);
    expect(p.mock.calls[0]?.[0]).toMatchObject({ targetTitle: t.model.title, incomingTitle: MERGE_SOURCE_TITLE });
    expect(w.prompt).toBe('merge-weave@1');
    expect(w.html).toBe(renderDocument(wovenFixture().model, wovenFixture().assets, { runtime: STUB_RUNTIME }));
    const model = parseDocument(w.html).model;
    expect(w.tabs.map((x) => x.key)).toEqual(model.tabs.map((x) => x.key));
    expect(w.tabs[0]).toMatchObject({
      kind: 'indepth',
      createdAt: MERGE_TAB_TS,
      sectionCount: model.tabs[0]?.sections.length,
    });
    expect(w.markerSectionIds[0]).toBe(content(model, 0)[0]?.id);
  });

  it('propagates a planner failure and never falls back to appending', async () => {
    const t = mergeTarget();
    const s = mergeSource();
    const failing: MergePlanner = () =>
      Promise.reject(Object.assign(new Error('budget exhausted'), { kind: 'cancelled' }));
    await expect(
      weaveMergedDocument(
        { targetHtml: t.html, targetMeta: t.meta, sourceHtml: s.html, sourceMeta: s.meta, mergedAt: MERGED_AT },
        failing,
      ),
    ).rejects.toThrow('budget exhausted');
  });
});
