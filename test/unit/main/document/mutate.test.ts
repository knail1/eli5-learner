import { describe, expect, it } from 'vitest';
import {
  DocumentBuildError,
  DocumentMutationError,
  MAX_SECTION_ELI5_TABS,
  SECTION_ID_RE,
  TooManyTabsError,
  addSectionEli5Tab,
  getSectionContext,
  locateModelJson,
  locateSection,
  parseDocument,
  removeTab,
  renderDocument,
  replaceSection,
  sectionEli5Label,
  sectionIdsOfTab,
  type DocumentModel,
  type SectionId,
} from '../../../../src/main/document';
import type { DocumentDraftTab, SectionDraft } from '../../../../src/main/llm';
import { fixtureDocument, SECTION_ELI5_DRAFT } from '../../../fixtures/documents/models';
import { STUB_RUNTIME } from '../../../fixtures/documents/runtime';
import { SeededIdSource } from '../../../helpers/ids';
import { validateDocument } from '../../../helpers/doc-validity';

const LATER = '2026-09-28T09:00:00.000Z';
const doc = fixtureDocument('with-tab');
const render = (m: DocumentModel): string => renderDocument(m, doc.assets, { runtime: STUB_RUNTIME, theme: doc.theme });
const ids = (m: DocumentModel): string[] => m.tabs.flatMap((t) => t.sections.map((s) => s.id));
const secAt = (m: DocumentModel, tab: number, i: number): SectionId => {
  const id = m.tabs[tab]?.sections[i]?.id;
  if (!id) throw new Error('fixture');
  return id;
};

describe('replaceSection (07 §8, 08 §6.4)', () => {
  const html = render(doc.model);
  const id = secAt(doc.model, 0, 1);
  const draft: SectionDraft = {
    heading: 'How the budget moved, again',
    blocks: [{ type: 'paragraph', md: 'Rewritten: search now takes most of the spend. ROAS decides.' }],
  };
  const { model: next, warnings } = replaceSection(doc.model, id, draft, 'reexplain', LATER, {
    idSource: new SeededIdSource(3),
  });
  const out = render(next);

  it('keeps the SectionId and stamps origin, lastAction and updatedAt', () => {
    const s = next.tabs[0]?.sections[1];
    expect(s).toMatchObject({
      id,
      origin: 'regenerated',
      lastAction: 'reexplain',
      updatedAt: LATER,
      heading: 'How the budget moved, again',
    });
    expect(next.updatedAt).toBe(LATER);
    expect(ids(next)).toEqual(ids(doc.model));
    expect(warnings).toEqual([]);
  });

  it('changes only that section and the embedded model JSON (byte diff)', () => {
    const secA = locateSection(html, id);
    const secB = locateSection(out, id);
    const jsonA = locateModelJson(html);
    const jsonB = locateModelJson(out);
    if (!secA || !secB || !jsonA || !jsonB) throw new Error('locate failed');
    // Replace both regions with markers; everything else must be byte-identical.
    const strip = (s: string, sec: { start: number; end: number }, json: { start: number; end: number }): string =>
      json.start < sec.start
        ? s.slice(0, json.start) + '<<JSON>>' + s.slice(json.end, sec.start) + '<<SECTION>>' + s.slice(sec.end)
        : s.slice(0, sec.start) + '<<SECTION>>' + s.slice(sec.end, json.start) + '<<JSON>>' + s.slice(json.end);
    expect(strip(out, secB, jsonB)).toBe(strip(html, secA, jsonA));
    expect(out.slice(secB.start, secB.end)).not.toBe(html.slice(secA.start, secA.end));
  });

  it('round-trips and stays valid', () => {
    expect(parseDocument(out).model).toEqual(next);
    expect(validateDocument(out).errors).toEqual([]);
  });

  it('re-anchors that section’s glossary notes and drops missing ones (08 §6.5)', () => {
    const first = secAt(doc.model, 0, 0);
    const before = doc.model.glossary.filter((n) => n.sectionId === first).map((n) => n.term);
    expect(before).toEqual(['ROAS', 'conversion']);
    const r = replaceSection(
      doc.model,
      first,
      { heading: 'Why ROAS', blocks: [{ type: 'paragraph', md: 'Only roas is judged here.' }] },
      'expand',
      LATER,
    );
    const after = r.model.glossary.filter((n) => n.sectionId === first);
    expect(after.map((n) => [n.term, n.anchorText, n.blockIndex])).toEqual([['ROAS', 'roas', 0]]);
    expect(r.warnings).toEqual(['glossary-dropped']);
    // Notes in other sections are untouched.
    expect(r.model.glossary.filter((n) => n.sectionId !== first)).toEqual(
      doc.model.glossary.filter((n) => n.sectionId !== first),
    );
  });

  it('refuses the references section, unknown ids, and drafts with nothing valid', () => {
    const refs = doc.model.tabs[0]?.sections.at(-1)?.id as SectionId;
    expect(() => replaceSection(doc.model, refs, draft, 'expand', LATER)).toThrow(DocumentMutationError);
    expect(() => replaceSection(doc.model, 'sec-indepth-deadbeef' as SectionId, draft, 'expand', LATER)).toThrow(
      DocumentMutationError,
    );
    expect(() =>
      replaceSection(
        doc.model,
        id,
        { heading: 'x', blocks: [{ type: 'paragraph', md: 'Would you like more?' }] },
        'expand',
        LATER,
      ),
    ).toThrow(DocumentBuildError);
  });

  it('clears the placeholder flag when the ELI5 placeholder is regenerated', () => {
    const ph = fixtureDocument('placeholder');
    const pid = secAt(ph.model, 1, 0);
    const r = replaceSection(
      ph.model,
      pid,
      { heading: 'Simple', blocks: [{ type: 'paragraph', md: 'Now it exists.' }] },
      'reexplain',
      LATER,
    );
    expect(r.model.tabs[1]?.placeholder).toBeUndefined();
    expect(r.model.tabs[1]?.sections[0]).toMatchObject({ id: pid, origin: 'regenerated' });
  });
});

