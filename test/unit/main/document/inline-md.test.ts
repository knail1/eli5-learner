import { describe, expect, it } from 'vitest';
import { inlineText, renderInline, renderInlineMany, safeHref } from '../../../../src/main/document/inline-md';

describe('inline markdown subset (07 §5.2)', () => {
  it('renders bold, italic, code and links', () => {
    expect(renderInline('**b** and *i* and `c`')).toBe('<strong>b</strong> and <em>i</em> and <code>c</code>');
    expect(renderInline('[docs](https://example.com/a?b=1&c=2)')).toBe(
      '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a>',
    );
  });

  it('escapes everything else, including HTML', () => {
    expect(renderInline('<script>alert("x")</script> & <b>')).toBe(
      '&lt;script&gt;alert("x")&lt;/script&gt; &amp; &lt;b&gt;',
    );
    expect(renderInline('# not a heading, - not a list')).toBe('# not a heading, - not a list');
  });

  it('allows only http, https and mailto links; other schemes render text only', () => {
    expect(renderInline('[x](javascript:alert(1))')).not.toContain('<a');
    expect(renderInline('[x](data:text/html,hi)')).toBe('x');
    expect(renderInline('[x](/relative)')).toBe('x');
    expect(renderInline('[mail](mailto:a@example.com)')).toContain('href="mailto:a@example.com"');
    expect(safeHref('file:///etc/passwd')).toBeUndefined();
  });

  it('keeps unclosed markers literal', () => {
    expect(renderInline('2 * 3 = 6 and **open')).toBe('2 * 3 = 6 and **open');
    expect(renderInline('a `tick')).toBe('a `tick');
  });

  it('wraps a glossary anchor in <dfn>, never inside code or links', () => {
    const html = renderInline('`ROAS` in [ROAS](https://example.com) then ROAS', [
      { text: 'ROAS', noteId: 'g-abcdef' },
    ]);
    expect(html).toBe(
      '<code>ROAS</code> in <a href="https://example.com/" target="_blank" rel="noopener noreferrer">ROAS</a> then <dfn class="gl-term" id="g-abcdef-ref" aria-describedby="g-abcdef">ROAS</dfn>',
    );
  });

  it('places several anchors across list items and reports missing ones', () => {
    const r = renderInlineMany(
      ['alpha beta', 'gamma **delta**'],
      [
        { text: 'delta', noteId: 'g-000001' },
        { text: 'alpha', noteId: 'g-000002' },
        { text: 'zeta', noteId: 'g-000003' },
      ],
    );
    expect(r.html[0]).toContain('id="g-000002-ref"');
    expect(r.html[1]).toContain('<strong><dfn class="gl-term" id="g-000001-ref"');
    expect(r.missing.map((m) => m.noteId)).toEqual(['g-000003']);
  });

  it('extracts plain text', () => {
    expect(inlineText('**Would** you *like* `x`?')).toBe('Would you like x?');
  });
});
