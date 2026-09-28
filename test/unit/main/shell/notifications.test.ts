import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_LIVE_NOTIFICATIONS,
  NOTIFICATION_SETTINGS_URL,
  createNotificationControls,
  createNotifier,
  notificationBody,
  pickPublishedLink,
  type NotificationLike,
  type NotificationOptions,
  type NotifierDeps,
} from '../../../../src/main/shell/notifications';
import { log } from '../../../../src/main/security';
import type { DocumentMeta } from '../../../../src/main/library';
import type { Settings } from '../../../../src/main/config';
import type { PublicationRecord, UiRoute } from '../../../../src/preload/contract';

/** 11 §14: completion notifications. Electron's Notification is injected as a fake class. */

type NotificationSettings = Settings['notifications'];

class FakeNotification implements NotificationLike {
  static created: FakeNotification[] = [];
  readonly listeners = new Map<string, () => void>();
  shown = false;
  closed = false;
  constructor(readonly opts: NotificationOptions) {
    FakeNotification.created.push(this);
  }
  on(event: 'click' | 'close', listener: () => void): this {
    this.listeners.set(event, listener);
    return this;
  }
  show(): void {
    this.shown = true;
  }
  close(): void {
    this.closed = true;
    this.listeners.get('close')?.();
  }
  click(): void {
    this.listeners.get('click')?.();
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function pub(kind: PublicationRecord['kind'], primaryUrl: string, publishedAt: string): PublicationRecord {
  return { targetId: kind, kind, primaryUrl, publishedAt, contentSha256: 'a'.repeat(64) };
}

function meta(publications: PublicationRecord[] = []): DocumentMeta {
  return { publications } as unknown as DocumentMeta;
}

interface Harness {
  deps: NotifierDeps;
  settings: NotificationSettings;
  policy: { hideTitle: boolean };
  supported: boolean;
  calls: string[];
  routes: UiRoute[];
  opened: string[];
  metaFor: DocumentMeta | null;
  rejectOpen: boolean;
}

function harness(): Harness {
  const h: Harness = {
    settings: { enabled: true, clickAction: 'app', preferredLink: 'most-recent' },
    policy: { hideTitle: false },
    supported: true,
    calls: [],
    routes: [],
    opened: [],
    metaFor: meta(),
    rejectOpen: false,
    deps: undefined as unknown as NotifierDeps,
  };
  let t = 1000;
  h.deps = {
    Notification: FakeNotification,
    isSupported: () => h.supported,
    now: () => t++,
    showMainWindow: () => h.calls.push('show'),
    openInApp: (slug) => h.calls.push(`open:${slug}`),
    navigate: (route) => h.routes.push(route),
    openExternal: async (url) => {
      if (h.rejectOpen) throw new Error('refused');
      h.opened.push(url);
    },
    getMeta: async () => h.metaFor,
    settings: () => h.settings,
    policy: () => h.policy,
  };
  return h;
}

const ready = { slug: 'solar-power', docId: 'doc-1', title: 'Solar power basics' };

afterEach(() => {
  FakeNotification.created = [];
  vi.restoreAllMocks();
});

describe('notificationBody (11 §14.3)', () => {
  it('is the title with control and bidi characters stripped', () => {
    expect(notificationBody('Solar\u0007 power‮ basics', false)).toBe('Solar power basics');
  });

  it('truncates to 120 characters plus an ellipsis', () => {
    const body = notificationBody('x'.repeat(200), false);
    expect(body).toBe(`${'x'.repeat(120)}…`);
    expect(notificationBody('y'.repeat(120), false)).toBe('y'.repeat(120));
  });

  it('is generic when the policy hides the title (HOOK-UI-03)', () => {
    expect(notificationBody('Secret project', true)).toBe('Your document is ready');
  });

  it('never posts an empty body', () => {
    expect(notificationBody('\u0000‏ ', false)).toBe('Your document is ready');
  });
});

describe('createNotifier documentReady (11 §14.2, §14.3)', () => {
  it('posts one silent "Document ready" with the title as body', () => {
    const h = harness();
    createNotifier(h.deps).documentReady(ready);
    expect(FakeNotification.created).toHaveLength(1);
    const n = FakeNotification.created[0]!;
    expect(n.opts).toEqual({ title: 'Document ready', body: 'Solar power basics', silent: true });
    expect(n.shown).toBe(true);
  });

  it('uses the generic body with hideTitle, read at post time', () => {
    const h = harness();
    const notifier = createNotifier(h.deps);
    h.policy = { hideTitle: true };
    notifier.documentReady(ready);
    expect(FakeNotification.created[0]!.opts.body).toBe('Your document is ready');
  });

  it('posts nothing when disabled, read live', () => {
    const h = harness();
    const notifier = createNotifier(h.deps);
    h.settings = { ...h.settings, enabled: false };
    notifier.documentReady(ready);
    expect(FakeNotification.created).toHaveLength(0);
    h.settings = { ...h.settings, enabled: true };
    notifier.documentReady(ready);
    expect(FakeNotification.created).toHaveLength(1);
  });

  it('posts nothing when notifications are unsupported', () => {
    const h = harness();
    h.supported = false;
    createNotifier(h.deps).documentReady(ready);
    expect(FakeNotification.created).toHaveLength(0);
  });

  it('logs notification.shown with slug and kind only, never the title', () => {
    const info = vi.spyOn(log, 'info');
    const h = harness();
    createNotifier(h.deps).documentReady(ready);
    expect(info).toHaveBeenCalledWith('notification.shown', { slug: 'solar-power', kind: 'ready' });
    expect(JSON.stringify(info.mock.calls)).not.toContain('Solar power basics');
  });
});

describe('reference retention (11 §14.5)', () => {
  it('holds live notifications until click or close', () => {
    const h = harness();
    const notifier = createNotifier(h.deps);
    notifier.documentReady(ready);
    notifier.documentReady({ ...ready, slug: 'b' });
    expect(notifier.liveCount()).toBe(2);
    FakeNotification.created[0]!.close();
    expect(notifier.liveCount()).toBe(1);
    FakeNotification.created[1]!.click();
    expect(notifier.liveCount()).toBe(0);
  });

  it('caps the map at 20 and closes the oldest first', () => {
    const h = harness();
    const notifier = createNotifier(h.deps);
    for (let i = 0; i < MAX_LIVE_NOTIFICATIONS + 1; i++) notifier.documentReady({ ...ready, slug: `s${i}` });
    expect(MAX_LIVE_NOTIFICATIONS).toBe(20);
    expect(notifier.liveCount()).toBe(20);
    expect(FakeNotification.created[0]!.closed).toBe(true);
    expect(FakeNotification.created.slice(1).every((n) => !n.closed)).toBe(true);
  });

  it('keeps two notifications for the same slug apart', () => {
    const h = harness();
    const notifier = createNotifier(h.deps);
    notifier.documentReady(ready);
    notifier.documentReady(ready);
    expect(notifier.liveCount()).toBe(2);
  });
});

describe('click routing: app (11 §14.4)', () => {
  it('shows the window, opens the document, and logs the click', async () => {
    const info = vi.spyOn(log, 'info');
    const h = harness();
    createNotifier(h.deps).documentReady(ready);
    FakeNotification.created[0]!.click();
    await flush();
    expect(h.calls).toEqual(['show', 'open:solar-power']);
    expect(h.routes).toEqual([]);
    expect(info).toHaveBeenCalledWith('notification.clicked', { slug: 'solar-power', kind: 'app' });
  });

  it('shows the not-found route when the document is gone', async () => {
    const h = harness();
    h.metaFor = null;
    createNotifier(h.deps).documentReady(ready);
    FakeNotification.created[0]!.click();
    await flush();
    expect(h.calls).toEqual(['show']);
    expect(h.routes).toEqual([{ view: 'not-found', slug: 'solar-power' }]);
  });

  it('shows not-found when reading the meta fails', async () => {
    const h = harness();
    h.deps.getMeta = async () => {
      throw new Error('io');
    };
    createNotifier(h.deps).documentReady(ready);
    FakeNotification.created[0]!.click();
    await flush();
    expect(h.routes).toEqual([{ view: 'not-found', slug: 'solar-power' }]);
  });
});

describe('pickPublishedLink (11 §14.4 steps 1-3)', () => {
  const drive1 = pub('drive', 'https://drive.example.test/a', '2026-01-01T00:00:00.000Z');
  const drive2 = pub('drive', 'https://drive.example.test/b', '2026-02-01T00:00:00.000Z');
  const site = pub('git', 'https://pages.example.test/s/', '2026-03-01T00:00:00.000Z');
  const local = pub('local', 'file:///tmp/export/index.html', '2026-04-01T00:00:00.000Z');
  const plain = pub('git', 'http://pages.example.test/insecure/', '2026-05-01T00:00:00.000Z');

  it('most-recent picks the newest https record of any kind', () => {
    expect(pickPublishedLink([drive1, site, drive2, local], 'most-recent')).toBe(site.primaryUrl);
  });

  it('drive picks the newest drive record', () => {
    expect(pickPublishedLink([drive1, site, drive2], 'drive')).toBe(drive2.primaryUrl);
  });

  it('site picks the newest git record', () => {
    expect(pickPublishedLink([drive1, site, drive2], 'site')).toBe(site.primaryUrl);
  });

  it('falls back to the newest candidate of any kind when the preferred kind is missing', () => {
    expect(pickPublishedLink([drive1, drive2], 'site')).toBe(drive2.primaryUrl);
  });

  it('never counts local exports or non-https links', () => {
    expect(pickPublishedLink([local, plain], 'most-recent')).toBeUndefined();
    expect(pickPublishedLink([], 'drive')).toBeUndefined();
  });

  it('ignores unparseable urls', () => {
    expect(pickPublishedLink([pub('drive', 'https://', '2026-06-01T00:00:00.000Z'), drive1], 'drive')).toBe(
      drive1.primaryUrl,
    );
  });
});

describe('click routing: published-link (11 §14.4)', () => {
  const linkSettings: NotificationSettings = { enabled: true, clickAction: 'published-link', preferredLink: 'drive' };

  it('opens the preferred link, resolved at click time', async () => {
    const info = vi.spyOn(log, 'info');
    const h = harness();
    h.settings = linkSettings;
    createNotifier(h.deps).documentReady(ready);
    // Published after the notification was posted.
    h.metaFor = meta([pub('drive', 'https://drive.example.test/share', '2026-01-01T00:00:00.000Z')]);
    FakeNotification.created[0]!.click();
    await flush();
    expect(h.opened).toEqual(['https://drive.example.test/share']);
    expect(h.calls).toEqual([]);
    expect(info).toHaveBeenCalledWith('notification.clicked', { slug: 'solar-power', kind: 'published-link' });
  });

  it('reads clickAction at click time', async () => {
    const h = harness();
    createNotifier(h.deps).documentReady(ready);
    h.settings = linkSettings;
    h.metaFor = meta([pub('git', 'https://pages.example.test/s/', '2026-01-01T00:00:00.000Z')]);
    FakeNotification.created[0]!.click();
    await flush();
    expect(h.opened).toEqual(['https://pages.example.test/s/']);
  });

  it('falls back to the app when there is no candidate and logs notification.fallback', async () => {
    const info = vi.spyOn(log, 'info');
    const h = harness();
    h.settings = linkSettings;
    h.metaFor = meta([pub('local', 'file:///tmp/x/index.html', '2026-01-01T00:00:00.000Z')]);
    createNotifier(h.deps).documentReady(ready);
    FakeNotification.created[0]!.click();
    await flush();
    expect(h.opened).toEqual([]);
    expect(h.calls).toEqual(['show', 'open:solar-power']);
    expect(info).toHaveBeenCalledWith('notification.fallback', { slug: 'solar-power', kind: 'app' });
  });

  it('falls back to the app when openExternal rejects', async () => {
    const h = harness();
    h.settings = linkSettings;
    h.rejectOpen = true;
    h.metaFor = meta([pub('drive', 'https://drive.example.test/share', '2026-01-01T00:00:00.000Z')]);
    createNotifier(h.deps).documentReady(ready);
    FakeNotification.created[0]!.click();
    await flush();
    expect(h.calls).toEqual(['show', 'open:solar-power']);
  });

  it('falls back to not-found when the document is gone', async () => {
    const h = harness();
    h.settings = linkSettings;
    h.metaFor = null;
    createNotifier(h.deps).documentReady(ready);
    FakeNotification.created[0]!.click();
    await flush();
    expect(h.calls).toEqual(['show']);
    expect(h.routes).toEqual([{ view: 'not-found', slug: 'solar-power' }]);
  });
});

describe('test notification (11 §14.7)', () => {
  it('reports unsupported and posts nothing', () => {
    const h = harness();
    h.supported = false;
    expect(createNotifier(h.deps).test()).toEqual({ shown: false, reason: 'unsupported' });
    expect(FakeNotification.created).toHaveLength(0);
  });

  it('reports disabled and posts nothing', () => {
    const h = harness();
    h.settings = { ...h.settings, enabled: false };
    expect(createNotifier(h.deps).test()).toEqual({ shown: false, reason: 'disabled' });
    expect(FakeNotification.created).toHaveLength(0);
  });

  it('posts the test notification; a click opens Settings > Notifications', () => {
    const info = vi.spyOn(log, 'info');
    const h = harness();
    const notifier = createNotifier(h.deps);
    expect(notifier.test()).toEqual({ shown: true });
    const n = FakeNotification.created[0]!;
    expect(n.opts).toEqual({ title: 'Document ready', body: 'This is a test notification', silent: true });
    expect(info).toHaveBeenCalledWith('notification.shown', { kind: 'test' });
    n.click();
    expect(h.calls).toEqual(['show']);
    expect(h.routes).toEqual([{ view: 'settings', section: 'notifications' }]);
    expect(notifier.liveCount()).toBe(0);
  });
});

describe('createNotificationControls (11 §14.6, 12 §7.5 exception)', () => {
  it('test() delegates to the notifier', () => {
    const c = createNotificationControls({
      notifier: { test: () => ({ shown: false, reason: 'disabled' }) },
      openExternal: async () => {},
      now: () => 0,
    });
    expect(c.test()).toEqual({ shown: false, reason: 'disabled' });
  });

  it('opens the fixed System Settings constant with the bundle id', async () => {
    const opened: string[] = [];
    const c = createNotificationControls({
      notifier: { test: () => ({ shown: true }) },
      openExternal: async (u) => void opened.push(u),
      now: () => 0,
      bundleId: 'io.example.app',
    });
    await c.openSystemSettings();
    expect(NOTIFICATION_SETTINGS_URL).toBe('x-apple.systempreferences:com.apple.Notifications-Settings.extension');
    expect(opened).toEqual([`${NOTIFICATION_SETTINGS_URL}?id=io.example.app`]);
  });

  it('opens the bare constant without a bundle id', async () => {
    const opened: string[] = [];
    const c = createNotificationControls({
      notifier: { test: () => ({ shown: true }) },
      openExternal: async (u) => void opened.push(u),
      now: () => 0,
    });
    await c.openSystemSettings();
    expect(opened).toEqual([NOTIFICATION_SETTINGS_URL]);
  });

  it('is rate limited to 2 per second and 20 per minute', async () => {
    const opened: string[] = [];
    let t = 0;
    const c = createNotificationControls({
      notifier: { test: () => ({ shown: true }) },
      openExternal: async (u) => void opened.push(u),
      now: () => t,
    });
    await c.openSystemSettings();
    await c.openSystemSettings();
    await c.openSystemSettings();
    expect(opened).toHaveLength(2);
    // 600 ms apart never trips the per-second limit; the 21st open within a minute is dropped.
    opened.length = 0;
    for (let i = 1; i <= 25; i++) {
      t = 60_000 + i * 600;
      await c.openSystemSettings();
    }
    expect(opened).toHaveLength(20);
    t = 1_000_000;
    await c.openSystemSettings();
    expect(opened).toHaveLength(21);
    expect(opened.at(-1)).toBe(NOTIFICATION_SETTINGS_URL);
  });

  it('never encodes a bundle id that is not a reverse-DNS identifier', async () => {
    const opened: string[] = [];
    const c = createNotificationControls({
      notifier: { test: () => ({ shown: true }) },
      openExternal: async (u) => void opened.push(u),
      now: () => 0,
      bundleId: 'bad id&x=1',
    });
    await c.openSystemSettings();
    expect(opened).toEqual([NOTIFICATION_SETTINGS_URL]);
  });
});
