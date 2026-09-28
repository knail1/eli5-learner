import { describe, expect, it } from 'vitest';
import { toPromptText, type ExtractedContent } from '../../../../src/main/extract';
import { newContent } from '../../../../src/main/extract/text-util';

function content(over: Partial<ExtractedContent>): ExtractedContent {
  return { ...newContent({ id: 'src-01', ref: 'Q3 "board" deck.pptx', format: 'pptx' }), ...over };
}

describe('toPromptText (04 §11)', () => {
  it('renders the documented slide example byte for byte', () => {
    const c = content({
      stats: { chars: 0, approxTokens: 0, imagesKept: 1, imagesDropped: 0, elapsedMs: 0, slides: 24 },
      blocks: [
        {
          kind: 'slide',
          index: 3,
          title: 'Revenue bridge',
          blocks: [
            {
              kind: 'list',
              ordered: false,
              items: [{ text: 'Net revenue up 12% YoY', children: [{ text: 'Driven by enterprise renewals' }] }],
            },
            { kind: 'table', header: ['Region', 'Q2', 'Q3'], rows: [['NA', '41', '46']] },
            { kind: 'image', imageId: 'a1b2c3d4-img-2', alt: 'waterfall chart', origin: 'embedded' },
            { kind: 'heading', level: 1, text: 'Inside heading' },
          ],
          notes: { kind: 'notes', text: 'Emphasize that churn is flat...' },
        },
      ],
    });
    expect(toPromptText(c)).toBe(
      [
        '<source ref="Q3 &quot;board&quot; deck.pptx" format="pptx" slides="24" truncated="false">',
        '## Slide 3: Revenue bridge',
        '- Net revenue up 12% YoY',
        '  - Driven by enterprise renewals',
        '| Region | Q2 | Q3 |',
        '| --- | --- | --- |',
        '| NA | 41 | 46 |',
        '[image #a1b2c3d4-img-2: "waterfall chart"]',
        '### Inside heading',
        '> Speaker notes: Emphasize that churn is flat...',
        '</source>',
      ].join('\n'),
    );
  });

  it('renders pages, untitled slides, ordered lists, code, quotes, escaped cells and truncation', () => {
    const c = content({
      format: 'pdf',
      truncated: true,
      stats: { chars: 0, approxTokens: 0, imagesKept: 0, imagesDropped: 0, elapsedMs: 0, pages: 2 },
      blocks: [
        { kind: 'page', number: 1, blocks: [{ kind: 'paragraph', text: 'p1' }] },
        {
          kind: 'page',
          number: 2,
          blocks: [
            { kind: 'list', ordered: true, items: [{ text: 'one' }, { text: 'two' }] },
            { kind: 'paragraph', text: 'a = 1\nb = 2', style: 'code' },
            { kind: 'paragraph', text: 'quoted', style: 'quote' },
            { kind: 'table', caption: 'Costs', rows: [['a|b', 'c\nd']], truncated: { rows: 3 } },
            { kind: 'image', imageId: 'x-img-1', origin: 'page-render' },
          ],
        },
      ],
    });
    expect(toPromptText(c)).toBe(
      [
        '<source ref="Q3 &quot;board&quot; deck.pptx" format="pdf" pages="2" truncated="true">',
        '--- Page 1 ---',
        'p1',
        '',
        '--- Page 2 ---',
        '1. one',
        '2. two',
        '```',
        'a = 1\nb = 2',
        '```',
        '> quoted',
        'Table: Costs',
        '| a\\|b | c d |',
        '[table truncated: 3 more rows]',
        '[image #x-img-1]',
        '</source>',
      ].join('\n'),
    );
    const untitled = content({ blocks: [{ kind: 'slide', index: 2, blocks: [], hidden: true }] });
    expect(toPromptText(untitled)).toContain('## Slide 2 (hidden)');
  });

  it('is deterministic', () => {
    const c = content({ blocks: [{ kind: 'heading', level: 2, text: 'x' }] });
    expect(toPromptText(c)).toBe(toPromptText(structuredClone(c)));
  });
});
