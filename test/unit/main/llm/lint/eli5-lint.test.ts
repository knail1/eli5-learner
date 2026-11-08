import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  critiqueGate,
  eli5FindingsText,
  lintEli5,
  syllables,
  tabNumbers,
} from '../../../../../src/main/llm/lint/eli5-lint';
import type { DocumentDraftTab } from '../../../../../src/main/llm/schemas/draft';
import { REPO } from '../helpers';

const script = JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/llm/default.json'), 'utf8')) as {
  responses: Record<'in-depth' | 'eli5' | 'eli5-critique', DocumentDraftTab>;
};
const indepth = (): DocumentDraftTab => structuredClone(script.responses['in-depth']);
const first = (): DocumentDraftTab => structuredClone(script.responses.eli5);
const revised = (): DocumentDraftTab => structuredClone(script.responses['eli5-critique']);

const tab = (sections: DocumentDraftTab['sections']): DocumentDraftTab => ({ kind: 'eli5', title: 'T', sections });

describe('ELI5 lint (D17)', () => {
  it('finds long sentences, long words, symbols, missing pictures and terms without an analogy', () => {
    const long = `${Array.from({ length: 22 }, () => 'cat').join(' ')}.`;
    const r = lintEli5(
      tab([
        {
          heading: 'One',
          blocks: [
            { type: 'paragraph', md: `${long} Heteroscedasticity matters. The posterior σ shrinks.` },
            { type: 'paragraph', md: 'We keep safety stock everywhere.' },
          ],
        },
        { heading: 'Two', blocks: [{ type: 'analogy', md: 'Safety stock is like a spare tyre.' }] },
      ]),
      {
        kind: 'indepth',
        title: 'I',
        sections: [{ heading: 'H', blocks: [{ type: 'paragraph', md: 'Add **safety stock**.' }] }],
      },
    );
    const rules = r.findings.map((f) => `${f.section}:${f.rule}`);
    expect(rules).toContain('0:long-sentence');
    expect(rules).toContain('0:long-word');
    expect(rules).toContain('0:symbol');
    expect(rules).toContain('0:term-no-analogy'); // section 2 has an analogy, so only section 1
    expect(rules).toContain('0:no-visual');
    expect(rules).not.toContain('1:term-no-analogy');
    expect(rules).not.toContain('1:no-visual');
    expect(r.findings.find((f) => f.rule === 'long-word')?.text).toBe('heteroscedasticity');
    expect(eli5FindingsText(r)).toMatch(/^1\. section 1, /);
  });

  it('flags a high average sentence length for the whole tab', () => {
    const s = `Big ${Array.from({ length: 17 }, () => 'dog').join(' ')}.`;
    const r = lintEli5(tab([{ heading: 'H', blocks: [{ type: 'analogy', md: `${s} ${s}` }] }]));
    expect(r.findings.map((f) => f.rule)).toEqual(['average']);
  });

  it('counts syllables well enough and lets everyday words through', () => {
    expect(syllables('cat')).toBe(1);
    expect(syllables('table')).toBe(2);
    expect(syllables('heteroscedasticity')).toBeGreaterThanOrEqual(6);
    const r = lintEli5(
      tab([{ heading: 'H', blocks: [{ type: 'analogy', md: 'Everybody usually likes information.' }] }]),
    );
    expect(r.findings).toEqual([]);
  });
});

