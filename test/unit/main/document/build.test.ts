import { describe, expect, it } from 'vitest';
import {
  DocumentBuildError,
  ELI5_PLACEHOLDER_TEXT,
  SECTION_ID_RE,
  buildDocumentModel,
  createNativeImageNormalizer,
  type BuildInput,
  type DocBlock,
  type NativeImageLike,
} from '../../../../src/main/document';
import type { DocumentDraftTab } from '../../../../src/main/llm';
import { FIXTURE_NOW, fixtureInput, makePng } from '../../../fixtures/documents/drafts';
import { SeededIdSource } from '../../../helpers/ids';

function build(p: Partial<BuildInput> = {}): ReturnType<typeof buildDocumentModel> {
  return buildDocumentModel({ ...fixtureInput('full'), ...p });
}

const allIds = (m: ReturnType<typeof build>['model']): string[] => m.tabs.flatMap((t) => t.sections.map((s) => s.id));

describe('buildDocumentModel (07 §5.1)', () => {
  const { model, warnings, assets } = build();

  it('orders tabs indepth, eli5 and titles them', () => {
    expect(model.tabs.map((t) => [t.key, t.kind, t.label])).toEqual([
      ['indepth', 'indepth', 'In depth'],
      ['eli5', 'eli5', 'ELI5'],
    ]);
    expect(model.title).toBe('How Example Widgets Inc. decides where to spend on ads');
    expect(model.formatVersion).toBe(1);
    expect(model.createdAt).toBe(FIXTURE_NOW);
  });

  it('mints well-formed, unique SectionIds under each tab key (07 §4.2)', () => {
    const ids = allIds(model);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of model.tabs) {
      for (const s of t.sections) {
        expect(s.id).toMatch(SECTION_ID_RE);
        expect(s.id.startsWith(`sec-${t.key}-`)).toBe(true);
      }
    }
  });

  it('is deterministic for a seed', () => {
    expect(build().model).toEqual(model);
    expect(allIds(build({ idSource: new SeededIdSource(8) }).model)).not.toEqual(allIds(model));
  });

  it('drops reader questions and sections left empty', () => {
    const blocks = model.tabs[0]?.sections.flatMap((s) => s.blocks) ?? [];
    expect(blocks.some((b) => b.type === 'paragraph' && /would you like/i.test(b.md))).toBe(false);
    expect(model.tabs[0]?.sections.map((s) => s.heading)).not.toContain('Dropped section');
    expect(warnings).toContain('user-question-dropped');
    expect(warnings).toContain('section-dropped-empty');
  });

  it('ends the in-depth tab with a non-model references section', () => {
    const last = model.tabs[0]?.sections.at(-1);
    expect(last).toMatchObject({ kind: 'references', heading: 'Sources', blocks: [] });
    expect(model.references.filter((r) => r.status === 'skipped').map((r) => r.reason)).toEqual([
      'Page required login.',
      'File type is not supported.',
    ]);
    expect(model.references.every((r) => !/\//.test(r.kind === 'file' ? r.label : ''))).toBe(true);
  });

  it('resolves figures to one asset and drops unknown labels', () => {
    const figures = model.tabs[0]?.sections
      .flatMap((s) => s.blocks)
      .filter((b): b is Extract<DocBlock, { type: 'figure' }> => b.type === 'figure');
    expect(figures).toHaveLength(1);
    expect(model.assets).toHaveLength(1);
    expect(model.assets[0]).toMatchObject({ mime: 'image/png', width: 64, height: 40, label: 'Image 1' });
    expect(figures?.[0]?.assetId).toBe(model.assets[0]?.id);
    expect(figures?.[0]?.alt).toBe('The Q3 channel dashboard');
    expect(assets.get(model.assets[0]?.id ?? '')).toBeInstanceOf(Uint8Array);
    expect(warnings).toContain('figure-image-missing');
  });

  it('converts < 2 step steppers to lists and pads short table rows', () => {
    const blocks = model.tabs[0]?.sections.flatMap((s) => s.blocks) ?? [];
    expect(blocks.some((b) => b.type === 'list' && b.ordered && b.items[0]?.startsWith('**Only:**'))).toBe(true);
    const table = blocks.find((b) => b.type === 'table');
    expect(table?.type === 'table' && table.rows[2]).toEqual(['Email', '$1,200', '', '']);
    expect(warnings).toContain('table-row-width');
  });

  it('places glossary notes in the in-depth tab at the first occurrence (07 §9.1)', () => {
    const indepthIds = new Set(model.tabs[0]?.sections.map((s) => s.id));
    expect(model.glossary.map((n) => n.term)).toEqual(['ROAS', 'conversion', 'Attribution window']);
    for (const n of model.glossary) {
      expect(indepthIds.has(n.sectionId)).toBe(true);
      expect(n.id).toMatch(/^g-[0-9a-f]{6}$/);
    }
    // ROAS was requested for section 1 but first appears in section 0.
    expect(model.glossary[0]?.sectionId).toBe(model.tabs[0]?.sections[0]?.id);
    // case-insensitive and whitespace-normalized matches keep the verbatim text
    expect(model.glossary[1]?.anchorText).toBe('conversion');
    expect(model.glossary[2]?.anchorText).toBe('Attribution windows');
    expect(warnings.filter((w) => w === 'glossary-anchor-missing')).toHaveLength(2); // utm (code only), out of range
  });

  it('searches from the anchor section forward before moving earlier (07 §9.1 steps 3-5)', () => {
    const para = (md: string): DocumentDraftTab['sections'][number] => ({
      heading: md.slice(0, 10),
      blocks: [{ type: 'paragraph', md }],
    });
    const indepth: DocumentDraftTab = {
      kind: 'indepth',
      title: 'Example Widgets Inc. ads',
      sections: [para('Widgets sell well.'), para('Search ads cost money.'), para('Search ads pay back.')],
    };
    const entry = (term: string, anchorSectionIndex: number, anchorText: string) => ({
      term,
      explanation: `${term} explained.`,
      anchorSectionIndex,
      anchorText,
    });
    const { model: m, warnings: w } = build({
      indepth,
      glossary: {
        entries: [
          entry('Widgets', 1, 'Widgets'), // only before the anchor section: dropped
          entry('Search ads', 2, 'Search ads'), // found at 2, moved to its first occurrence at 1
        ],
      },
    });
    expect(m.glossary.map((n) => n.term)).toEqual(['Search ads']);
    expect(m.glossary[0]?.sectionId).toBe(m.tabs[0]?.sections[1]?.id);
    expect(w).toContain('glossary-anchor-missing');
  });

  it('maps anchorSectionIndex to draft sections when earlier ones were dropped', () => {
    const indepth: DocumentDraftTab = {
      kind: 'indepth',
      title: 'Example Widgets Inc. ads',
      sections: [
        { heading: 'Dropped', blocks: [{ type: 'paragraph', md: 'Would you like more detail?' }] },
        { heading: 'Kept A', blocks: [{ type: 'paragraph', md: 'Plain words.' }] },
        { heading: 'Kept B', blocks: [{ type: 'paragraph', md: 'Payback period matters.' }] },
      ],
    };
    const { model: m, warnings: w } = build({
      indepth,
      glossary: {
        entries: [
          {
            term: 'Payback period',
            explanation: 'Time to earn it back.',
            anchorSectionIndex: 2,
            anchorText: 'Payback period',
          },
        ],
      },
    });
    expect(w).toContain('section-dropped-empty');
    expect(m.glossary).toHaveLength(1);
    expect(m.glossary[0]?.sectionId).toBe(m.tabs[0]?.sections[1]?.id);
  });

  it('has no glossary when the toggle is off', () => {
    expect(build({ glossary: null }).model.glossary).toEqual([]);
  });

  it('creates a placeholder ELI5 tab when the ELI5 draft is missing (06 §7.1)', () => {
    const { model: m, warnings: w } = build({ eli5: null });
    const eli5 = m.tabs[1];
    expect(eli5?.placeholder).toBe(true);
    expect(eli5?.sections).toHaveLength(1);
    expect(eli5?.sections[0]).toMatchObject({
      origin: 'placeholder',
      blocks: [{ type: 'paragraph', md: ELI5_PLACEHOLDER_TEXT }],
    });
    expect(eli5?.sections[0]?.id).toMatch(/^sec-eli5-/);
    expect(w).toContain('eli5-placeholder');
  });

  it('throws empty_indepth when no in-depth section survives', () => {
    const indepth: DocumentDraftTab = {
      kind: 'indepth',
      title: 't',
      sections: [{ heading: 'h', blocks: [{ type: 'paragraph', md: 'Shall I continue?' }] }],
    };
    expect(() => build({ indepth })).toThrow(DocumentBuildError);
    try {
      build({ indepth });
    } catch (e) {
      expect((e as DocumentBuildError).code).toBe('empty_indepth');
    }
  });

  it('caps sections at 40 per tab and trims title/dek', () => {
    const indepth: DocumentDraftTab = {
      kind: 'indepth',
      title: `  ${'T'.repeat(200)}  `,
      dek: 'D '.repeat(400),
      sections: Array.from({ length: 45 }, (_, i) => ({
        heading: `S${i}`,
        blocks: [{ type: 'paragraph' as const, md: 'x' }],
      })),
    };
    const { model: m, warnings: w } = build({ indepth });
    expect(m.tabs[0]?.sections.filter((s) => s.kind === 'content')).toHaveLength(40);
    expect(w).toContain('sections-capped');
    expect(m.title.length).toBeLessThanOrEqual(120);
    expect(m.dek?.length ?? 0).toBeLessThanOrEqual(300);
  });

  it('never produces org references in the public build (HOOK-DOC-02)', () => {
    expect(model.references.some((r) => r.kind === 'org')).toBe(false);
    expect(model.generator.edition).toBe('public');
    expect(model.theme).toEqual({ id: 'default', version: '1', source: 'default' });
  });

  it('uses an injected image normalizer (07 §5.6)', () => {
    const calls: { width?: number; height?: number }[] = [];
    const fake = (w: number, h: number): NativeImageLike => ({
      isEmpty: () => false,
      getSize: () => ({ width: w, height: h }),
      resize: (o) => (
        calls.push(o),
        fake(o.width ?? Math.round((w * (o.height ?? h)) / h), o.height ?? Math.round((h * (o.width ?? w)) / w))
      ),
      toPNG: () => makePng(4, 4),
      toJPEG: () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    });
    const normalizeImage = createNativeImageNormalizer({ createFromBuffer: () => fake(3200, 1600) });
    const { model: m } = build({ normalizeImage });
    expect(calls).toEqual([{ width: 1600, quality: 'best' }]);
    expect(m.assets[0]).toMatchObject({ mime: 'image/jpeg', width: 1600, height: 800 });
  });
});