describe('getSectionContext (07 §8)', () => {
  it('returns the draft form with figure labels, neighbours and outline', () => {
    const id = secAt(doc.model, 0, 2);
    const ctx = getSectionContext(doc.model, id);
    expect(ctx.tab.key).toBe('indepth');
    expect(ctx.draft.blocks.find((b) => b.type === 'figure')).toMatchObject({ type: 'figure', imageLabel: 'Image 1' });
    expect(ctx.prev?.heading).toBe('2. How the budget moved');
    expect(ctx.next).toBeUndefined(); // references section is not a neighbour
    expect(ctx.outline).toEqual(['Why ad spend is judged by ROAS', '2. How the budget moved', 'How an order flows']);
  });
});

describe('section ELI5 tabs (07 §4, §8)', () => {
  const base = fixtureDocument('full').model;
  const from = secAt(base, 0, 1);

  it('appends a tab with a fresh key and ids, labelled from the heading without numbering', () => {
    const r = addSectionEli5Tab(base, from, '  budget   moved ', SECTION_ELI5_DRAFT, LATER, {
      idSource: new SeededIdSource(5),
    });
    const tab = r.model.tabs.at(-1);
    expect(tab).toMatchObject({
      key: r.tabKey,
      kind: 'section-eli5',
      label: 'ELI5: How the budget moved',
      createdAt: LATER,
    });
    expect(tab?.origin).toEqual({ sectionId: from, selection: 'budget moved' });
    expect(r.tabKey).toMatch(/^sx[0-9a-f]{6}$/);
    for (const s of tab?.sections ?? []) expect(s.id).toMatch(new RegExp(`^sec-${r.tabKey}-[0-9a-f]{8}$`));
    expect(ids(r.model).slice(0, ids(base).length)).toEqual(ids(base));
    expect(
      validateDocument(renderDocument(r.model, new Map(), { runtime: STUB_RUNTIME })).errors.filter(
        (e) => e.rule !== 'references',
      ),
    ).toEqual([]);
  });

  it('suffixes duplicate labels and never uses a bare number', () => {
    const a = addSectionEli5Tab(base, from, 'x', SECTION_ELI5_DRAFT, LATER);
    const b = addSectionEli5Tab(a.model, from, 'x', SECTION_ELI5_DRAFT, LATER);
    expect(b.model.tabs.map((t) => t.label).slice(2)).toEqual([
      'ELI5: How the budget moved',
      'ELI5: How the budget moved (2)',
    ]);
    expect(sectionEli5Label('3.', 'one two three four five six seven', [])).toBe('ELI5: one two three four five six');
    expect(sectionEli5Label('II. Background', '', [])).toBe('ELI5: Background');
    expect(sectionEli5Label('', '42', [])).toBe('ELI5: Section');
  });

  it('enforces the 20-tab limit', () => {
    let m = base;
    for (let i = 0; i < MAX_SECTION_ELI5_TABS; i++)
      m = addSectionEli5Tab(m, from, 'x', SECTION_ELI5_DRAFT, LATER).model;
    expect(() => addSectionEli5Tab(m, from, 'x', SECTION_ELI5_DRAFT, LATER)).toThrow(TooManyTabsError);
  });

  it('never reuses retired ids or keys after a close (07 §4.3)', () => {
    const scripted = {
      i: 0,
      vals: ['aaaaaa', 'bbbbbbbb', 'aaaaaa', 'cccccc', 'bbbbbbbb', 'dddddddd'],
      hex(): string {
        return this.vals[this.i++] ?? '00000000';
      },
    };
    const one = addSectionEli5Tab(base, from, 'x', SECTION_ELI5_DRAFT, LATER, { idSource: scripted });
    expect(one.tabKey).toBe('sxaaaaaa');
    const retired = sectionIdsOfTab(one.model, one.tabKey);
    expect(retired).toEqual(['sec-sxaaaaaa-bbbbbbbb']);
    const closed = removeTab(one.model, one.tabKey, LATER);
    expect(closed.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5']);
    expect(ids(closed)).toEqual(ids(base));
    const two = addSectionEli5Tab(closed, from, 'x', SECTION_ELI5_DRAFT, LATER, {
      idSource: scripted,
      retiredIds: retired,
    });
    expect(two.tabKey).toBe('sxcccccc');
  });

  it('removes only section ELI5 tabs', () => {
    expect(() => removeTab(base, 'indepth', LATER)).toThrow(DocumentMutationError);
    expect(() => removeTab(base, 'eli5', LATER)).toThrow(DocumentMutationError);
    expect(() => removeTab(base, 'sx000000', LATER)).toThrow(DocumentMutationError);
  });

  it('refuses unknown sources and empty drafts', () => {
    const empty: DocumentDraftTab = {
      kind: 'section-eli5',
      title: 't',
      sections: [{ heading: 'h', blocks: [{ type: 'paragraph', md: ' ' }] }],
    };
    expect(() => addSectionEli5Tab(base, 'sec-indepth-deadbeef' as SectionId, 'x', SECTION_ELI5_DRAFT, LATER)).toThrow(
      DocumentMutationError,
    );
    expect(() => addSectionEli5Tab(base, from, 'x', empty, LATER)).toThrow(DocumentBuildError);
  });

  it('mints ids that match SECTION_ID_RE across many tabs', () => {
    let m = base;
    for (let i = 0; i < 5; i++) m = addSectionEli5Tab(m, from, 'x', SECTION_ELI5_DRAFT, LATER).model;
    const all = ids(m);
    expect(new Set(all).size).toBe(all.length);
    for (const i of all) expect(i).toMatch(SECTION_ID_RE);
  });
});