describe('ELI5 critique accept gate (D17)', () => {
  it('accepts the fixture revision: more pictures, fewer findings, no new numbers', () => {
    const g = critiqueGate(first(), revised(), indepth());
    expect(g).toMatchObject({ ok: true });
    expect(g.lintAfter).toBeLessThanOrEqual(g.lintBefore);
  });

  it('rejects a section count outside +-1 or below 3', () => {
    const r = revised();
    r.sections.push(...structuredClone(r.sections)); // 6 vs 2
    expect(critiqueGate(first(), r, indepth())).toMatchObject({ ok: false, reason: 'sections' });
    const two = revised();
    two.sections.pop(); // 2 sections: within one, but below 3
    expect(critiqueGate(first(), two, indepth())).toMatchObject({ ok: false, reason: 'sections' });
  });

  it('rejects fewer visual blocks and a dropped photo or figure', () => {
    const f = first();
    f.sections[1]?.blocks.push({ type: 'diagram', title: 'd', svg: '<svg/>', alt: 'a' });
    f.sections[0]?.blocks.push({ type: 'diagram', title: 'd', svg: '<svg/>', alt: 'a' });
    f.sections[1]?.blocks.push({ type: 'diagram', title: 'd', svg: '<svg/>', alt: 'a' });
    f.sections[0]?.blocks.push({ type: 'diagram', title: 'd', svg: '<svg/>', alt: 'a' });
    expect(critiqueGate(f, revised(), indepth())).toMatchObject({ ok: false, reason: 'visuals' });
    const withPhoto = first();
    withPhoto.sections[0]?.blocks.push({ type: 'photo', query: 'shelves', purpose: 'p', alt: 'a' });
    expect(critiqueGate(withPhoto, revised(), indepth())).toMatchObject({ ok: false, reason: 'media' });
  });

  it('counts an animation as a picture and rejects a revision that drops one or changes its code', () => {
    const anim = {
      type: 'animation' as const,
      title: 'Busy weeks empty the shelves',
      caption: 'Drag the extra stock and watch 26 weeks.',
      alt: 'Bars of weekly demand.',
      poster: '<svg/>',
      js: "ELI5.readout('weeks');",
    };
    const lone = tab([{ heading: 'A', blocks: [{ type: 'paragraph', md: 'Short words here.' }, anim] }]);
    expect(lintEli5(lone).findings.map((f) => f.rule)).not.toContain('no-visual');
    // Its caption states numbers like any text.
    expect([...tabNumbers(lone)]).toContain('26');
    const f = first();
    f.sections[1]?.blocks.push(anim);
    const kept = revised();
    kept.sections[1]?.blocks.push({ ...anim, title: 'Extra stock covers busy weeks' });
    expect(critiqueGate(f, kept, indepth())).toMatchObject({ ok: true });
    expect(critiqueGate(f, revised(), indepth())).toMatchObject({ ok: false });
    const rewritten = revised();
    rewritten.sections[1]?.blocks.push({ ...anim, js: "ELI5.readout('new');" });
    expect(critiqueGate(f, rewritten, indepth())).toMatchObject({ ok: false, reason: 'media' });
  });

  it('rejects a revision with more lint findings', () => {
    const r = revised();
    r.sections[0]?.blocks.push({ type: 'paragraph', md: 'Heteroscedasticity and multicollinearity confuse everyone.' });
    expect(critiqueGate(first(), r, indepth())).toMatchObject({ ok: false, reason: 'lint' });
  });

  it('rejects a number found in neither the draft nor In depth; small counts and known numbers pass', () => {
    const r = revised();
    r.sections[0]?.blocks.push({ type: 'analogy', md: 'Online orders went from 20 to 40.' });
    expect(critiqueGate(first(), r, indepth())).toMatchObject({ ok: true });
    const bad = revised();
    bad.sections[0]?.blocks.push({ type: 'analogy', md: 'Orders grew by 73 in a week.' });
    expect(critiqueGate(first(), bad, indepth())).toMatchObject({ ok: false, reason: 'new-number' });
    // A rounding of a known number (40 -> about 42, within 10%) is not a new fact.
    const rounded = revised();
    rounded.sections[0]?.blocks.push({ type: 'analogy', md: 'Online orders reached about 42.' });
    expect(critiqueGate(first(), rounded, indepth())).toMatchObject({ ok: true });
    const far = revised();
    far.sections[0]?.blocks.push({ type: 'analogy', md: 'Online orders reached about 48.' });
    expect(critiqueGate(first(), far, indepth())).toMatchObject({ ok: false, reason: 'new-number' });
    expect([
      ...tabNumbers(tab([{ heading: '3 steps', blocks: [{ type: 'paragraph', md: 'About 1,200 or 3.5.' }] }])),
    ]).toEqual(['1200', '3.5']);
  });
});
