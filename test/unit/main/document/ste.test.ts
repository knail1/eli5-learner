/**
 * The optional ASD-STE100 tab (07 §3, §4.1, §5, §12; design D14, D18): build with origins, tab
 * order, the in-panel hint, validity, not closable, and the merge that drops it.
 */
import { describe, expect, it } from 'vitest';
import {
  DocumentMutationError,
  STE_TAB_KEY,
  STE_TAB_LABEL,
  TAB_HINTS,
  TAB_KEY_RE,
  applyMergePlan,
  buildDocumentModel,
  isTabKey,
  parseDocument,
  prepareMergeWeave,
  removeTab,
  renderDocument,
  type BuildInput,
  type DocumentModel,
} from '../../../../src/main/document';
import { DocumentDraftTabSchema, type DocumentDraftTab } from '../../../../src/main/llm';
import { TAB_KEY_PATTERN, TabRecordSchema } from '../../../../src/main/library/schema';
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
import { PACKING_ANIMATION } from '../../../fixtures/documents/animation';

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

const steInput = (p: Partial<BuildInput> = {}): BuildInput => ({
  ...fixtureInput('full'),
  ste: { tab: STE_DRAFT, origins: [[null]] },
  ...p,
});

const ids = (m: DocumentModel): string[] => m.tabs.flatMap((t) => t.sections.map((s) => s.id));
const render = (m: DocumentModel, assets: ReadonlyMap<string, Uint8Array>): string =>
  renderDocument(m, assets, { runtime: STUB_RUNTIME });

describe('tab keys and kinds (07 §4.1)', () => {
  it("accepts 'ste' everywhere the canonical pattern is used", () => {
    expect(isTabKey('ste')).toBe(true);
    expect(TAB_KEY_RE.test('ste')).toBe(true);
    expect(TAB_KEY_PATTERN.source).toBe(TAB_KEY_RE.source);
    expect(TAB_KEY_RE.test('stex')).toBe(false);
    expect(
      TabRecordSchema.safeParse({
        key: 'ste',
        kind: 'ste',
        label: STE_TAB_LABEL,
        sectionCount: 1,
        createdAt: FIXTURE_NOW,
      }).success,
    ).toBe(true);
    expect(DocumentDraftTabSchema.safeParse(STE_DRAFT).success).toBe(true);
  });
});

