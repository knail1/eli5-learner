import { describe, expect, it } from 'vitest';
import { properNounsOf, sanitizePhotoQuery } from '../../../../src/main/photos';

describe('sanitizePhotoQuery (07 §7.4 privacy guard)', () => {
  it('keeps short generic lowercase queries', () => {
    expect(sanitizePhotoQuery('courthouse exterior')).toBe('courthouse exterior');
    expect(sanitizePhotoQuery('  Person worried looking at laptop ')).toBe('person worried looking at laptop');
  });

  it('strips URLs, e-mail addresses, digits and quoted source text', () => {
    const at = ['clerk', 'example.org'].join('@');
    expect(sanitizePhotoQuery(`office desk https://example.org/case/42 ${at}`)).toBe('office desk');
    expect(sanitizePhotoQuery('filing cabinet 2024 case 17-cv-0042')).toBe('filing cabinet case');
    expect(sanitizePhotoQuery('courtroom "the defendant said no" gavel')).toBe('courtroom gavel');
    expect(sanitizePhotoQuery('courtroom “quoted words” gavel')).toBe('courtroom gavel');
  });

  it('drops proper-noun-looking tokens: acronyms, capitalized words after the first, known names', () => {
    expect(sanitizePhotoQuery('FBI agent at desk')).toBe('agent at desk');
    expect(sanitizePhotoQuery('empty office of Jane Smith')).toBe('empty office of');
    expect(sanitizePhotoQuery('Acme warehouse workers', new Set(['acme']))).toBe('warehouse workers');
    expect(sanitizePhotoQuery('iPhone on kitchen table')).toBe('on kitchen table');
  });

  it('caps the query at 6 words and 60 characters', () => {
    expect(sanitizePhotoQuery('one two three four five six seven eight')).toBe('one two three four five six');
    const long = sanitizePhotoQuery('extraordinarily lengthy description regarding municipal infrastructure buildings');
    expect(long).not.toBeNull();
    expect((long ?? '').length).toBeLessThanOrEqual(60);
  });

  it('returns null when nothing generic is left', () => {
    expect(sanitizePhotoQuery('')).toBeNull();
    expect(sanitizePhotoQuery('Jane Doe 42')).toBeNull();
    expect(sanitizePhotoQuery('a of')).toBeNull();
  });
});

describe('properNounsOf', () => {
  it('collects capitalized words that do not start a sentence', () => {
    const set = properNounsOf(['The court said that Acme Corp. lost. Then Jane Doe appealed to the Board.']);
    expect([...set].sort()).toEqual(['acme', 'board', 'corp', 'doe', 'jane']);
    expect(set.has('the')).toBe(false);
    expect(set.has('then')).toBe(false);
  });
});
