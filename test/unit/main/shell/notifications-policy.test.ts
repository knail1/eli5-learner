import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../../src/main/config';
import { Registry } from '../../../../src/main/editions';
import { registerPublicCapabilities } from '../../../../src/main/editions/public';

/** HOOK-UI-03 body policy slot (01 §6.2, 11 §14.1). */

const registry = () => {
  const reg = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
  registerPublicCapabilities(reg);
  return reg;
};

describe('notificationPolicy registry slot (HOOK-UI-03)', () => {
  it('defaults to showing the title in the public edition', () => {
    expect(registry().notificationPolicy()).toEqual({ hideTitle: false });
  });

  it('is a single slot an overlay replaces', () => {
    const reg = registry();
    reg.registerNotificationPolicy({ hideTitle: true });
    expect(reg.notificationPolicy()).toEqual({ hideTitle: true });
  });

  it('refuses registration after freeze', () => {
    const reg = registry();
    reg.freeze();
    expect(() => reg.registerNotificationPolicy({ hideTitle: true })).toThrow(/frozen/);
  });
});
