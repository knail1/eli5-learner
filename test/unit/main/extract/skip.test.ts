import { describe, expect, it } from 'vitest';
import { DEFAULT_EXTRACT_LIMITS, skipReason, timeoutFor, type ExtractSkipCode } from '../../../../src/main/extract';
import { formatBytes } from '../../../../src/main/extract/skip';

const src = { ref: 'Board deck.pptx', location: '/Users/someone/Board deck.pptx', format: 'pptx' as const };

describe('skip reasons (04 §8.2)', () => {
  it('uses the documented templates', () => {
    const cases: Array<[ExtractSkipCode, Parameters<typeof skipReason>[2], string]> = [
      ['unsupported-type', {}, 'Unsupported file type (.pptx)'],
      ['encrypted', {}, 'File is password protected'],
      ['corrupt', {}, 'File could not be read (damaged or not a valid PowerPoint file)'],
      ['empty', {}, 'No readable content found'],
      ['too-large', { size: 12 * 1024 * 1024, limit: 10 * 1024 * 1024 }, 'File too large (12 MB; limit 10 MB)'],
      ['zip-bomb', {}, 'File expands to an unsafe size'],
      ['timeout', { seconds: 45 }, 'Took too long to read (over 45s)'],
      ['image-too-large', {}, 'Image too large to send'],
      ['image-budget-exceeded', { maxImages: 20 }, 'Too many images in one job (limit 20)'],
      ['scan-render-failed', {}, 'Scanned PDF pages could not be rendered'],
      ['internal-error', {}, 'Unexpected error while reading this file'],
      ['cancelled', {}, 'Job was cancelled'],
    ];
    for (const [code, p, text] of cases) {
      const reason = skipReason(code, src, p);
      expect(reason).toBe(text);
      expect(reason).not.toContain('/Users/');
    }
  });

  it('formats sizes in binary units', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(100 * 1024 * 1024)).toBe('100 MB');
  });

  it('uses the 04 §10.2 timeouts', () => {
    const t = (f: Parameters<typeof timeoutFor>[0]): number => timeoutFor(f, DEFAULT_EXTRACT_LIMITS);
    expect([t('text'), t('markdown'), t('csv')]).toEqual([10_000, 10_000, 10_000]);
    expect([t('docx'), t('xlsx'), t('pptx')]).toEqual([30_000, 30_000, 45_000]);
    expect(t('pdf')).toBe(120_000 + 15_000 * 30);
    expect(t('png')).toBe(30_000);
  });
});
