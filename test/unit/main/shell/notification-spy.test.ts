import { describe, expect, it, vi } from 'vitest';
import { createNotificationSpy } from '../../../../src/main/shell/notification-spy';
import { createNotifier, NOTIFICATION_TITLE, type NotifierDeps } from '../../../../src/main/shell/notifications';

/**
 * 13 §8.2 E16, §8.3: the test-build notifier spy stands in for Electron's Notification class. It
 * records what would be posted and lets the e2e call the recorded click handler from main.
 */

const settings: ReturnType<NotifierDeps['settings']> = {
  enabled: true,
  clickAction: 'app',
  preferredLink: 'most-recent',
};

function notifier(spy: ReturnType<typeof createNotificationSpy>, over: Partial<NotifierDeps> = {}) {
  return createNotifier({
    Notification: spy.Notification,
    isSupported: () => true,
    now: () => 0,
    showMainWindow: vi.fn(),
    openInApp: vi.fn(),
    navigate: vi.fn(),
    openExternal: vi.fn(() => Promise.resolve()),
    getMeta: () => Promise.resolve(null),
    settings: () => settings,
    policy: () => ({ hideTitle: false }),
    ...over,
  });
}

describe('createNotificationSpy', () => {
  it('records each shown notification with its options and shows nothing natively', () => {
    const spy = createNotificationSpy();
    notifier(spy).documentReady({ slug: 'topic-a', docId: 'd1', title: 'Topic A' });
    expect(spy.records).toHaveLength(1);
    expect(spy.records[0]).toMatchObject({ title: NOTIFICATION_TITLE, body: 'Topic A', silent: true, shown: true });
  });

  it('click() runs the notifier click handler that was registered', async () => {
    const spy = createNotificationSpy();
    const showMainWindow = vi.fn();
    const openInApp = vi.fn();
    const n = notifier(spy, {
      showMainWindow,
      openInApp,
      getMeta: () => Promise.resolve({} as Awaited<ReturnType<NotifierDeps['getMeta']>>),
    });
    n.documentReady({ slug: 'topic-a', docId: 'd1', title: 'Topic A' });
    spy.records[0]?.click();
    expect(showMainWindow).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(openInApp).toHaveBeenCalledWith('topic-a'));
    // A clicked notification is released by the notifier (11 §14.5).
    expect(n.liveCount()).toBe(0);
  });

  it('records nothing when notifications are off', () => {
    const spy = createNotificationSpy();
    notifier(spy, { settings: () => ({ ...settings, enabled: false }) }).documentReady({
      slug: 'topic-a',
      docId: 'd1',
      title: 'Topic A',
    });
    expect(spy.records).toEqual([]);
  });

  it('close() fires close listeners and marks the record closed', () => {
    const spy = createNotificationSpy();
    const n = notifier(spy);
    n.documentReady({ slug: 'topic-a', docId: 'd1', title: 'Topic A' });
    expect(n.liveCount()).toBe(1);
    spy.records[0]?.close();
    expect(spy.records[0]?.closed).toBe(true);
    expect(n.liveCount()).toBe(0);
  });
});
