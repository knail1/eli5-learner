// Public entry of src/main/document (07 §8): build, render, parse, mutate, validity.
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
export {
  DEFAULT_FOOTER,
  defaultDocTheme,
  docThemeRef,
  resolveDocTheme,
  sanitizeTokens,
  themeCss,
  upgradeThemeBlock,
  isValidTokenValue,
} from './theme';
export type { ThemeLayers } from './theme';
export { defaultReferenceFormatter, SKIPPED_REASON_FALLBACK } from './references';
export { registerPublic } from './register';

// 07 §8 module API
export {
  buildDocumentModel,
  photoSlotKey,
  sanitizeCredit,
  ELI5_PLACEHOLDER_HEADING,
  ELI5_PLACEHOLDER_TEXT,
  MAX_SECTIONS_PER_TAB,
} from './build';
export { licenseName } from './render/credit';
export { renderDocument, renderSectionHtml, documentCsp, scriptHash, TAB_LABEL_MAX } from './render';
export {
  parseDocument,
  parseModelJson,
  locateSection,
  locateModelJson,
  spliceSection,
  spliceSpan,
  FORMAT_VERSION,
} from './parse';
export {
  getSectionContext,
  replaceSection,
  addSectionEli5Tab,
  removeTab,
  sectionEli5Label,
  sectionIdsOfTab,
  sectionToDraft,
  MAX_SECTION_ELI5_TABS,
} from './mutate';
export {
  DocumentFormatError,
  DocumentBuildError,
  TooManyTabsError,
  DocumentMutationError,
  DocRuntimeMissingError,
} from './errors';
export { canonicalJson } from './canonical-json';
export { DocumentModelSchema } from './schema';

// Runtime, images, sanitizing and validity (07 §2, §5.6, §7.3; 13 §7)
export { DOC_RUNTIME_JS, DOC_RUNTIME_CSS, DOC_RUNTIME_VERSION, bundledDocRuntime } from './runtime-assets';
export {
  createNativeImageNormalizer,
  passThroughNormalizer,
  sniffImage,
  MAX_IMAGE_EDGE,
  MAX_IMAGE_BYTES,
} from './images';
export type { ImageNormalizer, NormalizedImage, NativeImageModule, NativeImageLike } from './images';
export { sanitizeSvg, colorToken } from './svg-sanitize';
export { checkDocumentHtml, MAX_DOCUMENT_BYTES } from './validity';
export type { ValidityReport, ValidityError, ValidityRule, ValidityMeta } from './validity';

// M3 slices (08, 09 §10): filled by their builders; see each file's header.
export * from './interactive';
export * from './merge';
