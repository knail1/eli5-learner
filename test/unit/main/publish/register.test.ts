import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../../src/main/config/schema';
import { Registry } from '../../../../src/main/editions/registry';
import { BaselineSecretScanner, defaultPrePublishPolicy, registerPublic } from '../../../../src/main/publish';

describe('registerPublic (10 §4)', () => {
  function build(): Registry {
    const reg = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
    registerPublic(reg);
    return reg;
  }

  it('registers local (available) and drive/git stubs (unavailable)', () => {
    expect(build().publishers()).toEqual([
      { id: 'local', available: true },
      { id: 'drive', available: false },
      { id: 'git', available: false },
    ]);
  });

  it('fills the secretScanner and prePublishPolicy slots', async () => {
    const reg = build();
    expect(reg.secretScanner()).toBeInstanceOf(BaselineSecretScanner);
    expect(reg.prePublishPolicy()).toBe(defaultPrePublishPolicy);
    expect(reg.missingSlots()).not.toContain('secretScanner');
    expect(reg.missingSlots()).not.toContain('prePublishPolicy');
  });

  it('default pre-publish policy allows everything (HOOK-PUB-05 no-op)', async () => {
    const decision = await defaultPrePublishPolicy({
      slug: 'demo',
      title: 'Demo',
      targetId: 'local',
      kind: 'local',
      files: [],
      settings: DEFAULTS,
      signal: new AbortController().signal,
    });
    expect(decision).toEqual({ allow: true });
  });

  it('publisher(id) returns the registered implementations', () => {
    const reg = build();
    expect(reg.publisher('local').stub).toBeUndefined();
    expect(reg.publisher('drive').stub).toBe(true);
    expect(reg.publisher('git').stub).toBe(true);
  });
});
