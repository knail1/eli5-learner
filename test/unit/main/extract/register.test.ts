import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../../src/main/config/schema';
import { Registry } from '../../../../src/main/editions/registry';
import { registerPublic } from '../../../../src/main/extract';

describe('extract registerPublic', () => {
  it('registers no extractors in M0', () => {
    const reg = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
    registerPublic(reg);
    expect(reg.extractors()).toEqual([]);
  });
});
