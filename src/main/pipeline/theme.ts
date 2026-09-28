// Skill theme input (02 §11, 07 §11.3): CSS custom properties from the skill CSS become DocTheme tokens.
import { TOKEN_NAMES, type TokenName } from '../document';

const TOKENS = new Set<string>(TOKEN_NAMES);

/** Removes `@media ... { ... }` blocks (dark-mode overrides are the runtime's job, 07 §11.1). */
function stripMedia(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@media', i);
    if (at < 0) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, at);
    const open = css.indexOf('{', at);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
    }
    i = j;
  }
  return out;
}

/**
 * Known token declarations (`--paper: #fff`) outside @media blocks; the first declaration of a
 * token wins. Values are validated later by resolveDocTheme (07 §11.3).
 */
export function parseThemeTokens(css: string): Partial<Record<TokenName, string>> {
  const body = stripMedia(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  const out: Partial<Record<TokenName, string>> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+)/gi)) {
    const name = m[1] ?? '';
    const value = (m[2] ?? '').trim();
    if (TOKENS.has(name) && !(name in out) && value) out[name as TokenName] = value;
  }
  return out;
}
