/**
 * Explorable block (07 §5.2, §7.1; design §3): clamping and caps at build time, the deterministic
 * static figure with code-computed outcomes, escaping of model text, and the other block consumers
 * (draft validation, section text, merge serialization).
 */
import { describe, expect, it } from 'vitest';
import {
  addSectionEli5Tab,
  applyMergePlan,
  buildDocumentModel,
  parseDocument,
  renderDocument,
  replaceSection,
  type DocBlock,
  type DocumentModel,
} from '../../../../src/main/document';
import { renderExplorableFigure } from '../../../../src/main/document/charts/explorable';
import { convertBlocks, MAX_EXPLORABLE_TITLE, type ConvertContext } from '../../../../src/main/document/validate';
import type { DocumentDraftTab, DraftBlock, SectionDraft } from '../../../../src/main/llm';
import { validateDraft } from '../../../../src/main/llm/structured';
import { sectionText } from '../../../../src/main/llm/tasks';
import { fixtureInput } from '../../../fixtures/documents/drafts';
import {
  MERGED_AT,
  MERGE_SOURCE_ID,
  MERGE_SOURCE_TITLE,
  WEAVE_PLAN,
  wovenFixture,
} from '../../../fixtures/documents/merge';
import { readGolden, STUB_RUNTIME } from '../../../fixtures/documents/runtime';
import { SeededIdSource } from '../../../helpers/ids';
import { validateDocument } from '../../../helpers/doc-validity';

type Explorable = Extract<DraftBlock, { type: 'explorable' }>;

const GD: Explorable = {
  type: 'explorable',
  title: 'Too small crawls, too big overshoots',
  caption: 'Drag the learning rate.',
  alt: 'A bowl-shaped error curve with three paths.',
  sim: {
    kind: 'gradient-descent',
    surface: 'bowl',
    scale: 1.5,
    start: -4,
    lr: { min: 0.001, max: 2, value: 0.1 },
    steps: 60,
    presets: [0.001, 0.1, 1.5],
  },
};

function convert(blocks: DraftBlock[], take?: () => boolean): { out: DocBlock[]; warnings: string[] } {
  const warnings: string[] = [];
  const ctx: ConvertContext = {
    idSource: new SeededIdSource(1),
    resolveFigure: () => undefined,
    warn: (w) => warnings.push(w),
    ...(take ? { takeExplorable: take } : {}),
  };
  return { out: convertBlocks(blocks, ctx), warnings };
}

const para = (md: string): DraftBlock => ({ type: 'paragraph', md });
const section = (heading: string, ...blocks: DraftBlock[]): SectionDraft => ({ heading, blocks });
const explorablesOf = (m: DocumentModel): number =>
  m.tabs.reduce(
    (n, t) => n + t.sections.reduce((k, s) => k + s.blocks.filter((b) => b.type === 'explorable').length, 0),
    0,
  );

describe('convert (07 §5.2)', () => {
  it('keeps a valid explorable with its numbers as given', () => {
    const { out, warnings } = convert([GD]);
    expect(out).toEqual([GD]);
    expect(warnings).toEqual([]);
  });

  it('clamps numbers and caps text', () => {
    const wild: Explorable = {
      ...GD,
      title: 'x '.repeat(200),
      caption: 'y '.repeat(400),
      alt: '',
      sim: { ...GD.sim, scale: 1e6, steps: 1e9, presets: [9, 0.1, 0.1] } as Explorable['sim'],
    };
    const { out } = convert([wild]);
    const b = out[0];
    if (b?.type !== 'explorable' || b.sim.kind !== 'gradient-descent') throw new Error('kept');
    expect(b.sim.scale).toBe(10);
    expect(b.sim.steps).toBe(200);
    expect(b.sim.presets).toEqual([0.1, 2]);
    expect(b.title.length).toBeLessThanOrEqual(MAX_EXPLORABLE_TITLE);
    expect(b.caption.length).toBeLessThanOrEqual(300);
    expect(b.alt).toBe(b.title); // empty alt falls back to the title
  });

  it('drops an explorable with a non-finite number or an empty title (explorable-dropped)', () => {
    const nan = { ...GD, sim: { ...GD.sim, start: Number.NaN } } as Explorable;
    const untitled = { ...GD, title: '   ' };
    const { out, warnings } = convert([nan, untitled, para('kept')]);
    expect(out).toEqual([{ type: 'paragraph', md: 'kept' }]);
    expect(warnings).toEqual(['explorable-dropped', 'explorable-dropped']);
  });

  it('keeps one per section and asks the tab/document budget for each', () => {
    let asked = 0;
    const { out, warnings } = convert([GD, para('a'), GD], () => {
      asked++;
      return true;
    });
    expect(out.map((b) => b.type)).toEqual(['explorable', 'paragraph']);
    expect(warnings).toEqual(['explorable-dropped']);
    expect(asked).toBe(1);
    expect(convert([GD], () => false).out).toEqual([]);
  });
});

