/** Public API of src/main/library (09). */
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
export {
  openLibrary,
  gitCheckIgnored,
  FsLibrary,
  READ_ONLY_MESSAGES,
  STAGING_DIR,
  TRASH_DIR,
  ELI5_DIR,
  CATALOG_FILE,
  META_FILE,
  INDEX_FILE,
} from './library';
export type { OpenLibraryOptions } from './library';
export { writeFileAtomic, writeJsonAtomic, fsyncDir, renameDirAtomic } from './fs-atomic';
export { AsyncMutex, acquireProcessLock, releaseProcessLock, defaultProcessProbe } from './locks';
export type { ProcessLockRecord, ProcessLockResult } from './locks';
export { readVersioned, metaMigrations, catalogMigrations, suggestionsMigrations } from './migrations';
export type { Migration } from './migrations';
export { createDocProtocolHandler, installDocProtocol, DOC_SCHEME } from './protocol';
export type { DocProtocolDeps } from './protocol';

// M3 merge suggestions (09 §10): filled by the merge slice.
export * from './merge';
