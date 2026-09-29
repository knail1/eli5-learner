// Document themes (07 §11.3; HOOK-DOC-01 public behavior): neutral default, token validation,
// precedence default < skill < overlay, and the `#eli5-theme` override block.
import { deriveDarkTokens } from './color';
import { sanitizeSvg } from './svg-sanitize';
import { TOKEN_NAMES, type DocTheme, type DocThemeRef, type TokenName } from './types';

/** Footer text of every public document (hooks.md HOOK-DOC-01). */
export const DEFAULT_FOOTER = 'Made with ELI5 Learner';

/**
 * Public HOOK-DOC-01 binding: no token overrides (DOC_RUNTIME_CSS defaults apply in both
 * themes), no logo, no classification label.
 */
export const defaultDocTheme: DocTheme = Object.freeze({
  id: 'default',
  version: '1',
  tokens: Object.freeze({}),
  footer: DEFAULT_FOOTER,
});

/** The DocumentModel.theme record for a theme (07 §3, §11.3). */
export function docThemeRef(theme: DocTheme, source: DocThemeRef['source']): DocThemeRef {
  return { id: theme.id, version: theme.version, source };
}

/** 07 §11.3 token value pattern (the spec's `…` read as "no parentheses or angle brackets inside"). */
const TOKEN_VALUE_RE =
  /^(#[0-9a-f]{3,8}|rgb\([^()<>;{}]*\)|hsl\([^()<>;{}]*\)|oklch\([^()<>;{}]*\)|[a-z-]+|[0-9.]+(px|rem|em)?|"[^"<>]*"( ?, ?[a-zA-Z "-]+)*)$/i;
const TOKEN_SET = new Set<string>(TOKEN_NAMES);

export function isTokenName(name: string): name is TokenName {
  return TOKEN_SET.has(name);
}

export function isValidTokenValue(value: string): boolean {
  return TOKEN_VALUE_RE.test(value.trim()) && !/[;{}<>\\]/.test(value);
}

/** Keeps only known token names with valid values; everything else is dropped with a warning. */
export function sanitizeTokens(
  tokens: Readonly<Record<string, string>>,
  warn: (w: string) => void,
): Partial<Record<TokenName, string>> {
  const out: Partial<Record<TokenName, string>> = {};
  for (const [name, raw] of Object.entries(tokens)) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!isTokenName(name)) warn(`theme-token-unknown:${name.slice(0, 40)}`);
    else if (!isValidTokenValue(value)) warn(`theme-token-invalid:${name}`);
    else out[name] = value;
  }
  return out;
}

export interface ThemeLayers {
  base?: DocTheme;
  /** CSS custom properties from the beautiful-doc skill (02 §11). */
  skill?: Readonly<Record<string, string>>;
  /** The skill's explicit dark values (its `@media (prefers-color-scheme: dark)` block), if any. */
  skillDark?: Readonly<Record<string, string>>;
  /** HOOK-DOC-01 overlay theme (registry docTheme when not the default). */
  overlay?: DocTheme;
}

/**
 * Resolves the theme for a new document (07 §11.3): default < skill tokens < overlay. Tokens are
 * validated and the logo SVG is sanitized per 07 §7.3, so the renderer can emit both verbatim.
 */
export function resolveDocTheme(layers: ThemeLayers): {
  theme: DocTheme;
  source: DocThemeRef['source'];
  warnings: string[];
} {
  const warnings: string[] = [];
  const warn = (w: string): void => {
    warnings.push(w);
  };
  const base = layers.base ?? defaultDocTheme;
  let tokens = sanitizeTokens(base.tokens as Record<string, string>, warn);
  let dark = sanitizeTokens((base.darkTokens ?? {}) as Record<string, string>, warn);
  let source: DocThemeRef['source'] = 'default';
  let id = base.id;
  let version = base.version;
  let footer = base.footer;
  let logoSvg = base.logoSvg;
  // A layer that sets a token's light value without a dark one drops the dark value of the layers
  // below: it was chosen for their light value (07 §11.4), and derivation fits the new one.
  const layer = (
    light: Readonly<Record<string, string>>,
    darkIn: Readonly<Record<string, string>> | undefined,
  ): void => {
    const l = sanitizeTokens(light, warn);
    const d = sanitizeTokens(darkIn ?? {}, warn);
    for (const name of Object.keys(l) as TokenName[]) if (!(name in d)) delete dark[name];
    tokens = { ...tokens, ...l };
    dark = { ...dark, ...d };
  };
  if (layers.skill && Object.keys(layers.skill).length > 0) {
    layer(layers.skill, layers.skillDark);
    source = 'skill';
  }
  if (layers.overlay) {
    layer(layers.overlay.tokens as Record<string, string>, layers.overlay.darkTokens as Record<string, string>);
    source = 'overlay';
    id = layers.overlay.id;
    version = layers.overlay.version;
    footer = layers.overlay.footer ?? footer;
    logoSvg = layers.overlay.logoSvg ?? logoSvg;
  }
  const theme: DocTheme = { id, version, tokens, footer: footer ?? DEFAULT_FOOTER };
  if (Object.keys(dark).length > 0) theme.darkTokens = dark;
  if (logoSvg) {
    const clean = sanitizeSvg(logoSvg, { idPrefix: 'logo-', ariaLabel: 'Logo', rootClass: 'doc-logo-svg' });
    if (clean) theme.logoSvg = clean;
    else warnings.push('theme-logo-dropped');
  }
  return { theme, source, warnings };
}

