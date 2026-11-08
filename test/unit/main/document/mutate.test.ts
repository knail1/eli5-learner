import { describe, expect, it } from 'vitest';
import {
  DocumentBuildError,
  DocumentMutationError,
  MAX_SECTION_ELI5_TABS,
  SECTION_ID_RE,
  TooManyTabsError,
  addSectionEli5Tab,
  carryAnswers,
  getSectionContext,
  insertAnswer,
  locateModelJson,
  locateSection,
  parseDocument,
  removeTab,
  renderDocument,
  replaceSection,
  sectionEli5Label,
  sectionIdsOfTab,
  sectionToDraft,
  type DocBlock,
  type DocumentModel,
  type QaDocBlock,
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

  it('a regenerated chart with a blank title takes the section heading (07 §5.2)', () => {
    const chartDraft: SectionDraft = {
      heading: ' ',
      blocks: [
        {
          type: 'chart',
          chart: { kind: 'bar', title: '', categories: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] },
        },
      ],
    };
    const r = replaceSection(doc.model, id, chartDraft, 'reexplain', LATER, { idSource: new SeededIdSource(3) });
    const block = r.model.tabs[0]?.sections[1]?.blocks[0];
    expect(block?.type === 'chart' && block.chart.title).toBe(doc.model.tabs[0]?.sections[1]?.heading);
    expect(r.warnings).toEqual(['chart-title-derived']);
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

describe('figure assets across regenerations (07 §8)', () => {
  const figSection = doc.model.tabs[0]?.sections.find((s) => s.blocks.some((b) => b.type === 'figure'));
  const label = doc.model.assets[0]?.label ?? '';
  const withFigure: SectionDraft = {
    heading: 'Again',
    blocks: [
      { type: 'paragraph', md: 'Back again.' },
      { type: 'figure', imageLabel: label, caption: 'The dashboard' },
    ],
  };

  it('prunes asset records once no figure references them, so the label no longer resolves', () => {
    if (!figSection) throw new Error('fixture');
    const noFig: SectionDraft = { heading: 'No figure', blocks: [{ type: 'paragraph', md: 'Text only.' }] };
    const a = replaceSection(doc.model, figSection.id, noFig, 'reexplain', LATER, { idSource: new SeededIdSource(4) });
    expect(a.model.assets).toEqual([]);
    const b = replaceSection(a.model, figSection.id, withFigure, 'reexplain', LATER, {
      idSource: new SeededIdSource(5),
    });
    expect(b.model.tabs[0]?.sections.find((s) => s.id === figSection.id)?.blocks.map((x) => x.type)).toEqual([
      'paragraph',
    ]);
    expect(b.warnings).toContain('figure-image-missing');
  });

  it('resolves a label only when its bytes are present when assets are passed', () => {
    if (!figSection) throw new Error('fixture');
    const ok = replaceSection(doc.model, figSection.id, withFigure, 'reexplain', LATER, { assets: doc.assets });
    expect(ok.warnings).not.toContain('figure-image-missing');
    const gone = replaceSection(doc.model, figSection.id, withFigure, 'reexplain', LATER, { assets: new Map() });
    expect(gone.warnings).toContain('figure-image-missing');
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

  it('a selection tab is labelled by its topic and quotes the selection, truncated (08 §7.5)', () => {
    const covered = [from, secAt(base, 0, 2)];
    const long = 'Budget shifted toward search over the year. '.repeat(20).trim();
    const r = addSectionEli5Tab(base, from, long, SECTION_ELI5_DRAFT, LATER, {
      idSource: new SeededIdSource(5),
      selectionOf: covered,
    });
    const tab = r.model.tabs.at(-1);
    expect(tab?.label).toBe('ELI5: ROAS, simply');
    expect(tab?.origin).toEqual({ sectionId: from, selection: long, scope: 'selection', sectionIds: covered });
    const html = render(r.model);
    const quote =
      /<blockquote class="tab-asked"><p><span class="tab-asked-label">You asked about:<\/span> “([^”]*)”<\/p><\/blockquote>/.exec(
        html,
      );
    expect(quote?.[1]?.length).toBeLessThanOrEqual(240);
    expect(quote?.[1]?.endsWith('…')).toBe(true);
    expect(html).toContain(`<p class="tab-from">From: <a href="#${from}">2. How the budget moved</a></p>`);
    // The origin survives a parse and re-render byte for byte.
    expect(render(parseDocument(html).model)).toBe(html);
    // A topic-less draft falls back to the first words of the selection; collisions get suffixes.
    const bare = addSectionEli5Tab(r.model, from, 'safety stock buffer', { ...SECTION_ELI5_DRAFT, title: ' ' }, LATER, {
      selectionOf: [from],
    });
    expect(bare.model.tabs.at(-1)?.label).toBe('ELI5: safety stock buffer');
    const again = addSectionEli5Tab(bare.model, from, 'x y z', SECTION_ELI5_DRAFT, LATER, { selectionOf: [from] });
    expect(again.model.tabs.at(-1)?.label).toBe('ELI5: ROAS, simply (2)');
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

describe('insertAnswer (07 §7.1, 08 Ask)', () => {
  const merged = fixtureDocument('merged');
  const id = secAt(merged.model, 0, 0);
  const answer = {
    question: '  Is a ROAS of 4\n good?  ',
    topic: 'What a good ROAS is',
    quote: 'A channel with a ROAS of 4 returns four dollars.',
    paragraphs: ['Yes, for most channels.', 'Would you like me to compare channels?', '  '],
  };
  const qaAt = (m: DocumentModel, i: number): QaDocBlock => {
    const b = m.tabs[0]?.sections[0]?.blocks[i];
    if (b?.type !== 'qa') throw new Error(`block ${i} is ${b?.type ?? 'missing'}`);
    return b;
  };

  it('inserts after the block, keeps the SectionId and stamps lastAction, updatedAt', () => {
    const { model, qaId } = insertAnswer(merged.model, id, 0, answer, LATER, { idSource: new SeededIdSource(5) });
    expect(qaId).toMatch(/^q-[0-9a-f]{8}$/);
    const sec = model.tabs[0]?.sections[0];
    expect(sec?.id).toBe(id);
    expect(sec?.origin).toBe(merged.model.tabs[0]?.sections[0]?.origin);
    expect(sec?.lastAction).toBe('ask');
    expect(sec?.updatedAt).toBe(LATER);
    expect(model.updatedAt).toBe(LATER);
    expect(sec?.blocks).toHaveLength((merged.model.tabs[0]?.sections[0]?.blocks.length ?? 0) + 1);
    const box = qaAt(model, 1);
    expect(box).toEqual({
      type: 'qa',
      id: qaId,
      question: 'Is a ROAS of 4 good?',
      topic: 'What a good ROAS is',
      quote: 'A channel with a ROAS of 4 returns four dollars.',
      // The reader-question paragraph and the empty one are dropped (isUserQuestion).
      paragraphs: ['Yes, for most channels.'],
      askedAt: LATER,
    });
    // Pure: the input model is untouched.
    expect(merged.model.tabs[0]?.sections[0]?.blocks.some((b) => b.type === 'qa')).toBe(false);
  });

  it('shifts glossary anchors and merge marks at or after the box, and keeps the marks', () => {
    const { model } = insertAnswer(merged.model, id, 0, answer, LATER, { idSource: new SeededIdSource(5) });
    const before = merged.model.glossary.filter((n) => n.sectionId === id).map((n) => n.blockIndex);
    const after = model.glossary.filter((n) => n.sectionId === id).map((n) => n.blockIndex);
    expect(before).toEqual([0, 1]);
    expect(after).toEqual([0, 2]);
    const others = (m: DocumentModel) => m.glossary.filter((n) => n.sectionId !== id);
    expect(others(model)).toEqual(others(merged.model));
    expect(merged.model.tabs[0]?.sections[0]?.enh?.blocks.map((e) => e.block)).toEqual([0, 1, 5]);
    expect(model.tabs[0]?.sections[0]?.enh?.blocks.map((e) => e.block)).toEqual([0, 2, 6]);
    const html = renderDocument(model, merged.assets, { runtime: STUB_RUNTIME, theme: merged.theme });
    expect(validateDocument(html).errors).toEqual([]);
    expect(parseDocument(html).model).toEqual(model);
  });

  it('stacks later answers after earlier ones in the order asked', () => {
    const src = new SeededIdSource(9);
    const a = insertAnswer(merged.model, id, 0, { ...answer, question: 'First?' }, LATER, { idSource: src });
    const b = insertAnswer(a.model, id, 0, { ...answer, question: 'Second?' }, LATER, { idSource: src });
    expect(qaAt(b.model, 1).question).toBe('First?');
    expect(qaAt(b.model, 2).question).toBe('Second?');
    expect(b.qaId).not.toBe(a.qaId);
    // A follow-up asked inside the first box also lands after the stack.
    const c = insertAnswer(b.model, id, 1, { ...answer, question: 'Third?' }, LATER, { idSource: src });
    expect(qaAt(c.model, 3).question).toBe('Third?');
  });

  it('falls back to the end of the section when the block is unknown', () => {
    const n = merged.model.tabs[0]?.sections[0]?.blocks.length ?? 0;
    for (const at of [undefined, -1, n, 1.5]) {
      const { model } = insertAnswer(merged.model, id, at, answer, LATER, { idSource: new SeededIdSource(5) });
      expect(model.tabs[0]?.sections[0]?.blocks[n]?.type).toBe('qa');
    }
  });

  it('never reuses a section, glossary, answer or retired id', () => {
    // The seeded source draws the same hex each time; the first draw is taken, so it redraws.
    const first = insertAnswer(merged.model, id, 0, answer, LATER, { idSource: new SeededIdSource(5) }).qaId;
    const again = insertAnswer(merged.model, id, 0, answer, LATER, {
      idSource: new SeededIdSource(5),
      retiredIds: [first],
    }).qaId;
    expect(again).not.toBe(first);
    const twice = insertAnswer(
      insertAnswer(merged.model, id, 0, answer, LATER, { idSource: new SeededIdSource(5) }).model,
      id,
      0,
      answer,
      LATER,
      { idSource: new SeededIdSource(5) },
    ).qaId;
    expect(twice).not.toBe(first);
  });

  it('caps the stored strings and refuses an answer with nothing left', () => {
    const long = insertAnswer(
      merged.model,
      id,
      0,
      {
        question: 'q'.repeat(600),
        topic: 't'.repeat(60),
        quote: 'w '.repeat(200),
        paragraphs: ['a', 'b', 'c', 'd', 'e'],
      },
      LATER,
      { idSource: new SeededIdSource(5) },
    ).model;
    const box = qaAt(long, 1);
    expect(box.question.length).toBeLessThanOrEqual(500);
    expect(box.topic.length).toBeLessThanOrEqual(48);
    expect(box.quote.length).toBeLessThanOrEqual(160);
    expect(box.paragraphs).toEqual(['a', 'b', 'c', 'd']);
    expect(() =>
      insertAnswer(merged.model, id, 0, { ...answer, paragraphs: ['Do you want me to go on?'] }, LATER),
    ).toThrow(DocumentBuildError);
    expect(() => insertAnswer(merged.model, id, 0, { ...answer, question: '   ' }, LATER)).toThrow(DocumentBuildError);
    const refs = merged.model.tabs[0]?.sections.find((x) => x.kind === 'references')?.id;
    if (!refs) throw new Error('fixture');
    expect(() => insertAnswer(merged.model, refs, 0, answer, LATER)).toThrow(DocumentMutationError);
    expect(() => insertAnswer(merged.model, 'sec-indepth-00000000' as SectionId, 0, answer, LATER)).toThrow(
      DocumentMutationError,
    );
  });

  it('keeps answers through a rewrite, at the end, and hides them from the model', () => {
    const src = new SeededIdSource(9);
    const a = insertAnswer(doc.model, secAt(doc.model, 0, 0), 0, { ...answer, question: 'One?' }, LATER, {
      idSource: src,
    });
    const b = insertAnswer(a.model, secAt(doc.model, 0, 0), 2, { ...answer, question: 'Two?' }, LATER, {
      idSource: src,
    });
    const sec = b.model.tabs[0]?.sections[0];
    if (!sec) throw new Error('fixture');
    expect(sectionToDraft(b.model, sec).blocks.some((x) => (x.type as string) === 'qa')).toBe(false);
    expect(getSectionContext(b.model, sec.id).draft.blocks).toHaveLength(sec.blocks.length - 2);
    const rewritten = replaceSection(
      b.model,
      sec.id,
      { heading: 'New', blocks: [{ type: 'paragraph', md: 'Rewritten text.' }] },
      'expand',
      LATER,
      { idSource: new SeededIdSource(3) },
    ).model;
    const blocks = rewritten.tabs[0]?.sections[0]?.blocks ?? [];
    expect(blocks.map((x) => x.type)).toEqual(['paragraph', 'qa', 'qa']);
    expect(blocks.flatMap((x) => (x.type === 'qa' ? [x.id] : []))).toEqual([a.qaId, b.qaId]);
  });
});

describe('carryAnswers (07 §7.1)', () => {
  const qa = (id: string): QaDocBlock => ({
    type: 'qa',
    id,
    question: 'Why?',
    topic: 'Why',
    quote: '',
    paragraphs: ['Because.'],
    askedAt: LATER,
  });
  const p = (md: string): DocBlock => ({ type: 'paragraph', md });

  it('re-appends only the boxes the new blocks lack, in their old order', () => {
    const old = [p('a'), qa('q-00000001'), p('b'), qa('q-00000002')];
    expect(carryAnswers(old, [p('x')])).toEqual([p('x'), qa('q-00000001'), qa('q-00000002')]);
    expect(carryAnswers(old, [qa('q-00000002'), p('x')])).toEqual([qa('q-00000002'), p('x'), qa('q-00000001')]);
    expect(carryAnswers([p('a')], [p('x')])).toEqual([p('x')]);
  });
});
