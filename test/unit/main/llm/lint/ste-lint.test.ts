import { describe, expect, it } from 'vitest';
import { isPassive, lintSte, steFindingsText } from '../../../../../src/main/llm/lint/ste-lint';
import type { SteDraft } from '../../../../../src/main/llm/schemas/draft';

const words = (n: number): string => `${Array.from({ length: n }, (_, i) => (i === 0 ? 'The' : 'word')).join(' ')}.`;

function draft(blocks: SteDraft['sections'][number]['blocks'], terms: SteDraft['terms'] = []): SteDraft {
  return { title: 'T', terms, sections: [{ heading: 'H', blocks }] };
}

describe('ASD-STE100 lint (D16)', () => {
  it('limits descriptive sentences to 25 words and procedural ones to 20', () => {
    const ok = lintSte(draft([{ type: 'paragraph', md: words(25) }]));
    expect(ok.findings).toEqual([]);
    const long = lintSte(draft([{ type: 'paragraph', md: words(26) }]));
    expect(long.findings.map((f) => f.rule)).toEqual(['length']);
    expect(long.findings[0]?.detail).toBe('26 words (descriptive limit 25)');
    const step = lintSte(draft([{ type: 'stepper', title: 'S', steps: [{ label: 'a', md: words(21) }] }]));
    expect(step.findings[0]?.detail).toBe('21 words (procedural limit 20)');
    const ordered = lintSte(draft([{ type: 'list', ordered: true, items: [words(21)] }]));
    expect(ordered.failing).toBe(1);
    const unordered = lintSte(draft([{ type: 'list', ordered: false, items: [words(21)] }]));
    expect(unordered.failing).toBe(0);
  });

  it('flags two instructions in one procedural sentence and passive voice, scoring passive only in procedures', () => {
    const r = lintSte(
      draft([
        {
          type: 'stepper',
          title: 'S',
          steps: [
            { label: 'a', md: 'Open the valve and then close the cap.' },
            { label: 'b', md: 'Check the gauge; record the value.' },
            { label: 'c', md: 'Check the gauge.' },
            { label: 'd', md: 'The cap is removed by hand.' },
          ],
        },
        { type: 'paragraph', md: 'The value is measured by the gauge. The gauge shows the value. It is often wrong.' },
      ]),
    );
    expect(r.findings.map((f) => f.rule)).toEqual(['one-instruction', 'one-instruction', 'passive', 'passive']);
    // The procedural passive fails its sentence; the descriptive one is listed but not scored.
    expect(r.findings[3]?.detail).toBe('passive voice (use the active voice where you can)');
    expect(r.sentences).toBe(7);
    expect(r.failing).toBe(3);
    expect(r.score).toBeCloseTo(3 / 7);
    expect(isPassive('The supply is limited.')).toBe(false);
    expect(isPassive('The plan was approved.')).toBe(true);
    expect(isPassive('The team approved the plan.')).toBe(false);
    expect(isPassive('It is often late.')).toBe(false);
  });

  it('reports a declared term that the text never uses, and ignores kept visuals', () => {
    const r = lintSte(
      draft(
        [
          { type: 'paragraph', md: 'The estimate shows the demand.' },
          { type: 'keep', block: 0 },
        ],
        [
          { term: 'estimate', meaning: 'm' },
          { term: 'safety stock', meaning: 'm' },
        ],
      ),
    );
    expect(r.findings).toEqual([
      { section: -1, rule: 'term-unused', text: 'safety stock', detail: 'declared term never used' },
    ]);
    expect(r.score).toBe(0);
    expect(steFindingsText(r)).toBe('1. terms, "safety stock": declared term never used');
  });
});
