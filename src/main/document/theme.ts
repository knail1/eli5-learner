// Document themes (07 §11.3; HOOK-DOC-01 public behavior): neutral default, token validation,
// precedence default < skill < overlay, and the `#eli5-theme` override block.
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
  let source: DocThemeRef['source'] = 'default';
  let id = base.id;
  let version = base.version;
  let footer = base.footer;
  let logoSvg = base.logoSvg;
  if (layers.skill && Object.keys(layers.skill).length > 0) {
    tokens = { ...tokens, ...sanitizeTokens(layers.skill, warn) };
    source = 'skill';
  }
  if (layers.overlay) {
    tokens = { ...tokens, ...sanitizeTokens(layers.overlay.tokens as Record<string, string>, warn) };
    source = 'overlay';
    id = layers.overlay.id;
    version = layers.overlay.version;
    footer = layers.overlay.footer ?? footer;
    logoSvg = layers.overlay.logoSvg ?? logoSvg;
  }
  const theme: DocTheme = { id, version, tokens, footer: footer ?? DEFAULT_FOOTER };
  if (logoSvg) {
    const clean = sanitizeSvg(logoSvg, { idPrefix: 'logo-', ariaLabel: 'Logo', rootClass: 'doc-logo-svg' });
    if (clean) theme.logoSvg = clean;
    else warnings.push('theme-logo-dropped');
  }
  return { theme, source, warnings };
}

/** Body of `<style id="eli5-theme">`: overrides that win over both light and dark defaults. */
export function themeCss(theme: DocTheme): string {
  const entries = TOKEN_NAMES.filter(
    (n) => theme.tokens[n] !== undefined && isValidTokenValue(theme.tokens[n] ?? ''),
  ).map((n) => `${n}:${theme.tokens[n] ?? ''}`);
  // Specificity (0,3,0) beats the runtime's `:root:not([data-theme="light"])` and `[data-theme]` rules.
  return entries.length ? `:root:root:root{${entries.join(';')}}` : '';
}

/** Inverse of themeCss, used by parseDocument (07 §8). */
export function parseThemeCss(css: string): Partial<Record<TokenName, string>> {
  const out: Partial<Record<TokenName, string>> = {};
  const body = /\{([^}]*)\}/.exec(css)?.[1] ?? '';
  for (const decl of body.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const name = decl.slice(0, i).trim();
    const value = decl.slice(i + 1).trim();
    if (isTokenName(name) && isValidTokenValue(value)) out[name] = value;
  }
  return out;
}
