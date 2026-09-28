import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../../src/main/config/schema';
import { Registry } from '../../../../src/main/editions/registry';
import { registerPublic } from '../../../../src/main/extract';

describe('extract registerPublic (04 §3)', () => {
  it('registers every extractor in the fixed order', () => {
    const reg = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
    registerPublic(reg);
    expect(reg.extractors().map((e) => e.id)).toEqual([
      'pptx',
      'docx',
      'pdf',
      'xlsx',
      'csv',
      'image',
      'markdown',
      'text',
      'html',
    ]);
  });

  it('is identical in the enterprise edition (no private hooks)', () => {
    const pub = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
    const ent = new Registry({ edition: 'enterprise', getSettings: () => DEFAULTS });
    registerPublic(pub);
    registerPublic(ent);
    expect(ent.extractors().map((e) => e.id)).toEqual(pub.extractors().map((e) => e.id));
  });

  it('covers every SourceFormat exactly once', () => {
    const reg = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
    registerPublic(reg);
    const formats = reg.extractors().flatMap((e) => [...e.formats]);
    expect(new Set(formats).size).toBe(formats.length);
    expect([...formats].sort()).toEqual(
      [
        'bmp',
        'csv',
        'docx',
        'gif',
        'heic',
        'html',
        'jpeg',
        'markdown',
        'pdf',
        'png',
        'pptx',
        'text',
        'tiff',
        'webp',
        'xlsx',
      ].sort(),
    );
  });
});
