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

describe('images settings (12 §3.2, 07 §7.4)', () => {
  it('stock photos default on and accept only a boolean (strict)', () => {
    expect(DEFAULTS.images).toEqual({ stockPhotos: true });
    expect(SettingsSchema.parse({ images: { stockPhotos: false } }).images.stockPhotos).toBe(false);
    expect(SettingsSchema.safeParse({ images: { stockPhotos: 'yes' } }).success).toBe(false);
    expect(SettingsSchema.safeParse({ images: { provider: 'x' } }).success).toBe(false);
    expect(isDormantPath('images.stockPhotos')).toBe(false);
  });
});

describe('sync settings (12 §3.2, 16 §8)', () => {
  it('defaults: off, the app-data store, 60 s polls, recent history, inbox off', () => {
    expect(DEFAULTS.sync).toEqual({
      enabled: false,
      store: 'google-drive-appdata',
      pollSeconds: 60,
      history: 'recent',
      inbox: { enabled: false },
    });
  });

  it('applies nested defaults when only part of the namespace is present (prefault)', () => {
    expect(SettingsSchema.parse({ sync: { enabled: true } }).sync).toMatchObject({
      enabled: true,
      pollSeconds: 60,
      inbox: { enabled: false },
    });
    expect(SettingsSchema.parse({ sync: { inbox: {} } }).sync.inbox.enabled).toBe(false);
  });

  it('accepts documented values and rejects the rest (strict)', () => {
    const s = SettingsSchema.parse({ sync: { pollSeconds: 3600, history: 'all', inbox: { enabled: true } } }).sync;
    expect(s).toMatchObject({ pollSeconds: 3600, history: 'all', inbox: { enabled: true } });
    for (const bad of [
      { sync: { pollSeconds: 29 } },
      { sync: { pollSeconds: 3601 } },
      { sync: { pollSeconds: 60.5 } },
      { sync: { history: 'none' } },
      { sync: { enabled: 'yes' } },
      { sync: { store: '' } },
      { sync: { token: 'x' } },
      { sync: { inbox: { enabled: true, rate: 5 } } },
    ]) {
      expect(SettingsSchema.safeParse(bad).success).toBe(false);
    }
    expect(isDormantPath('sync.enabled')).toBe(false);
  });
});
