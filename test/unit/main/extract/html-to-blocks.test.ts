import { describe, expect, it } from 'vitest';
import { extractSource, htmlToBlocks } from '../../../../src/main/extract';
import { domToBlocks, parseBody } from '../../../../src/main/extract/html-to-blocks';
import { fixtureSource, testContext } from '../../../contracts/extractor.contract';

describe('htmlToBlocks (04 §9.3)', () => {
  it('maps headings, paragraphs, lists, tables, quotes and code', () => {
    const { blocks } = htmlToBlocks(
      '<h2>Title</h2><p>One <em>two</em> <a href="https://example.com/x">link text</a></p>' +
        '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>' +
        '<table><tr><th>H1</th><th>H2</th></tr><tr><td colspan="2">wide</td></tr></table>' +
        '<blockquote><p>q1</p><p>q2</p></blockquote><pre>  x = 1\n  y = 2</pre>',
    );
    expect(blocks).toEqual([
      { kind: 'heading', level: 2, text: 'Title' },
      { kind: 'paragraph', text: 'One two link text' },
      { kind: 'list', ordered: false, items: [{ text: 'a', children: [{ text: 'b' }] }, { text: 'c' }] },
      { kind: 'table', header: ['H1', 'H2'], rows: [['wide', '']] },
      { kind: 'paragraph', text: 'q1', style: 'quote' },
      { kind: 'paragraph', text: 'q2', style: 'quote' },
      { kind: 'paragraph', text: '  x = 1\n  y = 2', style: 'code' },
    ]);
  });

  it('drops script, style, nav, svg and form, and keeps remote image alt text inline', () => {
    const { blocks, imageRefs } = htmlToBlocks(
      '<nav>Menu</nav><script>alert(1)</script><style>p{}</style><svg><text>chart</text></svg>' +
        '<form><input value="q"></form><p>See <img src="https://example.com/a.png" alt="the chart"> here</p>',
    );
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'See [image: the chart] here' }]);
    expect(imageRefs).toEqual([]);
  });

  it('turns docx placeholders into image blocks (also in table cells) and flattens nested tables', () => {
    const { blocks, imageRefs } = domToBlocks(
      parseBody(
        '<p><img data-eli5-img="docx-img:0" alt="Diagram"></p><table><tr><td>x<table><tr><td>a</td><td>b</td></tr></table></td>' +
          '<td><p><img data-eli5-img="docx-img:1" alt="Cell chart"></p></td></tr></table>',
      ),
      { placeholders: true },
    );
    expect(imageRefs).toEqual([
      { ref: 'docx-img:0', alt: 'Diagram' },
      { ref: 'docx-img:1', alt: 'Cell chart' },
    ]);
    expect(blocks).toEqual([
      { kind: 'image', imageId: 'docx-img:0', origin: 'embedded', alt: 'Diagram' },
      { kind: 'table', rows: [['x; a; b', '']] },
      { kind: 'image', imageId: 'docx-img:1', origin: 'embedded', alt: 'Cell chart' },
    ]);
  });

  it('ignores placeholder attributes in untrusted HTML', async () => {
    const html = '<p>Hi <img data-eli5-img="x-1" alt="logo"></p>';
    expect(htmlToBlocks(html)).toEqual({
      blocks: [{ kind: 'paragraph', text: 'Hi [image: logo]' }],
      imageRefs: [],
    });
    const src = fixtureSource('sources/text/article.html', { payload: { kind: 'html', html } });
    const r = await extractSource(src, testContext());
    expect(r.ok && r.content.blocks).toEqual([{ kind: 'paragraph', text: 'Hi [image: logo]' }]);
  });

  it('extracts a local HTML file with its title', async () => {
    const r = await extractSource(fixtureSource('sources/text/article.html'), testContext());
    if (!r.ok) throw new Error(r.skipped.code);
    expect(r.content.title).toBe('Example Widgets Inc. field guide');
    expect(JSON.stringify(r.content.blocks)).not.toMatch(/trackingPixel|Search|Guides/);
  });

  it('uses an html payload as-is', async () => {
    const src = fixtureSource('sources/text/article.html', {
      payload: { kind: 'html', html: '<h1>Readable</h1><p>Body</p>', baseUrl: 'https://example.com/' },
      title: 'From fetch',
    });
    const r = await extractSource(src, testContext());
    expect(r.ok && r.content.blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Readable' },
      { kind: 'paragraph', text: 'Body' },
    ]);
    expect(r.ok && r.content.title).toBe('From fetch');
  });
});
