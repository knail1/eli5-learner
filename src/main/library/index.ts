/** Public API of src/main/library (09). Catalog I/O, protocol and merge land in M1/M3. */
export * from './types';
export * from './schema';
export {
  SLUG_PATTERN,
  SLUG_MAX_LENGTH,
  RESERVED_SLUGS,
  MAX_NUMERIC_SUFFIX,
  isValidSlug,
  isReservedSlug,
  slugify,
  baseSlug,
  chooseSlug,
} from './slug';
export type { ChooseSlugOptions } from './slug';
export { resolveLibraryRoot, LIBRARY_DIR_ENV } from './root';
export {
  defaultLibraryPolicy,
  defaultMergeEligibility,
  TRASH_RETENTION_DAYS,
  RESOLVED_SUGGESTION_RETENTION_DAYS,
} from './policy';
export { registerPublic } from './register';
