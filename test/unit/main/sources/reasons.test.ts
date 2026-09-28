import { describe, expect, it } from 'vitest';
import { mapMcpErrorKind, SKIP_REASONS, skip, skipReason } from '../../../../src/main/sources/reasons';
import type { McpError, SkipCode } from '../../../../src/main/sources/types';

/** Every SkipCode in the 03 §2 union; the Record type makes a missing key a compile error. */
const ALL: Record<SkipCode, true> = {
  'not-found': true,
  'permission-denied': true,
  'not-a-regular-file': true,
  empty: true,
  'file-changed': true,
  'unsupported-type': true,
  'legacy-office-format': true,
  'too-large': true,
  'limit-exceeded': true,
  'not-a-url': true,
  'unsupported-scheme': true,
  'not-available-in-edition': true,
  'sign-in-required': true,
  'access-denied': true,
  cancelled: true,
  'read-error': true,
  'fetch-failed': true,
  'login-required': true,
  paywall: true,
  timeout: true,
  'http-error': true,
  'empty-content': true,
  'render-failed': true,
  'blocked-private-address': true,
  encrypted: true,
  corrupt: true,
  'zip-bomb': true,
  'image-too-large': true,
  'image-budget-exceeded': true,
  'scan-render-failed': true,
  'internal-error': true,
};

describe('SKIP_REASONS (03 §9)', () => {
  it('has a non-empty reason for exactly the SkipCode union', () => {
    expect(Object.keys(SKIP_REASONS).sort()).toEqual(Object.keys(ALL).sort());
    for (const r of Object.values(SKIP_REASONS)) expect(r.trim()).not.toBe('');
  });

  it.each([
    ['not-found', 'File not found.'],
    ['permission-denied', 'macOS did not allow the app to read this file.'],
    ['legacy-office-format', 'Older Office format; re-save as .pptx, .docx, or .xlsx.'],
    ['limit-exceeded', 'Too many sources in one job; this one was not used.'],
    ['not-available-in-edition', 'Requires the enterprise edition.'],
    ['encrypted', 'File is password protected'],
  ] as const)('%s -> %s', (code, text) => {
    expect(SKIP_REASONS[code]).toBe(text);
  });
});

describe('skipReason / skip', () => {
  it('uses the base text without detail', () => {
    expect(skip('a.pdf', 'not-found')).toEqual({ ref: 'a.pdf', code: 'not-found', reason: 'File not found.' });
  });

  it('appends one detail clause', () => {
    expect(skipReason('unsupported-type', 'ZIP archive')).toBe('Unsupported file type: ZIP archive.');
    expect(skipReason('not-available-in-edition', 'Organization source; requires the enterprise edition')).toBe(
      'Requires the enterprise edition: Organization source; requires the enterprise edition.',
    );
  });

  it('drops a detail that repeats the base', () => {
    expect(skipReason('encrypted', 'File is password protected')).toBe('File is password protected');
    expect(skipReason('legacy-office-format', 'Older Office format; re-save as .pptx, .docx, or .xlsx')).toBe(
      SKIP_REASONS['legacy-office-format'],
    );
    expect(skipReason('empty', '   ')).toBe('File was empty.');
  });
});

describe('mapMcpErrorKind (03 §10.1 rule 2)', () => {
  it.each([
    ['auth-expired', 'sign-in-required'],
    ['forbidden', 'access-denied'],
    ['not-found', 'not-found'],
    ['too-large', 'too-large'],
    ['timeout', 'timeout'],
    ['transport', 'fetch-failed'],
    ['tool-error', 'fetch-failed'],
  ] as Array<[McpError['kind'], SkipCode]>)('%s -> %s', (kind, code) => {
    expect(mapMcpErrorKind(kind)).toBe(code);
  });
});
