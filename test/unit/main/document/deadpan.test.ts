/**
 * The optional Deadpan tab: build order and ids, kept visuals through composed origins, the
 * omitted warning, the tab-order validity rule both ways, the hint, mirror-tab regeneration,
 * the Ask material, and the merge that drops it.
 */
import { describe, expect, it } from 'vitest';
import {
  DEADPAN_TAB_KEY,
  DEADPAN_TAB_LABEL,
  DocumentMutationError,
  TAB_HINTS,
  applyMergePlan,
  buildDocumentModel,
  inDepthForAsk,
  parseDocument,
  prepareMergeWeave,
  removeTab,
  renderDocument,
  replaceSection,
  sectionToDraft,
  tabsForDeepAsk,
  type BuildInput,
  type DocBlock,
  type DocumentModel,
  type SectionId,
} from '../../../../src/main/document';
import { countDocAnimations } from '../../../../src/main/document/validate';
import type { DocumentDraftTab } from '../../../../src/main/llm';
import { PACKING_ANIMATION } from '../../../fixtures/documents/animation';
import { FIXTURE_NOW, fixtureInput } from '../../../fixtures/documents/drafts';
import {
  MERGED_AT,
  MERGE_SOURCE_ID,
  MERGE_SOURCE_TITLE,
  MERGE_TARGET_ID,
  WEAVE_PLAN,
  mergeSource,
  metaOf,
} from '../../../fixtures/documents/merge';
import { fixtureDocument } from '../../../fixtures/documents/models';
import { readGolden, STUB_RUNTIME } from '../../../fixtures/documents/runtime';
import { SHOWCASE_PHOTOS } from '../../../fixtures/documents/showcase';
import { validateDocument } from '../../../helpers/doc-validity';
import { SeededIdSource } from '../../../helpers/ids';

const LATER = '2026-09-28T09:00:00.000Z';

const STE_DRAFT: DocumentDraftTab = {
  kind: 'ste',
  title: 'Ad spend in simple English',
  sections: [
    {
      heading: 'How the company measures ad spend',
      blocks: [{ type: 'paragraph', md: 'The company measures each channel with one number. The number is ROAS.' }],
    },
  ],
};

const DEADPAN_DRAFT: DocumentDraftTab = {
  kind: 'deadpan',
  title: 'Ad spend, bravely measured',
  sections: [
    {
      heading: 'How the company measures ad spend, heroically',
      blocks: [{ type: 'paragraph', md: 'The company measures each channel with one number. Just one. It is ROAS.' }],
    },
  ],
};

const input = (p: Partial<BuildInput> = {}): BuildInput => ({
  ...fixtureInput('full'),
  deadpan: { tab: DEADPAN_DRAFT, origins: [[null]] },
  ...p,
});

const ids = (m: DocumentModel): string[] => m.tabs.flatMap((t) => t.sections.map((s) => s.id));
const render = (m: DocumentModel, assets: ReadonlyMap<string, Uint8Array>): string =>
  renderDocument(m, assets, { runtime: STUB_RUNTIME });
const tabOf = (m: DocumentModel, key: string) => m.tabs.find((t) => t.key === key);
const blocksOf = (m: DocumentModel, key: string): DocBlock[] =>
  (tabOf(m, key)?.sections ?? []).flatMap((s) => s.blocks);

