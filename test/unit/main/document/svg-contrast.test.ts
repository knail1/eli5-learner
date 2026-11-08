import { describe, expect, it } from 'vitest';
import { sanitizeSvg } from '../../../../src/main/document/svg-sanitize';

/** Diagram label contrast (07 §7.3): labels never blend into the shape behind them. */

const opts = { idPrefix: 'd0a1b2c3d-', ariaLabel: 'Diagram', rootClass: 'diagram-svg', labelContrast: true };
const clean = (body: string, o: Partial<typeof opts> = {}) =>
  sanitizeSvg(`<svg viewBox="0 0 200 100">${body}</svg>`, { ...opts, ...o }) ?? '';
/** The serialized <text> elements, in order. */
const texts = (svg: string) => svg.match(/<text[^>]*>/g) ?? [];
/** A serialized start tag's attributes, order-independent. */
const attrsOf = (tag: string | undefined) =>
  Object.fromEntries([...(tag ?? '').matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

describe('decision table (07 §7.3)', () => {
  it('backdrop paper (or none): paper-coloured text becomes ink; anything else is left', () => {
    const svg = clean(
      '<rect x="0" y="0" width="200" height="100" fill="#ffffff"/>' +
        '<text x="10" y="20" fill="white">A</text><text x="10" y="40" fill="#1f6fb2">B</text>',
    );
    expect(texts(svg)).toEqual([
      '<text x="10" y="20" class="viz-fill-ink">',
      '<text x="10" y="40" class="viz-fill-1">',
    ]);
    // No shape at all: the page is the backdrop.
    expect(
      texts(clean('<line x1="0" y1="0" x2="5" y2="5" stroke="black"/><text x="10" y="20" fill="white">A</text>')),
    ).toEqual(['<text x="10" y="20" class="viz-fill-ink">']);
  });

  it('backdrop ink: any text that is not paper becomes paper', () => {
    const svg = clean(
      '<rect x="0" y="0" width="200" height="100" fill="#111"/>' +
        '<text x="10" y="20">A</text><text x="10" y="40" fill="#e07020">B</text><text x="10" y="60" fill="white">C</text>',
    );
    expect(texts(svg)).toEqual([
      '<text x="10" y="20" class="viz-fill-paper">',
      '<text x="10" y="40" class="viz-fill-paper">',
      '<text x="10" y="60" class="viz-fill-paper">',
    ]);
  });

  it('backdrop an accent fill: non-paper text becomes ink with a 3 px round paper outline; paper text is left', () => {
    const svg = clean(
      '<rect x="0" y="0" width="200" height="100" fill="#e07020"/>' +
        '<text x="10" y="20" fill="#e07020">Same</text><text x="10" y="40" fill="white">Paper</text>',
    );
    const [same, paper] = texts(svg);
    expect(attrsOf(same)).toEqual({
      x: '10',
      y: '20',
      'stroke-width': '3',
      'stroke-linejoin': 'round',
      'paint-order': 'stroke',
      class: 'viz-fill-ink viz-stroke-paper',
    });
    expect(paper).toBe('<text x="10" y="40" class="viz-fill-paper">');
  });
});

describe('backdrop and mechanics', () => {
  it('nested shapes: the topmost containing shape painted before the text wins', () => {
    const svg = clean(
      '<rect x="0" y="0" width="200" height="100" fill="#111"/>' +
        '<g><rect x="0" y="0" width="100" height="50" fill="white"/></g>' +
        '<text x="10" y="20" fill="white">On white</text><text x="150" y="80" fill="#111">On ink</text>',
    );
    expect(texts(svg)).toEqual([
      '<text x="10" y="20" class="viz-fill-ink">',
      '<text x="150" y="80" class="viz-fill-paper">',
    ]);
  });

  it('a shape painted after the text is not its backdrop', () => {
    const svg = clean(
      '<text x="10" y="20" fill="#111">A</text><rect x="0" y="0" width="200" height="100" fill="#111"/>',
    );
    expect(texts(svg)).toEqual(['<text x="10" y="20" class="viz-fill-ink">']);
  });

  it('translate offsets on groups move both shapes and text', () => {
    const svg = clean(
      '<g transform="translate(100,50)"><rect x="0" y="0" width="50" height="30" fill="#111"/></g>' +
        '<g transform="translate(100 50)"><text x="10" y="10">Inside</text></g>' +
        '<text x="10" y="10">Outside</text>',
    );
    expect(texts(svg)).toEqual(['<text x="10" y="10" class="viz-fill-paper">', '<text x="10" y="10">']);
  });

  it('a faint fill (fill or element opacity under 0.5) counts as no shape', () => {
    const svg = clean(
      '<rect x="0" y="0" width="200" height="100" fill="#111" fill-opacity="0.2"/>' +
        '<g opacity="0.3"><rect x="0" y="0" width="200" height="100" fill="#111"/></g>' +
        '<text x="10" y="20" fill="#e07020">A</text>',
    );
    expect(texts(svg)).toEqual(['<text x="10" y="20" class="viz-fill-2">']);
  });

  it('a rotate transform on the text or its backdrop leaves the text unjudged', () => {
    const rotatedText = clean(
      '<rect x="0" y="0" width="200" height="100" fill="#111"/><text x="10" y="20" transform="rotate(30)">A</text>',
    );
    expect(texts(rotatedText)[0]).not.toContain('viz-fill-paper');
    const rotatedShape = clean(
      '<rect x="0" y="0" width="200" height="100" fill="#111" transform="rotate(5)"/><text x="10" y="20">A</text>',
    );
    expect(texts(rotatedShape)[0]).not.toContain('viz-fill-paper');
  });

  it('recoloured text and its spans lose their fill and stroke tokens first', () => {
    const svg = clean(
      '<rect x="0" y="0" width="200" height="100" fill="#111"/>' +
        '<text x="10" y="20" fill="#e07020" stroke="#111"><tspan fill="#1f6fb2">A</tspan>B</text>',
    );
    expect(svg).toContain('<text x="10" y="20" class="viz-fill-paper"><tspan>A</tspan>B</text>');
  });

  it('text without explicit x and y is not judged; the logo (no labelContrast) is never changed', () => {
    expect(texts(clean('<rect x="0" y="0" width="200" height="100" fill="#111"/><text>A</text>'))).toEqual(['<text>']);
    const logo = clean('<rect x="0" y="0" width="200" height="100" fill="#111"/><text x="10" y="20">A</text>', {
      labelContrast: false,
    });
    expect(texts(logo)).toEqual(['<text x="10" y="20">']);
  });

  it('is idempotent: sanitizing the output again changes nothing', () => {
    const once = clean(
      '<rect x="0" y="0" width="200" height="100" fill="#e07020"/><text x="10" y="20" fill="#e07020">Same</text>' +
        '<rect x="0" y="60" width="200" height="40" fill="#111"/><text x="10" y="80">Dark</text>',
    );
    expect(sanitizeSvg(once, opts)).toBe(once);
  });
});

describe('gradient backdrops (07 §7.3)', () => {
  it('a gradient-filled shape is flattened first, so its labels are judged against the flat colour', () => {
    const svg = clean(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#111"/><stop offset="1" stop-color="#444"/></linearGradient></defs>' +
        '<rect x="0" y="0" width="200" height="100" fill="url(#g)"/><text x="10" y="20">A</text>',
    );
    expect(svg).toContain('<rect x="0" y="0" width="200" height="100" class="viz-fill-ink">');
    expect(texts(svg)).toEqual(['<text x="10" y="20" class="viz-fill-paper">']);
    expect(clean(svg.replace(/^<svg[^>]*>|<\/svg>$/g, ''))).toBe(svg);
  });
});
