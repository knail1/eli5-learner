import { describe, expect, it } from 'vitest';
import { parsePlistStringArray } from '../../../../src/main/sources/plist';
import { FINDER_PLIST } from './fixtures';

describe('parsePlistStringArray', () => {
  it('reads every string in order and decodes entities', () => {
    expect(parsePlistStringArray(FINDER_PLIST)).toEqual([
      '/Users/example/Documents/Q3 Review.pptx',
      '/Users/example/Documents/Notes & Actions.md',
      '/Users/example/Desktop/café.png',
    ]);
  });

  it('handles an empty array, self-closing strings and comments', () => {
    expect(parsePlistStringArray('<plist version="1.0"><array/></plist>')).toEqual([]);
    expect(parsePlistStringArray('<plist><array><!-- c --><string/><string>a</string></array></plist>')).toEqual([
      '',
      'a',
    ]);
  });

  it.each([
    ['not xml at all', '/Users/example/a.txt'],
    ['no plist root', '<array><string>a</string></array>'],
    ['dict root', '<plist><dict><key>a</key><string>b</string></dict></plist>'],
    ['non-string element', '<plist><array><integer>1</integer></array></plist>'],
    ['unknown entity', '<plist><array><string>&bogus;</string></array></plist>'],
    ['unterminated', '<plist><array><string>a</string>'],
  ])('returns null for malformed input: %s', (_label, xml) => {
    expect(parsePlistStringArray(xml)).toBeNull();
  });
});
