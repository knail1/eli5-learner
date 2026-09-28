import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../../src/main/config/schema';
import { Registry } from '../../../../src/main/editions/registry';
import {
  DEFAULT_FOOTER,
  defaultDocTheme,
  defaultReferenceFormatter,
  registerPublic,
} from '../../../../src/main/document';

describe('document registerPublic (HOOK-DOC-01, HOOK-DOC-02)', () => {
  it('fills the docTheme and referenceFormatter slots with the public defaults', () => {
    const reg = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
    expect(reg.missingSlots()).toEqual(expect.arrayContaining(['docTheme', 'referenceFormatter']));
    registerPublic(reg);
    expect(reg.missingSlots()).not.toContain('docTheme');
    expect(reg.missingSlots()).not.toContain('referenceFormatter');
    expect(reg.docTheme()).toBe(defaultDocTheme);
    expect(reg.referenceFormatter()).toBe(defaultReferenceFormatter);
  });

  it('default theme is neutral: footer only, no logo, no token overrides', () => {
    expect(defaultDocTheme.footer).toBe(DEFAULT_FOOTER);
    expect(DEFAULT_FOOTER).toBe('Made with ELI5 Learner');
    expect(defaultDocTheme.logoSvg).toBeUndefined();
    expect(Object.keys(defaultDocTheme.tokens)).toEqual([]);
  });
});
