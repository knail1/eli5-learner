import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeadpanDraft, DocumentDraftTab, SteDraft } from '../../../../src/main/llm/schemas/draft';
import {
  composeOrigins,
  critiqueInput,
  indepthOutline,
  resolveRewrite,
  resolveSte,
  restoreAnimations,
  SteResolveError,
  steInputJson,
} from '../../../../src/main/llm/ste';
import { REPO } from './helpers';

const script = JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/llm/default.json'), 'utf8')) as {
  responses: { 'in-depth': DocumentDraftTab; ste: SteDraft; deadpan: DeadpanDraft };
};
const indepth = (): DocumentDraftTab => structuredClone(script.responses['in-depth']);
const ste = (): SteDraft => structuredClone(script.responses.ste);
const deadpan = (): DeadpanDraft => structuredClone(script.responses.deadpan);

/** A small in-depth draft: section 0 = [p, chart, p, diagram], section 1 = [p]. */
function small(): DocumentDraftTab {
  return {
    kind: 'indepth',
    title: 'T',
    sections: [
      {
        heading: 'A',
        blocks: [
          { type: 'paragraph', md: 'One.' },
          {
            type: 'chart',
            chart: { kind: 'bar', title: 'C', categories: ['x'], series: [{ name: 's', values: [1] }] },
          },
          { type: 'paragraph', md: 'Two.' },
          { type: 'diagram', title: 'D', svg: '<svg></svg>', alt: 'a' },
        ],
      },
      { heading: 'B', blocks: [{ type: 'paragraph', md: 'Three.' }] },
    ],
  };
}

const p = (md: string) => ({ type: 'paragraph' as const, md });
const keep = (block: number) => ({ type: 'keep' as const, block });