describe('buildDocumentModel with a Deadpan tab', () => {
  it('puts the tab after eli5 when there is no STE tab, with sec-deadpan- ids', () => {
    const { model, warnings } = buildDocumentModel(input());
    expect(model.tabs.map((t) => [t.key, t.kind, t.label])).toEqual([
      ['indepth', 'indepth', 'In depth'],
      ['eli5', 'eli5', 'ELI5'],
      [DEADPAN_TAB_KEY, 'deadpan', DEADPAN_TAB_LABEL],
    ]);
    expect(DEADPAN_TAB_LABEL).toBe('Deadpan');
    const tab = tabOf(model, 'deadpan');
    expect(tab?.sections.map((s) => s.id)).toEqual([expect.stringMatching(/^sec-deadpan-[0-9a-f]{8}$/)]);
    expect(tab?.placeholder).toBeUndefined();
    expect(tab?.sections.every((s) => s.kind === 'content')).toBe(true);
    expect(model.glossary.every((n) => n.sectionId.startsWith('sec-indepth-'))).toBe(true);
    expect(warnings).not.toContain('deadpan-omitted');
  });

  it('puts the tab after the STE tab when both are built', () => {
    const { model } = buildDocumentModel(input({ ste: { tab: STE_DRAFT, origins: [[null]] } }));
    expect(model.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5', 'ste', 'deadpan']);
    expect(new Set(ids(model)).size).toBe(ids(model).length);
  });

  it('builds no tab when deadpan is absent or null', () => {
    for (const deadpan of [undefined, null]) {
      const { model, warnings } = buildDocumentModel({ ...fixtureInput('full'), deadpan });
      expect(model.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5']);
      expect(warnings).not.toContain('deadpan-omitted');
    }
  });

  it('omits the tab (never a placeholder) with deadpan-omitted when no section survives', () => {
    const empty: DocumentDraftTab = {
      ...DEADPAN_DRAFT,
      sections: [{ heading: 'Empty', blocks: [{ type: 'paragraph', md: '  ' }] }],
    };
    const { model, warnings } = buildDocumentModel(input({ deadpan: { tab: empty, origins: [[null]] } }));
    expect(model.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5']);
    expect(warnings).toContain('deadpan-omitted');
  });

  it('resolves a kept stock photo through its composed in-depth origin to the same asset', () => {
    const indepth: DocumentDraftTab = {
      kind: 'indepth',
      title: 'Warehouse',
      sections: [
        {
          heading: 'Shelves',
          blocks: [
            { type: 'paragraph', md: 'Widgets wait on shelves.' },
            { type: 'paragraph', md: 'Pickers walk the aisles.' },
            { type: 'photo', query: 'warehouse', purpose: 'the warehouse', alt: 'Shelves' },
          ],
        },
      ],
    };
    const photo = indepth.sections[0]?.blocks[2];
    if (!photo) throw new Error('fixture');
    const deadpan: DocumentDraftTab = {
      kind: 'deadpan',
      title: 'Warehouse',
      sections: [{ heading: 'Shelves', blocks: [{ type: 'paragraph', md: 'Shelves. Thrilling.' }, photo] }],
    };
    const { model } = buildDocumentModel(
      input({
        indepth,
        glossary: null,
        photos: [SHOWCASE_PHOTOS[0]!],
        deadpan: { tab: deadpan, origins: [[null, { section: 0, block: 2 }]] },
      }),
    );
    const a = blocksOf(model, 'indepth').find((b) => b.type === 'figure');
    const b = blocksOf(model, 'deadpan').find((x) => x.type === 'figure');
    expect(a?.type === 'figure' && a.assetId).toBeTruthy();
    expect(b).toEqual(a);
    expect(model.assets.filter((x) => x.credit)).toHaveLength(1);
  });

  it('drops a photo with no origin', () => {
    const deadpan: DocumentDraftTab = {
      ...DEADPAN_DRAFT,
      sections: [
        {
          heading: 'Shelves',
          blocks: [
            { type: 'paragraph', md: 'Shelves.' },
            { type: 'photo', query: 'warehouse', purpose: 'the warehouse', alt: 'Shelves' },
          ],
        },
      ],
    };
    const { model, warnings } = buildDocumentModel(input({ deadpan: { tab: deadpan, origins: [[null, null]] } }));
    expect(blocksOf(model, 'deadpan').map((b) => b.type)).toEqual(['paragraph']);
    expect(warnings).toContain('photo-unresolved');
  });

  it('mirrors animations: never more than In depth holds, and never counted against the document cap', () => {
    const sections = Array.from({ length: 4 }, (_, i) => ({ heading: `Part ${i + 1}`, blocks: [PACKING_ANIMATION] }));
    const count = (m: DocumentModel, key: string): number =>
      blocksOf(m, key).filter((b) => b.type === 'animation').length;
    const none = buildDocumentModel(input({ deadpan: { tab: { ...DEADPAN_DRAFT, sections }, origins: [] } }));
    expect(count(none.model, 'deadpan')).toBe(0);
    const base = fixtureInput('full');
    const indepth = {
      ...base.indepth,
      sections: base.indepth.sections.map((s, i) => (i === 0 ? { ...s, blocks: [...s.blocks, PACKING_ANIMATION] } : s)),
    };
    const one = buildDocumentModel(
      input({
        indepth,
        ste: { tab: { ...STE_DRAFT, sections }, origins: [] },
        deadpan: { tab: { ...DEADPAN_DRAFT, sections }, origins: [] },
      }),
    );
    expect(count(one.model, 'indepth')).toBe(1);
    expect(count(one.model, 'ste')).toBe(1);
    expect(count(one.model, 'deadpan')).toBe(1);
    expect(countDocAnimations(one.model.tabs)).toBe(1);
  });

  it('never mints a reserved id', () => {
    const first = buildDocumentModel(input({ idSource: new SeededIdSource(7) })).model;
    const reserved = ids(first);
    const again = ids(buildDocumentModel(input({ idSource: new SeededIdSource(7), reservedIds: reserved })).model);
    expect(again.filter((id) => reserved.includes(id))).toEqual([]);
  });
});

describe('the with-deadpan golden', () => {
  const html = readGolden('with-deadpan');

  it('orders tabs [indepth, eli5, ste, deadpan, sx…] and validates', () => {
    const { model, warnings } = fixtureDocument('with-deadpan');
    expect(model.tabs.map((t) => t.key)).toEqual([
      'indepth',
      'eli5',
      'ste',
      'deadpan',
      expect.stringMatching(/^sx[0-9a-f]{6}$/),
    ]);
    expect(warnings).not.toContain('deadpan-omitted');
    expect(validateDocument(html).errors).toEqual([]);
  });

  it('keeps every visual of the STE tab, resolved to the same in-depth assets', () => {
    const { model } = fixtureDocument('with-deadpan');
    const visuals = (key: string) => blocksOf(model, key).filter((b) => b.type !== 'paragraph' && b.type !== 'stepper');
    expect(visuals('deadpan').length).toBeGreaterThan(0);
    expect(visuals('deadpan')).toEqual(visuals('ste'));
  });

  it('round-trips byte-identically through parse and render', () => {
    const parsed = parseDocument(html);
    expect(parsed.model.tabs[3]?.kind).toBe('deadpan');
    expect(renderDocument(parsed.model, parsed.assets, { runtime: parsed.runtime, theme: parsed.theme })).toBe(html);
  });

  it('renders the hint, which says the jokes are not facts, wired to the tab button', () => {
    const hint = TAB_HINTS.deadpan ?? '';
    expect(hint).toBe(
      'A deadpan, tongue-in-cheek retelling of In depth. Facts, numbers and names match In depth; the jokes are not facts.',
    );
    expect(html).toContain(
      `<h2 class="panel-title">Deadpan</h2>\n<p class="tab-hint" id="tab-hint-deadpan" data-eli5-noact>${hint}</p>\n<section`,
    );
    const button = /<button[^>]*id="tabbtn-deadpan"[^>]*>/.exec(html)?.[0] ?? '';
    expect(button).toContain('aria-describedby="tab-hint-deadpan"');
    expect(html.match(/class="tab-hint"/g)).toHaveLength(2);
  });

  it('has no close button and cannot be removed', () => {
    expect(html).not.toContain('data-close-tab="deadpan"');
    expect(() => removeTab(fixtureDocument('with-deadpan').model, 'deadpan', FIXTURE_NOW)).toThrow(
      DocumentMutationError,
    );
  });
});

describe('tab-order validity rule for the Deadpan tab', () => {
  const panelOf = (h: string, key: string): string => {
    const start = h.indexOf(`<div class="tabpanel" role="tabpanel" id="tab-${key}"`);
    const end = h.indexOf('\n</div>', start) + '\n</div>'.length;
    return h.slice(start, end);
  };
  const orderErrors = (h: string): string[] =>
    validateDocument(h)
      .errors.filter((e) => e.rule === 'tab-order')
      .map((e) => e.detail);
  const swap = (h: string, a: string, b: string): string =>
    h.replace(`${panelOf(h, a)}\n${panelOf(h, b)}`, `${panelOf(h, b)}\n${panelOf(h, a)}`);

  it('passes deadpan right after ste, and right after eli5 when there is no ste', () => {
    expect(orderErrors(readGolden('with-deadpan'))).toEqual([]);
    const { model, assets } = buildDocumentModel(input());
    expect(orderErrors(render(model, assets))).toEqual([]);
  });

  it('fails when deadpan precedes ste', () => {
    const html = readGolden('with-deadpan');
    const swapped = swap(html, 'ste', 'deadpan');
    expect(swapped).not.toBe(html);
    expect(orderErrors(swapped)).toContain('the deadpan tab does not directly follow ste');
  });

  it('fails when a section ELI5 tab precedes deadpan', () => {
    const html = readGolden('with-deadpan');
    const sx = /id="tab-(sx[0-9a-f]{6})"/.exec(html)?.[1] ?? '';
    const swapped = swap(html, 'deadpan', sx);
    expect(swapped).not.toBe(html);
    expect(orderErrors(swapped)).toContain('a section ELI5 tab precedes the deadpan tab');
  });

  it('fails when deadpan precedes eli5 in a document without ste', () => {
    const { model, assets } = buildDocumentModel(input());
    const html = render(model, assets);
    const swapped = swap(html, 'eli5', 'deadpan');
    expect(swapped).not.toBe(html);
    expect(orderErrors(swapped)).toContain('the deadpan tab does not directly follow eli5');
  });
});

describe('regenerating a Deadpan section keeps its visuals (mirror tab)', () => {
  const doc = fixtureDocument('with-deadpan');
  const tab = tabOf(doc.model, 'deadpan');
  const target = tab?.sections.find((s) => s.blocks.some((b) => b.type !== 'paragraph' && b.type !== 'stepper'));
  if (!target) throw new Error('fixture');
  const own = target.blocks.filter((b) => b.type === 'figure' || b.type === 'chart' || b.type === 'animation');

  it('puts back a visual the model left out and adds no animation', () => {
    const r = replaceSection(
      doc.model,
      target.id,
      { heading: 'Again, somehow', blocks: [{ type: 'paragraph', md: 'Only text. Bold choice.' }] },
      'reexplain',
      LATER,
      { idSource: new SeededIdSource(5), assets: doc.assets },
    );
    const next = r.model.tabs.find((t) => t.key === 'deadpan')?.sections.find((s) => s.id === target.id);
    const kept = next?.blocks.filter((b) => b.type === 'figure' || b.type === 'chart') ?? [];
    expect(kept).toEqual(own.filter((b) => b.type !== 'animation'));
    expect(r.warnings).toContain('ste-visual-restored');
    expect(next?.blocks.filter((b) => b.type === 'animation')).toEqual([]);
    expect(countDocAnimations(r.model.tabs)).toBe(countDocAnimations(doc.model.tabs));
  });

  it('brings an animation back only through a keep marker', () => {
    const anim = tab?.sections.find((s) => s.blocks.some((b) => b.type === 'animation'));
    if (!anim) throw new Error('fixture');
    const r = replaceSection(
      doc.model,
      anim.id,
      {
        heading: anim.heading,
        // The draft form shows the animation as its keep marker (08 §6.2); returning it keeps it.
        blocks: sectionToDraft(doc.model, anim).blocks.map((b) =>
          b.type === 'paragraph' ? { type: 'paragraph' as const, md: 'Watch this. Riveting.' } : b,
        ),
      },
      'reexplain',
      LATER,
      { idSource: new SeededIdSource(6), assets: doc.assets },
    );
    const next = r.model.tabs.find((t) => t.key === 'deadpan')?.sections.find((s) => s.id === anim.id);
    expect(next?.blocks.filter((b) => b.type === 'animation')).toEqual(
      anim.blocks.filter((b) => b.type === 'animation'),
    );
  });
});

describe('Ask material for the Deadpan tab', () => {
  const { model } = fixtureDocument('with-deadpan');

  it('tabsForDeepAsk never includes the Deadpan tab', () => {
    const keys = tabsForDeepAsk(model).map((t) => t.key);
    expect(keys).not.toContain('deadpan');
    expect(keys.slice(0, 3)).toEqual(['indepth', 'eli5', 'ste']);
  });

  it('inDepthForAsk gives the In depth tab without the references section', () => {
    const t = inDepthForAsk(model);
    expect(t?.kind).toBe('indepth');
    const content = tabOf(model, 'indepth')?.sections.filter((s) => s.kind === 'content') ?? [];
    expect(t?.sections.map((s) => s.heading)).toEqual(content.map((s) => s.heading));
  });
});

describe('merge drops the Deadpan tab (09 §10.3)', () => {
  it('removes it with deadpan-dropped and returns its ids, with the STE ids, for retiring', () => {
    const { model, assets } = buildDocumentModel({
      ...fixtureInput('full', 7),
      docId: MERGE_TARGET_ID,
      slug: 'widget-ad-spend',
      ste: { tab: STE_DRAFT, origins: [[null]] },
      deadpan: { tab: DEADPAN_DRAFT, origins: [[null]] },
    });
    const dropped = ['ste', 'deadpan'].flatMap((k) => tabOf(model, k)?.sections.map((s) => s.id as string) ?? []);
    expect(dropped).toHaveLength(2);
    const source = mergeSource();
    const prep = prepareMergeWeave({
      targetHtml: render(model, assets),
      targetMeta: metaOf(model),
      sourceHtml: source.html,
      sourceMeta: source.meta,
    });
    // The Deadpan text is never offered to the merge model.
    expect(prep.input.target).not.toContain('Just one. It is ROAS');
    const applied = applyMergePlan(prep, WEAVE_PLAN, {
      fromDocId: MERGE_SOURCE_ID,
      fromTitle: MERGE_SOURCE_TITLE,
      mergedAt: MERGED_AT,
      idSource: new SeededIdSource(42),
    });
    expect(applied.model.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5']);
    expect(applied.warnings).toEqual(expect.arrayContaining(['ste-dropped', 'deadpan-dropped']));
    expect(applied.retiredSectionIds).toEqual(dropped as SectionId[]);
    expect(ids(applied.model).filter((id) => dropped.includes(id))).toEqual([]);
    expect(validateDocument(render(applied.model, applied.assets)).errors).toEqual([]);
  });

  it('drops a Deadpan tab on its own (no STE tab)', () => {
    const { model, assets } = buildDocumentModel({
      ...fixtureInput('full', 7),
      docId: MERGE_TARGET_ID,
      slug: 'widget-ad-spend',
      deadpan: { tab: DEADPAN_DRAFT, origins: [[null]] },
    });
    const source = mergeSource();
    const prep = prepareMergeWeave({
      targetHtml: render(model, assets),
      targetMeta: metaOf(model),
      sourceHtml: source.html,
      sourceMeta: source.meta,
    });
    const applied = applyMergePlan(prep, WEAVE_PLAN, {
      fromDocId: MERGE_SOURCE_ID,
      fromTitle: MERGE_SOURCE_TITLE,
      mergedAt: MERGED_AT,
      idSource: new SeededIdSource(42),
    });
    expect(applied.warnings).toContain('deadpan-dropped');
    expect(applied.warnings).not.toContain('ste-dropped');
    expect(applied.retiredSectionIds).toEqual(tabOf(model, 'deadpan')?.sections.map((s) => s.id));
  });
});
