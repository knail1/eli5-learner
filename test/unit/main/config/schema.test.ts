import { describe, expect, it } from 'vitest';
import { DEFAULTS, SettingsSchema, isDormantPath } from '../../../../src/main/config/schema';

describe('notifications settings (12 §3.2, 11 §14)', () => {
  it('defaults: enabled, click opens the app, most recent link', () => {
    expect(DEFAULTS.notifications).toEqual({ enabled: true, clickAction: 'app', preferredLink: 'most-recent' });
  });

  it('applies the inner defaults when only part of the namespace is present (prefault)', () => {
    expect(SettingsSchema.parse({ notifications: { enabled: false } }).notifications).toEqual({
      enabled: false,
      clickAction: 'app',
      preferredLink: 'most-recent',
    });
  });

  it('accepts every documented value, including published-link in the public build', () => {
    const s = SettingsSchema.parse({ notifications: { clickAction: 'published-link', preferredLink: 'site' } });
    expect(s.notifications).toMatchObject({ clickAction: 'published-link', preferredLink: 'site' });
    expect(SettingsSchema.parse({ notifications: { preferredLink: 'drive' } }).notifications.preferredLink).toBe(
      'drive',
    );
  });

  it('rejects unknown values and unknown keys (strict)', () => {
    for (const bad of [
      { notifications: { clickAction: 'browser' } },
      { notifications: { preferredLink: 'newest' } },
      { notifications: { enabled: 'yes' } },
      { notifications: { sound: true } },
    ]) {
      expect(SettingsSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('is not a dormant namespace', () => {
    expect(isDormantPath('notifications.enabled')).toBe(false);
  });
});
