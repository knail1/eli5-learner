// Skill theme input (02 §11, 07 §11.3): CSS custom properties from the skill CSS become DocTheme tokens.
import { TOKEN_NAMES, type TokenName } from '../document';

const TOKENS = new Set<string>(TOKEN_NAMES);

/**
 * Splits CSS into the text outside `@media ... { ... }` blocks and the bodies of the
 * `@media (prefers-color-scheme: dark)` blocks (a skill's explicit dark values, 07 §11.4).
 */
function splitMedia(css: string): { base: string; dark: string } {
  let base = '';
  let dark = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@media', i);
    if (at < 0) {
      base += css.slice(i);
      break;
    }
    base += css.slice(i, at);
    const open = css.indexOf('{', at);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
    }
    if (/prefers-color-scheme\s*:\s*dark/i.test(css.slice(at, open))) dark += css.slice(open + 1, j - 1) + '\n';
    i = j;
  }
  return { base, dark };
}

function tokensIn(body: string): Partial<Record<TokenName, string>> {
  const out: Partial<Record<TokenName, string>> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+)/gi)) {
    const name = m[1] ?? '';
    const value = (m[2] ?? '').trim();
    if (TOKENS.has(name) && !(name in out) && value) out[name as TokenName] = value;
  }
  return out;
}

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Known token declarations (`--paper: #fff`) outside @media blocks; the first declaration of a
 * token wins. Values are validated later by resolveDocTheme (07 §11.3).
 */
export function parseThemeTokens(css: string): Partial<Record<TokenName, string>> {
  return tokensIn(splitMedia(stripComments(css)).base);
}

/** Known token declarations inside `@media (prefers-color-scheme: dark)` blocks (07 §11.4). */
export function parseThemeDarkTokens(css: string): Partial<Record<TokenName, string>> {
  return tokensIn(splitMedia(stripComments(css)).dark);
}