describe('resolveSte (02 §12, D15)', () => {
  it('copies kept visuals byte for byte and records their in-depth origin', () => {
    const r = resolveSte(indepth(), ste());
    expect(r.fixes).toEqual([]);
    expect(r.tab.kind).toBe('ste');
    expect(r.tab.sections).toHaveLength(4);
    const src = indepth();
    expect(r.tab.sections[1]?.blocks[1]).toEqual(src.sections[1]?.blocks[0]); // the chart
    expect(r.origins[1]).toEqual([null, { section: 1, block: 0 }, { section: 1, block: 1 }]);
    expect(r.tab.sections[2]?.blocks.at(-1)).toEqual(src.sections[2]?.blocks[2]); // the animation
    expect(r.origins.map((o) => o.length)).toEqual(r.tab.sections.map((s) => s.blocks.length));
  });

  it('drops keeps that are out of range, point at text or repeat, and logs each fix', () => {
    const d: SteDraft = {
      title: 'T',
      terms: [],
      sections: [
        { heading: 'A', blocks: [p('x'), keep(1), keep(1), keep(0), keep(9), keep(-1), keep(3)] },
        { heading: 'B', blocks: [p('y')] },
      ],
    };
    const r = resolveSte(small(), d);
    expect(r.tab.sections[0]?.blocks.map((b) => b.type)).toEqual(['paragraph', 'chart', 'diagram']);
    expect(r.fixes).toHaveLength(4);
    expect(r.fixes.every((f) => f.includes('dropped keep'))).toBe(true);
  });

  it('inserts a missing visual after the nearest preceding kept visual, else at its own index', () => {
    // Diagram (3) kept, chart (1) missing: no kept visual precedes it, so it goes to index 1.
    const a = resolveSte(small(), {
      title: 'T',
      terms: [],
      sections: [
        { heading: 'A', blocks: [p('x'), p('y'), keep(3)] },
        { heading: 'B', blocks: [p('z')] },
      ],
    });
    expect(a.tab.sections[0]?.blocks.map((b) => b.type)).toEqual(['paragraph', 'chart', 'paragraph', 'diagram']);
    expect(a.origins[0]).toEqual([null, { section: 0, block: 1 }, null, { section: 0, block: 3 }]);
    expect(a.fixes).toEqual(['sections[0]: inserted visual 1']);
    // Chart kept first, diagram missing: it follows the chart.
    const b = resolveSte(small(), {
      title: 'T',
      terms: [],
      sections: [
        { heading: 'A', blocks: [keep(1), p('x'), p('y')] },
        { heading: 'B', blocks: [p('z')] },
      ],
    });
    expect(b.tab.sections[0]?.blocks.map((x) => x.type)).toEqual(['chart', 'diagram', 'paragraph', 'paragraph']);
    // Nothing kept at all: every visual still appears exactly once.
    const c = resolveSte(small(), {
      title: 'T',
      terms: [],
      sections: [
        { heading: 'A', blocks: [p('x')] },
        { heading: 'B', blocks: [p('z')] },
      ],
    });
    expect(c.tab.sections[0]?.blocks.filter((x) => x.type !== 'paragraph').map((x) => x.type)).toEqual([
      'chart',
      'diagram',
    ]);
  });

  it('never inserts a missing visual after a kept visual that comes later in In depth', () => {
    // Diagram (3) kept first, chart (1) missing: the chart goes before the diagram, not at index 1.
    const r = resolveSte(small(), {
      title: 'T',
      terms: [],
      sections: [
        { heading: 'A', blocks: [keep(3), p('x'), p('y')] },
        { heading: 'B', blocks: [p('z')] },
      ],
    });
    expect(r.tab.sections[0]?.blocks.map((b) => b.type)).toEqual(['chart', 'diagram', 'paragraph', 'paragraph']);
    expect(r.origins[0]?.slice(0, 2)).toEqual([
      { section: 0, block: 1 },
      { section: 0, block: 3 },
    ]);
  });

  it('resolveSte is resolveRewrite over In depth with kind ste', () => {
    expect(resolveRewrite(indepth(), ste(), 'ste')).toEqual(resolveSte(indepth(), ste()));
  });

  it('refuses a draft whose section count differs from In depth', () => {
    const d = ste();
    d.sections.pop();
    expect(() => resolveSte(indepth(), d)).toThrow(SteResolveError);
  });

  it('the prompt input numbers blocks and never re-sends SVG or animation code', () => {
    const json = JSON.parse(steInputJson(indepth())) as {
      sections: { blocks: { block: number; type: string; svg?: string; js?: string; poster?: string }[] }[];
    };
    for (const s of json.sections) s.blocks.forEach((b, i) => expect(b.block).toBe(i));
    const all = json.sections.flatMap((s) => s.blocks);
    expect(all.some((b) => b.svg !== undefined || b.js !== undefined || b.poster !== undefined)).toBe(false);
    expect(all.map((b) => b.type)).toContain('animation');
  });

  it('the critique input hides animation code and restoreAnimations puts it back by its marker', () => {
    const a = (n: number) => ({
      type: 'animation' as const,
      title: `A${n}`,
      caption: `c${n}`,
      alt: `a${n}`,
      poster: `<svg>${n}</svg>`,
      js: `ELI5.readout('${n}');`,
    });
    const eli5: DocumentDraftTab = {
      kind: 'eli5',
      title: 'E',
      sections: [
        { heading: 'A', blocks: [p('x'), a(1)] },
        { heading: 'B', blocks: [a(2)] },
      ],
    };
    const sent = critiqueInput(eli5);
    expect(JSON.stringify(sent)).not.toContain('ELI5.readout');
    expect(sent.sections[0]?.blocks[1]).toEqual({
      type: 'animation',
      title: 'A1',
      caption: 'c1',
      alt: 'a1',
      poster: 'keep:0',
      js: 'keep:0',
    });
    expect(sent.sections[1]?.blocks[0]).toMatchObject({ poster: 'keep:1', js: 'keep:1' });
    expect(eli5.sections[0]?.blocks[1]).toEqual(a(1)); // the draft itself is untouched
    const marker = (title: string, n: number) => ({
      type: 'animation' as const,
      title,
      caption: '',
      alt: '',
      poster: `keep:${n}`,
      js: `keep:${n}`,
    });
    const revised: DocumentDraftTab = {
      kind: 'eli5',
      title: 'E',
      sections: [
        { heading: 'A', blocks: [marker('New one', 0), p('x')] },
        {
          heading: 'B',
          blocks: [
            // the poster marker must name the same animation as the js marker (audit round 4)
            { ...marker('poster elsewhere', 1), poster: 'keep:0' },
            { ...marker('poster missing', 1), poster: '<svg>new</svg>' },
            marker('', 1),
            marker('repeat', 1),
            marker('unknown', 7),
            { ...marker('plain', 0), js: 'keep', poster: 'keep' },
            { ...a(9), title: 'new code' },
          ],
        },
      ],
    };
    const back = restoreAnimations(revised, eli5);
    // Each marker takes its own animation, blank words come from the draft, and repeated, unknown
    // or unnumbered markers and new code are dropped.
    expect(back.sections[0]?.blocks).toEqual([{ ...a(1), title: 'New one' }, p('x')]);
    expect(back.sections[1]?.blocks).toEqual([a(2)]);
  });

  it('restoreAnimations keeps each animation with its own words when the critique reorders sections', () => {
    const anim = (name: string) => ({
      type: 'animation' as const,
      title: name,
      caption: `${name} caption`,
      alt: `${name} alt`,
      poster: `<svg>${name}</svg>`,
      js: `/*${name}*/`,
    });
    const eli5: DocumentDraftTab = {
      kind: 'eli5',
      title: 'E',
      sections: [
        { heading: 'A', blocks: [p('a'), anim('Queue')] },
        { heading: 'B', blocks: [p('b'), anim('Growth')] },
        { heading: 'C', blocks: [p('c')] },
      ],
    };
    const sent = critiqueInput(eli5);
    const [sa, sb, sc] = sent.sections;
    const back = restoreAnimations({ ...sent, sections: [sb!, sa!, sc!] }, eli5);
    const anims = back.sections.flatMap((s) => s.blocks).filter((b) => b.type === 'animation');
    expect(anims.map((b) => (b.type === 'animation' ? [b.title, b.js] : []))).toEqual([
      ['Growth', '/*Growth*/'],
      ['Queue', '/*Queue*/'],
    ]);
  });

  it('the critique outline has each heading, the first sentence and every sentence with a number', () => {
    const o = indepthOutline(indepth());
    expect(o).toContain('1. Why the plan matters');
    expect(o).toContain('Example Widgets Inc. sells widgets through three channels.');
    expect(o).toContain('Online | 20 | 40');
    expect(o).not.toContain('Its supply plan decides'); // second sentence, no number
  });
});