function decls(tokens: Readonly<Partial<Record<TokenName, string>>>): string {
  return TOKEN_NAMES.filter((n) => tokens[n] !== undefined && isValidTokenValue(tokens[n] ?? ''))
    .map((n) => `${n}:${tokens[n] ?? ''}`)
    .join(';');
}

/** Dark values written for a theme: explicit ones plus the derived rest (07 §11.4). */
export function themeDarkTokens(theme: DocTheme): Partial<Record<TokenName, string>> {
  return deriveDarkTokens(theme.tokens, theme.darkTokens ?? {});
}

const LIGHT_SEL = ':root:root:root';
const DARK_AUTO_SEL = ':root:root:root:not([data-theme="light"])';
const DARK_SEL = ':root:root:root[data-theme="dark"]';

/**
 * Body of `<style id="eli5-theme">` (07 §11.4): the light overrides, then the dark variant under the
 * same guards as the runtime's own dark palette (auto follows the system, the toggle wins). The
 * light block (0,3,0) beats every runtime token rule; the dark blocks (0,4,0) beat the light block,
 * so a themed document still switches with the system and the Auto/Light/Dark toggle.
 */
export function themeCss(theme: DocTheme): string {
  const light = decls(theme.tokens);
  const dark = decls(themeDarkTokens(theme));
  if (!light && !dark) return '';
  let css = `${LIGHT_SEL}{${light}}`;
  if (dark) css += `@media (prefers-color-scheme: dark){${DARK_AUTO_SEL}{${dark}}}${DARK_SEL}{${dark}}`;
  return css;
}

function parseDecls(body: string): Partial<Record<TokenName, string>> {
  const out: Partial<Record<TokenName, string>> = {};
  for (const decl of body.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const name = decl.slice(0, i).trim();
    const value = decl.slice(i + 1).trim();
    if (isTokenName(name) && isValidTokenValue(value)) out[name] = value;
  }
  return out;
}

/**
 * The explicit dark tokens of a themed block written by themeCss, for parseDocument (07 §8): none
 * when the dark block is exactly what derivation gives, else the whole block (re-rendering it is
 * then byte-identical either way).
 */
export function parseThemeDarkCss(css: string): Partial<Record<TokenName, string>> | undefined {
  const start = css.indexOf(`${DARK_SEL}{`);
  if (start < 0) return undefined;
  const body = css.slice(start + DARK_SEL.length + 1, css.indexOf('}', start));
  const dark = parseDecls(body);
  const derived = deriveDarkTokens(parseThemeCss(css));
  const names = new Set([...Object.keys(dark), ...Object.keys(derived)]) as Set<TokenName>;
  for (const n of names) if (dark[n] !== (derived as Partial<Record<TokenName, string>>)[n]) return dark;
  return undefined;
}

/** Inverse of themeCss for the light tokens (the first block), used by parseDocument (07 §8). */
export function parseThemeCss(css: string): Partial<Record<TokenName, string>> {
  return parseDecls(/\{([^{}]*)\}/.exec(css)?.[1] ?? '');
}

const THEME_BLOCK_RE = /(<style id="eli5-theme">)([^<]*)(<\/style>)/;

/**
 * A document rendered before dark variants existed (07 §11.4) has only the light block, which then
 * wins in dark mode too. Returns the page with its theme block rewritten by themeCss, or the same
 * string when there is nothing to upgrade. The viewer applies this when serving (the file on disk
 * changes at its next re-render).
 */
export function upgradeThemeBlock(html: string): string {
  const m = THEME_BLOCK_RE.exec(html);
  const body = m?.[2] ?? '';
  if (!m || !body.startsWith(`${LIGHT_SEL}{`) || body.includes(DARK_SEL)) return html;
  const next = themeCss({ id: 'upgrade', version: '1', tokens: parseThemeCss(body) });
  if (!next || next === body) return html;
  return html.slice(0, m.index) + m[1] + next + m[3] + html.slice(m.index + m[0].length);
}
