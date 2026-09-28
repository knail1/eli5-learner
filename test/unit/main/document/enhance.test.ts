import { describe, expect, it } from 'vitest';
import { blockTextParts, diffInline, enhanceBlocks } from '../../../../src/main/document/enhance';
import type { DocBlock, EnhRange } from '../../../../src/main/document';

/** Deterministic enhancement marks for woven merges (07 §6.4). Synthetic widget text only. */

const slice = (text: string, ranges: EnhRange[]): string[] => ranges.map((r) => text.slice(r.start, r.end));

describe('diffInline (word level)', () => {
  it('marks inserted words and nothing else', () => {
    const prev = 'Example Widgets Inc. sells widgets through three channels.';
    const next = 'Example Widgets Inc. sells widgets through three channels, and online now leads.';
    const r = diffInline(prev, next, 'm1');
    expect(slice(next, r)).toEqual(['and online now leads']);
    expect(r.every((x) => x.merge === 'm1')).toBe(true);
  });

  it('marks a changed number as inserted and keeps unchanged words unmarked', () => {
    const prev = 'Online orders were 20 thousand last year.';
    const next = 'Online orders were 40 thousand this year.';
    expect(slice(next, diffInline(prev, next, 'm1'))).toEqual(['40', 'this']);
  });

  it('returns no marks for identical text or punctuation-only edits', () => {
    expect(diffInline('Lead time is six weeks.', 'Lead time is six weeks.', 'm1')).toEqual([]);
    expect(diffInline('Lead time is six weeks', 'Lead time is six weeks.', 'm1')).toEqual([]);
  });

  it('marks a whole string when there was no previous text', () => {
    const next = 'A brand new sentence.';
    expect(diffInline('', next, 'm2')).toEqual([{ merge: 'm2', start: 0, end: next.length }]);
  });

  it('carries earlier merge marks through unchanged words', () => {
    const prev = 'Widgets ship weekly from two plants.';
    const earlier: EnhRange[] = [{ merge: 'm1', start: prev.indexOf('from'), end: prev.indexOf('.') }];
    const next = 'Widgets ship weekly from two plants in three regions.';
    const r = diffInline(prev, next, 'm2', earlier);
    expect(r.map((x) => [x.merge, next.slice(x.start, x.end)])).toEqual([
      ['m1', 'from two plants'],
      ['m2', 'in three regions'],
    ]);
  });

  it('stays bounded on long rewrites', () => {
    const prev = Array.from({ length: 900 }, (_, i) => `old${i}`).join(' ');
    const next = Array.from({ length: 900 }, (_, i) => `new${i}`).join(' ');
    const r = diffInline(prev, next, 'm1');
    expect(r).toEqual([{ merge: 'm1', start: 0, end: next.length }]);
  });
});

describe('blockTextParts', () => {
  it('returns plain text per inline string for text blocks and undefined for visuals', () => {
    expect(blockTextParts({ type: 'paragraph', md: 'A **bold** [link](https://example.com)' })).toEqual([
      'A bold link',
    ]);
    expect(blockTextParts({ type: 'list', ordered: false, items: ['One', '*Two*'] })).toEqual(['One', 'Two']);
    expect(
      blockTextParts({
        type: 'stepper',
        title: 'T',
        steps: [
          { label: 'A', md: 'First' },
          { label: 'B', md: 'Second' },
        ],
      }),
    ).toEqual(['First', 'Second']);
    expect(blockTextParts({ type: 'pullquote', text: 'Q' })).toBeUndefined();
  });
});

describe('enhanceBlocks', () => {
  const para = (md: string): DocBlock => ({ type: 'paragraph', md });
  const table: DocBlock = { type: 'table', header: ['Channel', 'Orders'], rows: [['Online', '20']] };

  it('marks kept blocks as unchanged, incoming and unmatched blocks as new, changed visuals as updated', () => {
    const old = [para('Widgets sell well.'), table, para('Lead time is six weeks.')];
    const changedTable: DocBlock = { ...table, rows: [...table.rows, ['Retail', '42']] };
    const next = [
      old[0] as DocBlock,
      changedTable,
      para('Lead time is six weeks, down from eight.'),
      para('A completely unrelated paragraph about warehouse robots.'),
      { type: 'callout', tone: 'note', md: 'Copied from the other document.' } as DocBlock,
    ];
    const enh = enhanceBlocks({
      oldBlocks: old,
      newBlocks: next,
      origins: [
        { kind: 'keep', index: 0 },
        { kind: 'written' },
        { kind: 'written' },
        { kind: 'written' },
        { kind: 'incoming' },
      ],
      merge: 'm1',
    });
    expect(enh).toEqual([
      { block: 1, kind: 'updated', merge: 'm1' },
      {
        block: 2,
        kind: 'text',
        parts: [
          [
            {
              merge: 'm1',
              start: 'Lead time is six weeks, '.length,
              end: 'Lead time is six weeks, down from eight'.length,
            },
          ],
        ],
      },
      { block: 3, kind: 'new', merge: 'm1' },
      { block: 4, kind: 'new', merge: 'm1' },
    ]);
  });

  it('aligns list items: a new item is marked whole, an edited one word by word', () => {
    const old: DocBlock[] = [
      { type: 'list', ordered: false, items: ['The SKU count stays at twelve.', 'Lead time is six weeks.'] },
    ];
    const next: DocBlock[] = [
      {
        type: 'list',
        ordered: false,
        items: ['The SKU count stays at twelve.', 'Returns run at 3%.', 'Lead time is six weeks by sea.'],
      },
    ];
    const enh = enhanceBlocks({ oldBlocks: old, newBlocks: next, origins: [{ kind: 'written' }], merge: 'm1' });
    expect(enh).toEqual([
      {
        block: 0,
        kind: 'text',
        parts: [
          [],
          [{ merge: 'm1', start: 0, end: 'Returns run at 3%.'.length }],
          [{ merge: 'm1', start: 'Lead time is six weeks '.length, end: 'Lead time is six weeks by sea'.length }],
        ],
      },
    ]);
  });

  it('moves earlier marks with their block and turns a whole-block mark into text marks when edited', () => {
    const old = [para('Intro.'), para('Added earlier.')];
    const oldEnh = { blocks: [{ block: 1, kind: 'new' as const, merge: 'm1' }] };
    const next = [
      para('New lead paragraph that is entirely fresh.'),
      para('Intro.'),
      para('Added earlier, now longer.'),
    ];
    const enh = enhanceBlocks({
      oldBlocks: old,
      oldEnh,
      newBlocks: next,
      origins: [{ kind: 'written' }, { kind: 'keep', index: 0 }, { kind: 'written' }],
      merge: 'm2',
    });
    expect(enh[0]).toEqual({ block: 0, kind: 'new', merge: 'm2' });
    expect(enh[1]).toMatchObject({ block: 2, kind: 'text' });
    const parts = enh[1]?.kind === 'text' ? enh[1].parts[0] : [];
    const text = 'Added earlier, now longer.';
    expect(parts?.map((r) => [r.merge, text.slice(r.start, r.end)])).toEqual([
      ['m1', 'Added earlier'],
      ['m2', 'now longer'],
    ]);
  });
});