describe('buildDocumentModel with an ASD-STE100 tab (07 §5)', () => {
  it('adds a third fixed tab after eli5, with its own section ids', () => {
    const { model } = buildDocumentModel(steInput());
    expect(model.tabs.map((t) => [t.key, t.kind, t.label])).toEqual([
      ['indepth', 'indepth', 'In depth'],
      ['eli5', 'eli5', 'ELI5'],
      [STE_TAB_KEY, 'ste', 'ASD-STE100'],
    ]);
    const ste = model.tabs[2];
    expect(ste?.sections.map((s) => s.id)).toEqual([expect.stringMatching(/^sec-ste-[0-9a-f]{8}$/)]);
    expect(ste?.placeholder).toBeUndefined();
    // Glossary and references stay in-depth only.
    expect(ste?.sections.every((s) => s.kind === 'content')).toBe(true);
    expect(model.glossary.every((n) => n.sectionId.startsWith('sec-indepth-'))).toBe(true);
  });

  it('builds the old two tabs when ste is absent or null', () => {
    for (const ste of [undefined, null]) {
      const { model } = buildDocumentModel({ ...fixtureInput('full'), ste });
      expect(model.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5']);
    }
  });

  it('never keeps more animations in the STE tab than In depth holds', () => {
    const gd = PACKING_ANIMATION;
    const sections = Array.from({ length: 5 }, (_, i) => ({ heading: `Part ${i + 1}`, blocks: [gd] }));
    const count = (m: DocumentModel, key: string): number =>
      (m.tabs.find((t) => t.key === key)?.sections ?? []).flatMap((s) => s.blocks).filter((b) => b.type === 'animation')
        .length;
    // In depth without animations: the STE tab keeps none.
    const none = buildDocumentModel(steInput({ ste: { tab: { ...STE_DRAFT, sections }, origins: [] } }));
    expect(count(none.model, 'indepth')).toBe(0);
    expect(count(none.model, 'ste')).toBe(0);
    expect(none.warnings).toContain('animation-dropped');
    // In depth with one animation: the STE tab keeps at most one.
    const base = fixtureInput('full');
    const indepth = {
      ...base.indepth,
      sections: base.indepth.sections.map((s, i) => (i === 0 ? { ...s, blocks: [...s.blocks, gd] } : s)),
    };
    const one = buildDocumentModel(steInput({ indepth, ste: { tab: { ...STE_DRAFT, sections }, origins: [] } }));
    expect(count(one.model, 'indepth')).toBe(1);
    expect(count(one.model, 'ste')).toBe(1);
  });

  it('omits the tab (never a placeholder) when no STE section survives', () => {
    const empty: DocumentDraftTab = {
      ...STE_DRAFT,
      sections: [{ heading: 'Empty', blocks: [{ type: 'paragraph', md: '   ' }] }],
    };
    const { model, warnings } = buildDocumentModel(steInput({ ste: { tab: empty, origins: [[null]] } }));
    expect(model.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5']);
    expect(warnings).toContain('ste-omitted');
  });

  it('resolves a kept stock photo through its in-depth origin to the same asset', () => {
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
    const ste: DocumentDraftTab = {
      kind: 'ste',
      title: 'Warehouse',
      sections: [{ heading: 'Shelves', blocks: [{ type: 'paragraph', md: 'The widgets are on shelves.' }, photo] }],
    };
    const { model } = buildDocumentModel(
      steInput({
        indepth,
        glossary: null,
        photos: [SHOWCASE_PHOTOS[0]!],
        ste: { tab: ste, origins: [[null, { section: 0, block: 2 }]] },
      }),
    );
    const figureOf = (key: string) =>
      model.tabs
        .find((t) => t.key === key)
        ?.sections.flatMap((s) => s.blocks)
        .find((b) => b.type === 'figure');
    const a = figureOf('indepth');
    const b = figureOf('ste');
    expect(a?.type === 'figure' && a.assetId).toBeTruthy();
    expect(b).toEqual(a);
    expect(model.assets.filter((x) => x.credit)).toHaveLength(1);
  });

  it('drops a photo whose STE block has no origin', () => {
    const ste: DocumentDraftTab = {
      ...STE_DRAFT,
      sections: [
        {
          heading: 'Shelves',
          blocks: [
            { type: 'paragraph', md: 'The widgets are on shelves.' },
            { type: 'photo', query: 'warehouse', purpose: 'the warehouse', alt: 'Shelves' },
          ],
        },
      ],
    };
    const { model, warnings } = buildDocumentModel(steInput({ ste: { tab: ste, origins: [[null, null]] } }));
    expect(model.tabs[2]?.sections[0]?.blocks.map((b) => b.type)).toEqual(['paragraph']);
    expect(warnings).toContain('photo-unresolved');
  });

  it('never mints a reserved id (07 §4.3, rebuild)', () => {
    const first = buildDocumentModel(steInput({ idSource: new SeededIdSource(7) })).model;
    const reserved = ids(first);
    // Same seed: every first draw collides, so each id must be redrawn.
    const second = buildDocumentModel(steInput({ idSource: new SeededIdSource(7), reservedIds: reserved })).model;
    const again = ids(second);
    expect(again.length).toBe(reserved.length);
    expect(again.filter((id) => reserved.includes(id))).toEqual([]);
    expect(new Set(again).size).toBe(again.length);
  });

  it('keeps an overridden createdAt and stamps updatedAt with now', () => {
    const { model } = buildDocumentModel(steInput({ createdAt: '2026-01-01T00:00:00.000Z' }));
    expect(model.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(model.updatedAt).toBe(FIXTURE_NOW);
  });
});

describe('the with-ste golden (07 §12, §13, §16)', () => {
  const html = readGolden('with-ste');

  it('orders tabs [indepth, eli5, ste, sx…] and validates', () => {
    const { model } = fixtureDocument('with-ste');
    expect(model.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5', 'ste', expect.stringMatching(/^sx[0-9a-f]{6}$/)]);
    expect(validateDocument(html).errors).toEqual([]);
  });

  it('round-trips byte-identically through parse and render', () => {
    const parsed = parseDocument(html);
    expect(parsed.model.tabs[2]?.kind).toBe('ste');
    expect(renderDocument(parsed.model, parsed.assets, { runtime: parsed.runtime, theme: parsed.theme })).toBe(html);
  });

  it('renders the hint in the panel as plain HTML, wired to the tab button', () => {
    const hint = TAB_HINTS.ste ?? '';
    expect(hint).toMatch(/^ASD-STE100 is Simplified Technical English/);
    expect(html).toContain(
      `<h2 class="panel-title">ASD-STE100</h2>\n<p class="tab-hint" id="tab-hint-ste" data-eli5-noact>${hint}</p>\n<section`,
    );
    const button = /<button[^>]*id="tabbtn-ste"[^>]*>/.exec(html)?.[0] ?? '';
    expect(button).toContain('aria-describedby="tab-hint-ste"');
    expect(button).toContain(`title="${hint}"`);
    // Exactly one hint: other tabs have none.
    expect(html.match(/class="tab-hint"/g)).toHaveLength(1);
  });

  it('has no close button for the ste tab', () => {
    expect(html).not.toContain('data-close-tab="ste"');
    const { model } = fixtureDocument('with-ste');
    expect(() => removeTab(model, 'ste', FIXTURE_NOW)).toThrow(DocumentMutationError);
  });
});

describe('tab-order validity rule (07 §12)', () => {
  const html = readGolden('with-ste');
  const panel = (key: string): string => {
    const start = html.indexOf(`<div class="tabpanel" role="tabpanel" id="tab-${key}"`);
    const end = html.indexOf('\n</div>', start) + '\n</div>'.length;
    return html.slice(start, end);
  };
  const rules = (h: string): string[] => validateDocument(h).errors.map((e) => e.rule);

  it('passes old two-tab documents', () => {
    expect(validateDocument(readGolden('full')).errors).toEqual([]);
    expect(validateDocument(readGolden('with-tab')).errors).toEqual([]);
  });

  it('fails when a section ELI5 tab precedes ste', () => {
    const sx = /id="tab-(sx[0-9a-f]{6})"/.exec(html)?.[1] ?? '';
    const swapped = html.replace(`${panel('ste')}\n${panel(sx)}`, `${panel(sx)}\n${panel('ste')}`);
    expect(swapped).not.toBe(html);
    const errors = validateDocument(swapped).errors.filter((e) => e.rule === 'tab-order');
    expect(errors.map((e) => e.detail)).toContain('a section ELI5 tab precedes the ste tab');
  });

  it('fails when ste does not directly follow eli5', () => {
    const swapped = html.replace(`${panel('eli5')}\n${panel('ste')}`, `${panel('ste')}\n${panel('eli5')}`);
    expect(swapped).not.toBe(html);
    expect(rules(swapped)).toContain('tab-order');
  });
});

describe('merge drops the ste tab (09 §10.3, D18)', () => {
  it('removes the tab, notes ste-dropped and returns its ids for retiring', () => {
    const { model, assets } = buildDocumentModel({
      ...fixtureInput('full', 7),
      docId: MERGE_TARGET_ID,
      slug: 'widget-ad-spend',
      ste: { tab: STE_DRAFT, origins: [[null]] },
    });
    const steIds: string[] = model.tabs.find((t) => t.key === 'ste')?.sections.map((s) => s.id) ?? [];
    expect(steIds).toHaveLength(1);
    const source = mergeSource();
    const prep = prepareMergeWeave({
      targetHtml: render(model, assets),
      targetMeta: metaOf(model),
      sourceHtml: source.html,
      sourceMeta: source.meta,
    });
    // The STE text is never offered to the merge model.
    expect(prep.input.target).not.toContain('The number is ROAS');
    const applied = applyMergePlan(prep, WEAVE_PLAN, {
      fromDocId: MERGE_SOURCE_ID,
      fromTitle: MERGE_SOURCE_TITLE,
      mergedAt: MERGED_AT,
      idSource: new SeededIdSource(42),
    });
    expect(applied.model.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5']);
    expect(applied.warnings).toContain('ste-dropped');
    expect(applied.retiredSectionIds).toEqual(steIds);
    // New ids never reuse the dropped ones.
    expect(ids(applied.model).filter((id) => steIds.includes(id))).toEqual([]);
    expect(validateDocument(render(applied.model, applied.assets)).errors).toEqual([]);
  });

  it('notes nothing for a target without the tab', () => {
    const { model, assets } = buildDocumentModel({ ...fixtureInput('full', 7), docId: MERGE_TARGET_ID });
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
    expect(applied.warnings).not.toContain('ste-dropped');
    expect(applied.retiredSectionIds).toEqual([]);
  });
});