describe('resolveRewrite for the Deadpan tab', () => {
  it('over the STE tab: stamps kind deadpan, copies the STE visuals and composes origins onto In depth', () => {
    const steTab = resolveSte(indepth(), ste());
    const r = resolveRewrite(steTab.tab, deadpan(), 'deadpan');
    expect(r.fixes).toEqual([]);
    expect(r.tab.kind).toBe('deadpan');
    expect(r.tab.sections).toHaveLength(steTab.tab.sections.length);
    // Origins are positions in the STE tab first ...
    expect(r.origins[1]).toEqual([null, { section: 1, block: 1 }, { section: 1, block: 2 }]);
    // ... and In depth positions once composed through the STE tab's own origins.
    const composed = composeOrigins(r.origins, steTab.origins);
    expect(composed.lost).toBe(0);
    expect(composed.origins[1]).toEqual([null, { section: 1, block: 0 }, { section: 1, block: 1 }]);
    expect(composed.origins[3]).toEqual([null, { section: 3, block: 1 }, null]);
    const src = indepth();
    composed.origins.forEach((sec, si) =>
      sec.forEach((o, bi) => {
        if (o) expect(r.tab.sections[si]?.blocks[bi]).toEqual(src.sections[o.section]?.blocks[o.block]);
      }),
    );
  });

  it('over In depth (no STE tab): bad keeps dropped, every visual still once, origins direct', () => {
    const r = resolveRewrite(indepth(), deadpan(), 'deadpan');
    expect(r.tab.kind).toBe('deadpan');
    // Section 1 of the fixture keeps 1 and 2 (STE numbering): 2 is out of range in In depth.
    expect(r.fixes).toContain('sections[1].blocks[2]: dropped keep 2');
    // The chart (In depth block 0) was not kept, and no kept visual precedes it: it goes to index 0.
    expect(r.tab.sections[1]?.blocks.map((b) => b.type)).toEqual(['chart', 'paragraph', 'table']);
    expect(r.origins[1]).toEqual([{ section: 1, block: 0 }, null, { section: 1, block: 1 }]);
  });

  it('refuses a draft whose section count differs from its source', () => {
    const d = deadpan();
    d.sections.pop();
    expect(() => resolveRewrite(indepth(), d, 'deadpan')).toThrow(SteResolveError);
  });

  it('composeOrigins reports a kept block that has no origin to compose through', () => {
    const out = composeOrigins([[{ section: 0, block: 1 }, null]], [[null, null]]);
    expect(out).toEqual({ origins: [[null, null]], lost: 1 });
  });
});
