import { describe, expect, it } from 'vitest';
import { colorToken, sanitizeSvg } from '../../../../src/main/document';
import { RUNTIME_LIGHT, parseColor, rgbToHsl, type ColorToken, type Rgb } from '../../../../src/main/document/color';
import { VIZ_HUES } from '../../../../src/main/document/svg-sanitize';

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
    // No gradients: the gradient is gone; its shape keeps the first stop's colour as a flat class.
    expect(out).toContain('<rect x="0" y="0" width="1" height="1" class="viz-fill-paper">');
    expect(out).not.toMatch(/Gradient|<stop|url\(/);
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
      /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 400 120" role="img" aria-label="A diagram" class="diagram-svg viz-fill-ink viz-pal-2">/,
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

describe('no gradients, patterns or shading (07 §7.3)', () => {
  const rect = (fill: string, extra = ''): string =>
    `<rect x="0" y="0" width="9" height="9" ${fill}${extra ? ` ${extra}` : ''}/>`;

  it('drops linearGradient, radialGradient, stop and pattern', () => {
    const out =
      sanitizeSvg(
        wrap(
          '<defs><linearGradient id="a" gradientUnits="userSpaceOnUse" gradientTransform="rotate(9)">' +
            '<stop offset="0" stop-color="#d55e00"/><stop offset="1" stop-color="#fff"/></linearGradient>' +
            '<radialGradient id="b" fx="0.2" fy="0.2"><stop offset="0" stop-color="#0072b2"/></radialGradient>' +
            '<pattern id="p" width="4" height="4"><path d="M0 0L4 4" stroke="#000"/></pattern></defs>' +
            rect('fill="url(#a)"') +
            rect('fill="url(#b)"') +
            rect('fill="url(#p)"'),
        ),
        opts,
      ) ?? '';
    expect(out).not.toMatch(/linearGradient|radialGradient|<stop|<pattern|gradientUnits|gradientTransform|fx=|offset=/);
    expect(out).not.toContain('url(');
    expect(out).toContain('class="viz-fill-2"');
    expect(out).toContain('class="viz-fill-1"');
    // A pattern has no stop colour: the shape becomes a flat muted fill.
    expect(out).toContain('class="viz-fill-muted"');
  });

  it('flattens url() fills and strokes to the first stop, following href and style', () => {
    const out =
      sanitizeSvg(
        wrap(
          '<defs><linearGradient id="base"><stop offset="0" style="stop-color:#2e7514"/></linearGradient>' +
            '<linearGradient id="ref" href="#base"/><linearGradient id="empty"/></defs>' +
            rect('fill="url(#ref)"') +
            rect('style="fill:url(#base)"') +
            '<line x1="0" y1="0" x2="9" y2="9" stroke="url(#base)"/>' +
            '<line x1="0" y1="9" x2="9" y2="0" stroke="url(#empty)"/>',
        ),
        opts,
      ) ?? '';
    expect(out.match(/class="viz-fill-6"/g)).toHaveLength(2);
    expect(out).toContain('<line x1="0" y1="0" x2="9" y2="9" class="viz-stroke-6">');
    // No readable colour on a stroke: no stroke rather than a guessed one.
    expect(out).toContain('<line x1="0" y1="9" x2="9" y2="0" stroke="none">');
    expect(out).not.toContain('url(');
  });

  it('flattens stored diagrams whose stops carry theme classes, and stays idempotent', () => {
    const stored = wrap(
      '<defs><linearGradient id="d12345678-g"><stop offset="0" class="viz-stop-3"/></linearGradient></defs>' +
        rect('fill="url(#d12345678-g)"'),
    );
    const once = sanitizeSvg(stored, opts) ?? '';
    expect(once).toContain('class="viz-fill-3"');
    expect(once).not.toMatch(/viz-stop|Gradient|url\(/);
    expect(sanitizeSvg(once, opts)).toBe(once);
  });
});

describe('old-palette diagrams (07 §7.3, §11.1)', () => {
  const old = wrap(
    '<rect width="5" height="5" class="viz-fill-3 viz-stroke-8"/>' +
      '<defs><linearGradient id="d12345678-g"><stop offset="0" class="viz-stop-4"/></linearGradient></defs>' +
      '<rect width="9" height="9" fill="url(#d12345678-g)"/><text x="1" y="1" class="viz-fill-ink">A</text>',
  );

  it('renumbers old theme classes so each keeps its hue, once', () => {
    const once = sanitizeSvg(old, { ...opts, legacyPalette: true }) ?? '';
    // Green 3 -> 6, red 8 -> vermillion 2, magenta stop 4 -> purple 3; ink is not a slot.
    expect(once).toContain('class="viz-fill-6 viz-stroke-2"');
    expect(once).toContain('<rect width="9" height="9" class="viz-fill-3">');
    expect(once).toContain('class="viz-fill-ink"');
    expect(once).toMatch(/<svg [^>]*class="diagram-svg[^"]* viz-pal-2"/);
    // The palette mark stops a second renumbering.
    expect(sanitizeSvg(once, { ...opts, legacyPalette: true })).toBe(once);
    expect(sanitizeSvg(once, opts)).toBe(once);
  });

  it('keeps old orange and red apart when one SVG uses both (audit round 1)', () => {
    const both = wrap('<rect width="5" height="5" class="viz-fill-2"/><rect width="6" height="6" class="viz-fill-8"/>');
    const out = sanitizeSvg(both, { ...opts, legacyPalette: true }) ?? '';
    // Orange -> vermillion 2, red -> purple 3 (old magenta unused).
    expect(out).toContain('<rect width="5" height="5" class="viz-fill-2"></rect>');
    expect(out).toContain('<rect width="6" height="6" class="viz-fill-3"></rect>');
    const withMagenta = wrap(
      '<rect width="5" height="5" class="viz-fill-2"/><rect width="6" height="6" class="viz-stroke-8"/>' +
        '<rect width="7" height="7" class="viz-fill-4"/>',
    );
    const out2 = sanitizeSvg(withMagenta, { ...opts, legacyPalette: true }) ?? '';
    // Magenta takes purple 3, so red takes the neutral slot 4 nothing else maps to.
    expect(out2).toContain('class="viz-fill-2"');
    expect(out2).toContain('class="viz-stroke-4"');
    expect(out2).toContain('class="viz-fill-3"');
    // Every distinct old slot stays a distinct new slot.
    const all = wrap(
      Array.from({ length: 8 }, (_, i) => `<rect width="${i + 1}" height="1" class="viz-fill-${i + 1}"/>`).join(''),
    );
    const slots = [...(sanitizeSvg(all, { ...opts, legacyPalette: true }) ?? '').matchAll(/viz-fill-(\d)/g)].map(
      (m) => m[1],
    );
    expect(new Set(slots).size).toBe(8);
  });

  it('leaves class numbers alone without the legacy flag', () => {
    const out = sanitizeSvg(old, opts) ?? '';
    expect(out).toContain('class="viz-fill-3 viz-stroke-8"');
    expect(out).toContain('viz-pal-2');
  });
});

describe('colorToken', () => {
  it('each hue target is the hue of its light-theme slot (07 §11.1), so the two cannot drift', () => {
    for (const [slot, hue] of VIZ_HUES) {
      const { h } = rgbToHsl(parseColor(RUNTIME_LIGHT[`--viz-${slot}` as ColorToken]) as Rgb);
      expect(Math.abs(h - hue), `slot ${slot}`).toBeLessThanOrEqual(1);
    }
    // Every chromatic slot is a target; only graphite (4) is not.
    expect(VIZ_HUES.map(([s]) => s).sort()).toEqual(['1', '2', '3', '5', '6', '7', '8']);
  });

  it('maps grays by lightness and hues to the nearest viz token', () => {
    expect(colorToken('#000')).toBe('ink');
    expect(colorToken('#fff')).toBe('paper');
    expect(colorToken('#888888')).toBe('muted');
    expect(colorToken('#cccccc')).toBe('rule');
    // Hue targets follow the 07 §11.1 palette: blue 1, vermillion 2, purple 3, teal 5, green 6,
    // violet 7, ochre 8.
    expect(colorToken('hsl(110, 50%, 40%)')).toBe('6');
    expect(colorToken('teal')).toBe('5');
    expect(colorToken('#20b2aa')).toBe('5');
    expect(colorToken('#6a3fd8')).toBe('7');
    expect(colorToken('red')).toBe('2');
    expect(colorToken('#0072b2')).toBe('1');
    expect(colorToken('purple')).toBe('3');
    expect(colorToken('gold')).toBe('8');
    expect(colorToken('skyblue')).toBe('1');
    expect(colorToken('transparent')).toBe('none');
    expect(colorToken('var(--viz-7)')).toBe('7');
    expect(colorToken('not-a-color')).toBeUndefined();
  });
});
