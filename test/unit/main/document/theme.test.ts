import { describe, expect, it } from 'vitest';
import {
  defaultDocTheme,
  isValidTokenValue,
  resolveDocTheme,
  sanitizeTokens,
  themeCss,
} from '../../../../src/main/document';
import { parseThemeCss, parseThemeDarkCss, upgradeThemeBlock } from '../../../../src/main/document/theme';

describe('theme tokens (07 §11.3)', () => {
  it('accepts only known token names with valid values', () => {
    const warnings: string[] = [];
    const out = sanitizeTokens(
      {
        '--accent': '#8a1c7c',
        '--paper': 'rgb(250, 250, 250)',
        '--font-sans': '"Avenir Next", Arial, sans-serif',
        '--viz-1': 'oklch(0.6 0.1 250)',
        '--unknown': '#fff',
        '--ink': 'red;} body{display:none',
        '--rule': 'url(https://example.com/x.png)',
        '--link': 'expression(alert(1))',
      },
      (w) => warnings.push(w),
    );
    expect(out).toEqual({
      '--accent': '#8a1c7c',
      '--paper': 'rgb(250, 250, 250)',
      '--font-sans': '"Avenir Next", Arial, sans-serif',
      '--viz-1': 'oklch(0.6 0.1 250)',
    });
    expect(warnings).toEqual([
      'theme-token-unknown:--unknown',
      'theme-token-invalid:--ink',
      'theme-token-invalid:--rule',
      'theme-token-invalid:--link',
    ]);
    expect(isValidTokenValue('12px')).toBe(true);
    expect(isValidTokenValue('</style>')).toBe(false);
  });

  it('applies precedence default < skill < overlay and records the source', () => {
    const r = resolveDocTheme({
      skill: { '--accent': '#111111', '--link': '#222222' },
      overlay: { id: 'org', version: '3', tokens: { '--accent': '#333333' }, footer: 'Internal use' },
    });
    expect(r.source).toBe('overlay');
    expect(r.theme).toMatchObject({
      id: 'org',
      version: '3',
      footer: 'Internal use',
      tokens: { '--accent': '#333333', '--link': '#222222' },
    });
    expect(resolveDocTheme({ skill: { '--accent': '#111111' } }).source).toBe('skill');
    expect(resolveDocTheme({}).theme).toEqual({ ...defaultDocTheme, tokens: {} });
  });

  it('sanitizes the overlay logo SVG per 07 §7.3', () => {
    const r = resolveDocTheme({
      overlay: {
        id: 'o',
        version: '1',
        tokens: {},
        logoSvg:
          '<svg viewBox="0 0 10 10" onload="x()"><script>alert(1)</script><circle cx="5" cy="5" r="4" fill="#1f6fb2"/></svg>',
      },
    });
    expect(r.theme.logoSvg).toContain('<circle cx="5" cy="5" r="4" class="viz-fill-1"></circle>');
    expect(r.theme.logoSvg).not.toMatch(/onload|script/);
    expect(
      resolveDocTheme({ overlay: { id: 'o', version: '1', tokens: {}, logoSvg: '<b>no</b>' } }).warnings,
    ).toContain('theme-logo-dropped');
  });

  it('writes and parses the override block, with a derived dark variant under the runtime guards', () => {
    const css = themeCss({ id: 'x', version: '1', tokens: { '--accent': '#123456', '--font-serif': 'Georgia' } });
    const light = ':root:root:root{--accent:#123456;--font-serif:Georgia}';
    expect(css.startsWith(light)).toBe(true);
    // 07 §11.4: auto follows the system, the toggle wins; fonts are not repeated in dark.
    expect(css).toMatch(
      /^[^@]*@media \(prefers-color-scheme: dark\)\{:root:root:root:not\(\[data-theme="light"\]\)\{--accent:#[0-9a-f]{6}\}\}:root:root:root\[data-theme="dark"\]\{--accent:#[0-9a-f]{6}\}$/,
    );
    expect(parseThemeCss(css)).toEqual({ '--accent': '#123456', '--font-serif': 'Georgia' });
    expect(parseThemeDarkCss(css)).toBeUndefined(); // derived, so nothing explicit to keep
    expect(themeCss(defaultDocTheme)).toBe('');
    expect(themeCss({ id: 'f', version: '1', tokens: { '--font-sans': 'Arial' } })).toBe(
      ':root:root:root{--font-sans:Arial}',
    );
  });

  it('keeps explicit dark tokens through a render and parse round trip', () => {
    const theme = { id: 'x', version: '1', tokens: { '--accent': '#8a1c7c' }, darkTokens: { '--accent': '#ff99ee' } };
    const css = themeCss(theme);
    expect(css).toContain(':root:root:root[data-theme="dark"]{--accent:#ff99ee}');
    expect(parseThemeDarkCss(css)).toEqual({ '--accent': '#ff99ee' });
    expect(themeCss({ ...theme, darkTokens: parseThemeDarkCss(css) })).toBe(css);
  });

  it("drops a lower layer's dark value when a higher layer changes that token's light value", () => {
    const r = resolveDocTheme({
      skill: { '--accent': '#111111', '--link': '#222222' },
      skillDark: { '--accent': '#eeeeee', '--link': '#dddddd' },
      overlay: { id: 'org', version: '1', tokens: { '--accent': '#333333' } },
    });
    expect(r.theme.darkTokens).toEqual({ '--link': '#dddddd' });
    expect(resolveDocTheme({ skill: { '--accent': '#111111' } }).theme.darkTokens).toBeUndefined();
  });

  it('upgrades a light-only theme block and leaves current or empty ones alone', () => {
    const light = ':root:root:root{--accent:#8a1c7c}';
    const old = `<style id="eli5-theme">${light}</style><p>x</p>`;
    const up = upgradeThemeBlock(old);
    expect(up).toBe(
      `<style id="eli5-theme">${themeCss({ id: 'x', version: '1', tokens: { '--accent': '#8a1c7c' } })}</style><p>x</p>`,
    );
    expect(upgradeThemeBlock(up)).toBe(up);
    expect(upgradeThemeBlock('<style id="eli5-theme"></style>')).toBe('<style id="eli5-theme"></style>');
    expect(upgradeThemeBlock('<p>no theme</p>')).toBe('<p>no theme</p>');
  });
});