describe('caps in documents (07 §5.2: 1 per section, 2 per tab, 4 per document)', () => {
  const tab = (kind: 'indepth' | 'eli5', n: number): DocumentDraftTab => ({
    kind,
    title: 'Explorables',
    sections: Array.from({ length: n }, (_, i) => section(`Section ${i + 1}`, para(`Text ${i + 1}.`), GD)),
  });

  it('build keeps two per tab and four per document', () => {
    const r = buildDocumentModel({ ...fixtureInput('full'), indepth: tab('indepth', 3), eli5: tab('eli5', 3) });
    expect(
      r.model.tabs.map((t) => t.sections.filter((s) => s.blocks.some((b) => b.type === 'explorable')).length),
    ).toEqual([2, 2]);
    expect(r.warnings.filter((w) => w === 'explorable-dropped')).toHaveLength(2);
    // A section ELI5 tab cannot add a fifth.
    const from = r.model.tabs[0]?.sections[0]?.id;
    if (!from) throw new Error('fixture');
    const added = addSectionEli5Tab(
      r.model,
      from,
      'Text 1.',
      tab('section-eli5' as 'eli5', 1),
      '2026-09-28T09:00:00.000Z',
      {
        idSource: new SeededIdSource(9),
      },
    );
    expect(explorablesOf(added.model)).toBe(4);
    expect(added.warnings).toContain('explorable-dropped');
  });

  it('a regenerated section counts the other sections of its tab', () => {
    const r = buildDocumentModel({ ...fixtureInput('full'), indepth: tab('indepth', 3) });
    const sections = r.model.tabs[0]?.sections ?? [];
    const third = sections[2];
    const first = sections[0];
    if (!third || !first) throw new Error('fixture');
    // The tab already holds two (sections 1 and 2): a third one in section 3 is dropped.
    const a = replaceSection(
      r.model,
      third.id,
      section('Again', para('New.'), GD),
      'expand',
      '2026-09-28T09:00:00.000Z',
    );
    expect(a.warnings).toContain('explorable-dropped');
    expect(explorablesOf(a.model)).toBe(2);
    // Replacing a section that holds one frees its own slot.
    const b = replaceSection(
      r.model,
      first.id,
      section('Again', para('New.'), GD),
      'expand',
      '2026-09-28T09:00:00.000Z',
    );
    expect(b.warnings).not.toContain('explorable-dropped');
    expect(explorablesOf(b.model)).toBe(2);
  });
});

describe('caps in merges (07 §5.2, §8.1)', () => {
  /** The woven-merge target with an explorable in its first two in-depth sections (the tab cap). */
  const atCap = () => {
    const { prep } = wovenFixture();
    const model = structuredClone(prep.target.model);
    const indepth = model.tabs[0];
    if (!indepth) throw new Error('fixture');
    let n = 0;
    indepth.sections = indepth.sections.map((s) =>
      s.kind === 'content' && n++ < 2 ? { ...s, blocks: [...s.blocks, GD as DocBlock] } : s,
    );
    return { ...prep, target: { ...prep.target, model } };
  };
  const apply = (prep: ReturnType<typeof atCap>, plan = WEAVE_PLAN) =>
    applyMergePlan(prep, plan, {
      fromDocId: MERGE_SOURCE_ID,
      fromTitle: MERGE_SOURCE_TITLE,
      mergedAt: MERGED_AT,
      idSource: new SeededIdSource(42),
    });

  it('a revised section that rewrites its own explorable keeps it at the tab cap', () => {
    const prep = atCap();
    const plan = structuredClone(WEAVE_PLAN);
    const rev = plan.indepth.revise[0];
    if (!rev) throw new Error('fixture');
    rev.blocks = [{ type: 'paragraph', md: 'Rewritten.' }, GD];
    const r = apply(prep, plan);
    expect(r.warnings).not.toContain('explorable-dropped');
    expect(explorablesOf(r.model)).toBe(2);
  });

  it('a new explorable beyond the tab cap is dropped unless a revision released a slot', () => {
    const prep = atCap();
    const plan = structuredClone(WEAVE_PLAN);
    const ins = plan.indepth.insert[0];
    if (!ins) throw new Error('fixture');
    ins.blocks = [...ins.blocks, GD];
    plan.indepth.revise = [];
    const r = apply(prep, plan);
    expect(r.warnings).toContain('explorable-dropped');
    expect(explorablesOf(r.model)).toBe(2);
    // A revision that leaves its explorable out frees the slot for the inserted one.
    const freed = apply(prep, { ...plan, indepth: { ...plan.indepth, revise: WEAVE_PLAN.indepth.revise } });
    expect(freed.warnings).not.toContain('explorable-dropped');
    expect(explorablesOf(freed.model)).toBe(2);
  });
});

