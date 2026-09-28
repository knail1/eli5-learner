import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../../src/main/config/schema';
import { Registry } from '../../../../src/main/editions/registry';
import {
  defaultLibraryPolicy,
  defaultMergeEligibility,
  LibraryError,
  registerPublic,
  RESOLVED_SUGGESTION_RETENTION_DAYS,
  TRASH_RETENTION_DAYS,
} from '../../../../src/main/library';
import type { DocumentMeta } from '../../../../src/main/library';

describe('library registerPublic (HOOK-LIB-01, HOOK-LIB-02)', () => {
  it('fills the libraryPolicy and mergeEligibility slots', () => {
    const reg = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
    expect(reg.missingSlots()).toContain('libraryPolicy');
    registerPublic(reg);
    expect(reg.missingSlots()).not.toContain('libraryPolicy');
    expect(reg.missingSlots()).not.toContain('mergeEligibility');
    expect(reg.libraryPolicy()).toBe(defaultLibraryPolicy);
    expect(reg.mergeEligibility()).toBe(defaultMergeEligibility);
  });

  it('public defaults: 30-day retention, full URLs, every pair eligible', () => {
    expect(TRASH_RETENTION_DAYS).toBe(30);
    expect(RESOLVED_SUGGESTION_RETENTION_DAYS).toBe(30);
    expect(defaultLibraryPolicy.trashRetentionDays).toBe(30);
    expect(defaultLibraryPolicy.resolvedSuggestionRetentionDays).toBe(30);
    expect(defaultLibraryPolicy.sourceUrls).toBe('full');
    expect(defaultLibraryPolicy.resolveRoot({ isPackaged: true, repoRoot: '/r', userData: '/u', env: {} })).toBe(
      '/u/docs',
    );
    const m = {} as DocumentMeta;
    expect(defaultMergeEligibility(m, m)).toBe(true);
  });

  it('LibraryError carries code and detail', () => {
    const e = new LibraryError('SLUG_TAKEN', { slug: 'x' });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('SLUG_TAKEN');
    expect(e.message).toBe('SLUG_TAKEN');
    expect(e.detail).toEqual({ slug: 'x' });
  });
});
