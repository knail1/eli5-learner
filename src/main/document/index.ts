// Public entry of src/main/document (07 §8). M0: types, IDs, default theme and references.
export type * from './types';
export { TOKEN_NAMES } from './types';
export {
  SECTION_ID_RE,
  TAB_KEY_RE,
  SECTION_ELI5_TAB_KEY_RE,
  INDEPTH_TAB_KEY,
  ELI5_TAB_KEY,
  MAX_ID_DRAWS,
  cryptoIdSource,
  IdExhaustedError,
  isSectionId,
  isTabKey,
  isSectionEli5TabKey,
  tabKeyOfSectionId,
  mintSectionId,
  mintSectionEli5TabKey,
} from './section-id';
export type { IdSource, TakenIds } from './section-id';
export { DEFAULT_FOOTER, defaultDocTheme, docThemeRef } from './theme';
export { defaultReferenceFormatter, SKIPPED_REASON_FALLBACK } from './references';
export { registerPublic } from './register';
