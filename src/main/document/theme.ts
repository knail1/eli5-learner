// Neutral default document theme (07 §11.3; HOOK-DOC-01 public behavior).
import type { DocTheme, DocThemeRef } from './types';

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