describe('static figure (07 §7.1, design D8)', () => {
  const html = renderExplorableFigure(GD, 'sec-indepth-0000aaaa-b1');

  it('is a figure with data-params, a role=img SVG and an outcome table computed by code', () => {
    expect(
      html.startsWith('<figure class="explorable" data-kind="gradient-descent" data-params="{&quot;kind&quot;'),
    ).toBe(true);
    expect(html).not.toContain('data-eli5-noact'); // print would hide it (07 §13)
    expect(html).toContain('role="img"');
    expect(html).toContain('lr 0.001: crawls');
    expect(html).toContain('lr 0.1: converges in 37 steps');
    expect(html).toContain('lr 1.5: diverges after 12 steps');
    expect(html).toMatch(
      /<tr><th scope="row">1\.5<\/th><td>diverges<\/td><td class="num">12<\/td><td>flew off<\/td><\/tr>/,
    );
    expect(html).not.toMatch(/<script|<iframe|<foreignObject|\son[a-z]+=|javascript:/i);
  });

  it('is deterministic', () => {
    expect(renderExplorableFigure(GD, 'sec-indepth-0000aaaa-b1')).toBe(html);
  });

  it('escapes model text, including an injected tag in the title', () => {
    const evil = { ...GD, title: '<img src=x onerror="alert(1)">', caption: '"><script>1</script>' };
    const out = renderExplorableFigure(evil, 'b');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;img src=x onerror="alert(1)"&gt;');
  });

  it('re-clamps a hand-edited model and keeps only the text when the numbers are unusable', () => {
    const huge = { ...GD, sim: { ...GD.sim, steps: 1e12 } };
    expect(renderExplorableFigure(huge, 'b')).toContain('&quot;steps&quot;:200');
    const broken = { ...GD, sim: { ...GD.sim, kind: 'eval' } } as unknown as Explorable;
    const out = renderExplorableFigure(broken, 'b');
    expect(out).not.toContain('data-params');
    expect(out).not.toContain('<svg');
    expect(out).toContain(GD.alt);
  });

  it('the showcase golden renders both kinds, adds no script and passes validity', () => {
    const golden = readGolden('showcase');
    expect(golden.match(/<figure class="explorable"/g)).toHaveLength(2);
    expect(golden).toContain('data-kind="metropolis-walk"');
    expect(golden.match(/<script\b/g)).toHaveLength(2); // the model JSON and the runtime
    expect(validateDocument(golden).errors).toEqual([]);
    const parsed = parseDocument(golden);
    expect(renderDocument(parsed.model, parsed.assets, { runtime: STUB_RUNTIME, theme: parsed.theme })).toContain(
      'class="chart-data explorable-data"',
    );
  });
});

describe('other consumers', () => {
  it('draft validation flags only non-finite numbers (02 §10.1)', () => {
    const ok = validateDraft('SectionDraft', section('H', para('p'), GD));
    expect(ok.ok).toBe(true);
    const unknownKind = validateDraft('SectionDraft', {
      heading: 'H',
      blocks: [para('a'), para('b'), para('c'), para('d'), para('e'), { ...GD, sim: { ...GD.sim, kind: 'code' } }],
    });
    expect(unknownKind.ok && unknownKind.dropped).toEqual(['blocks[5]']);
    const inf = validateDraft('SectionDraft', {
      heading: 'H',
      blocks: [para('a'), para('b'), para('c'), para('d'), para('e'), { ...GD, sim: { ...GD.sim, scale: Infinity } }],
    });
    expect(inf.ok && inf.dropped).toEqual(['blocks[5]']);
    // Preset counts are normalized by validation, never dropped or repaired (02 §10.1).
    for (const presets of [[], [0.001, 0.01, 0.1, 1]]) {
      const r = validateDraft('SectionDraft', section('H', para('p'), { ...GD, sim: { ...GD.sim, presets } }));
      expect(r.ok && r.dropped).toEqual([]);
    }
  });

  it('section text names the explorable by title and alt', () => {
    expect(sectionText(section('H', GD))).toBe(`H\nExplorable: ${GD.title}. ${GD.alt}`);
  });
});
