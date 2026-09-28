/** Public defaults for HOOK-LIB-01 and HOOK-LIB-02 (09 §3, §9, §10.2; 01 §6.3 hook table). */
import { resolveLibraryRoot } from './root';
import type { LibraryPolicy, MergeEligibility } from './types';

/** 09 §9; both subject to HOOK-LIB-01. */
export const TRASH_RETENTION_DAYS = 30;
export const RESOLVED_SUGGESTION_RETENTION_DAYS = 30;

export const defaultLibraryPolicy: LibraryPolicy = Object.freeze({
  resolveRoot: resolveLibraryRoot,
  trashRetentionDays: TRASH_RETENTION_DAYS,
  resolvedSuggestionRetentionDays: RESOLVED_SUGGESTION_RETENTION_DAYS,
  sourceUrls: 'full' as const,
});

/** Public build: any pair may be suggested; similarity alone decides (HOOK-LIB-02). */
export const defaultMergeEligibility: MergeEligibility = () => true;
