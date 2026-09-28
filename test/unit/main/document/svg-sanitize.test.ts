import { describe, expect, it } from 'vitest';
import { colorToken, sanitizeSvg } from '../../../../src/main/document';

const opts = { idPrefix: 'd12345678-', ariaLabel: 'A diagram', rootClass: 'diagram-svg' };
const wrap = (inner: string, rootAttrs = 'viewBox="0 0 100 50"'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${rootAttrs}>${inner}</svg>`;

describe('sanitizeSvg (07 §7.3)', () => {
  it('keeps safe presentation from style attributes as attributes (real-provider diagram regression)', () => {
    // A real document's labels lost centering and size: the model wrote text-anchor and font-size
    // in style="...", and dropping the whole style attribute left every label left-aligned at 16.
    const out = sanitizeSvg(
      wrap(
        '<text x="60" y="105" style="text-anchor: middle; font-size: 12px; font-weight: 600; ' +
          'dominant-baseline: middle; fill: #1b1b1b">Protected</text>' +
          '<rect x="1" y="1" width="5" height="5" style="fill:#788c5d;stroke:#3d3d3a;stroke-width:2;opacity:0.9"/>',
      ),
      opts,
    );
    expect(out).toContain('text-anchor="middle"');
    expect(out).toContain('font-size="12"');
    expect(out).toContain('font-weight="600"');
    expect(out).toContain('dominant-baseline="middle"');
    expect(out).toContain('stroke-width="2"');
    expect(out).toContain('opacity="0.9"');
    expect(out).not.toContain('style=');
    // Colors from style map onto the palette like fill/stroke attributes do.
    expect(out).toMatch(/<rect[^>]*class="[^"]*viz-fill-/);
    expect(out).toMatch(/<rect[^>]*class="[^"]*viz-stroke-/);
  });

  it('ignores unsafe or unknown style declarations and never lets style override an attribute', () => {
    const out = sanitizeSvg(
      wrap(
        '<text x="1" y="9" text-anchor="end" style="text-anchor:middle; font-size: expression(alert(1)); ' +
          'background:url(https://x.test/a.png); position:fixed; font-size: 9e999px">a</text>',
      ),
      opts,
    );
    expect(out).toContain('text-anchor="end"');
    expect(out).not.toMatch(/expression|url\(|position|background|9e999/);
    expect(out).not.toContain('font-size=');
  });

  it('is idempotent, so parseDocument can re-run it on stored SVG', () => {
    const once = sanitizeSvg(
      wrap(
        '<defs><marker id="arrow"><path d="M0 0L1 1" fill="#000"/></marker><linearGradient id="g">' +
          '<stop offset="0" stop-color="#1f6fb2"/></linearGradient></defs>' +
          '<rect x="1" y="1" width="5" height="5" fill="url(#g)" class="evil viz-fill-2"/>' +
          '<line x1="0" y1="0" x2="9" y2="9" stroke="#1b1b1b" marker-end="url(#arrow)"/><text x="1" y="9">a &amp; b</text>',
      ),
      opts,
    );
    expect(once).not.toBeNull();
    expect(once).not.toContain('evil');
    expect(sanitizeSvg(once ?? '', opts)).toBe(once);
  });

  it('removes script, style, foreignObject, image, a, animate and set', () => {
    const out = sanitizeSvg(
      wrap(
        '<script>alert(1)</script><style>rect{fill:red}</style><foreignObject><div>x</div></foreignObject>' +
          '<image href="https://example.com/x.png"/><a href="https://example.com"><rect x="1" y="1" width="2" height="2"/></a>' +
          '<animate attributeName="x"/><set attributeName="x" to="1"/><rect x="5" y="5" width="10" height="10"/>',
      ),
      opts,
    );
    expect(out).not.toBeNull();
    for (const bad of [
      '<script',
      '<style',
      'foreignObject',
      '<image',
      '<a ',
      '<animate',
      '<set',
      'alert',
      'example.com',
    ]) {
      expect(out).not.toContain(bad);
    }
    expect(out).toContain('<rect x="5" y="5" width="10" height="10"></rect>');
  });

  it('strips on* handlers, style attributes, model classes and external url()/href', () => {
    const out =
      sanitizeSvg(
        wrap(
          '<rect x="0" y="0" width="5" height="5" onclick="x()" onload="y()" style="fill:red" class="gl-note tab-close" fill="url(http://evil.example/a)"/>' +
            '<use href="https://evil.example/s.svg#a"/><use xlink:href="javascript:alert(1)"/>',
        ),
        opts,
      ) ?? '';
    expect(out).not.toMatch(/on(click|load)|style=|gl-note|tab-close|evil|javascript/);
    expect(out).not.toContain('<use href');
  });

  it('maps colors to theme classes, never var() or colors in attributes', () => {
    const out =
      sanitizeSvg(
        wrap(
          '<rect x="0" y="0" width="1" height="1" fill="#1f6fb2"/><rect x="0" y="0" width="1" height="1" fill="var(--viz-3)"/>' +
            '<line x1="0" y1="0" x2="1" y2="1" stroke="currentColor"/><rect x="0" y="0" width="1" height="1" fill="none" stroke="rgb(212, 101, 47)"/>' +
            '<defs><linearGradient id="g"><stop offset="0" stop-color="white"/></linearGradient></defs><rect x="0" y="0" width="1" height="1" fill="url(#g)"/>',
        ),
        opts,
      ) ?? '';
    expect(out).toContain('class="viz-fill-1"');
    expect(out).toContain('class="viz-fill-3"');
    expect(out).toContain('class="viz-stroke-ink"');
    expect(out).toContain('fill="none" class="viz-stroke-2"');
    expect(out).toContain('class="viz-stop-paper"');
    expect(out).toContain('fill="url(#d12345678-g)"');
    expect(out).not.toMatch(/="[^"]*var\(/);
    expect(out).not.toMatch(/(fill|stroke|stop-color)="(#|rgb|white|currentColor)/i);
  });

  it('prefixes ids and rewrites references; drops dangling ones', () => {
    const out =
      sanitizeSvg(
        wrap(
          '<defs><marker id="arrow"><path d="M0 0L1 1"/></marker></defs><line x1="0" y1="0" x2="1" y2="1" marker-end="url(#arrow)" marker-start="url(#nope)"/><use href="#arrow"/>',
        ),
        opts,
      ) ?? '';
    expect(out).toContain('id="d12345678-arrow"');
    expect(out).toContain('marker-end="url(#d12345678-arrow)"');
    expect(out).toContain('<use href="#d12345678-arrow">');
    expect(out).not.toContain('nope');
  });

  it('sets role, aria-label and a viewBox (from width/height), else drops', () => {
    const out =
      sanitizeSvg(
        wrap(
          '<rect x="0" y="0" width="1" height="1"/>',
          'width="400px" height="120" role="presentation" aria-label="x"',
        ),
        opts,
      ) ?? '';
    expect(out).toMatch(
      /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 400 120" role="img" aria-label="A diagram" class="diagram-svg viz-fill-ink">/,
    );
    expect(sanitizeSvg(wrap('<rect x="0" y="0" width="1" height="1"/>', ''), opts)).toBeNull();
  });

  it('returns null for non-SVG, empty or shape-less input', () => {
    expect(sanitizeSvg('<div>hi</div>', opts)).toBeNull();
    expect(sanitizeSvg('', opts)).toBeNull();
    expect(sanitizeSvg(wrap('<script>x</script>'), opts)).toBeNull();
  });

  it('escapes text content', () => {
    const out = sanitizeSvg(wrap('<text x="1" y="1">a &lt; b &amp; c</text>'), opts) ?? '';
    expect(out).toContain('<text x="1" y="1">a &lt; b &amp; c</text>');
  });
});

describe('colorToken', () => {
  it('maps grays by lightness and hues to the nearest viz token', () => {
    expect(colorToken('#000')).toBe('ink');
    expect(colorToken('#fff')).toBe('paper');
    expect(colorToken('#888888')).toBe('muted');
    expect(colorToken('#cccccc')).toBe('rule');
    expect(colorToken('hsl(146, 50%, 40%)')).toBe('3');
    expect(colorToken('red')).toBe('8');
    expect(colorToken('transparent')).toBe('none');
    expect(colorToken('var(--viz-7)')).toBe('7');
    expect(colorToken('not-a-color')).toBeUndefined();
  });
});
