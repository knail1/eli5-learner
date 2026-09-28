import { describe, expect, it, vi } from 'vitest';
import type { NotificationControls } from '../../../../src/main/ipc';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: {}, session: {} }));

const { IPC } = await import('../../../../src/preload/contract');
const { setup } = await import('./harness');

/** `eli5:app:test-notification`, `eli5:app:open-notification-settings` (11 §14.6, §14.7). */

const forbidden = { ok: false, error: { code: 'E_FORBIDDEN', message: 'Forbidden' } };

function fakeControls() {
  return {
    test: vi.fn((): { shown: boolean; reason?: 'disabled' | 'unsupported' } => ({ shown: true })),
    openSystemSettings: vi.fn(async () => {}),
  } satisfies NotificationControls;
}

describe('notification channels (11 §14)', () => {
  it('test-notification returns the notifier result', async () => {
    const svc = fakeControls();
    const h = await setup({ services: { notifications: svc } });
    expect(await h.call(IPC.app.testNotification)).toEqual({ ok: true, value: { shown: true } });
    svc.test.mockReturnValueOnce({ shown: false, reason: 'disabled' });
    expect(await h.call(IPC.app.testNotification)).toEqual({ ok: true, value: { shown: false, reason: 'disabled' } });
  });

  it('open-notification-settings takes no payload; the URL is never renderer-supplied (12 §7.5)', async () => {
    const svc = fakeControls();
    const h = await setup({ services: { notifications: svc } });
    expect(await h.call(IPC.app.openNotificationSettings)).toEqual({ ok: true, value: undefined });
    expect(svc.openSystemSettings).toHaveBeenCalledWith();
    expect(await h.call(IPC.app.openNotificationSettings, { url: 'x-apple.systempreferences:evil' })).toMatchObject({
      ok: false,
      error: { code: 'E_BAD_REQUEST' },
    });
    expect(svc.openSystemSettings).toHaveBeenCalledTimes(1);
  });

  it('are app-only', async () => {
    const svc = fakeControls();
    const h = await setup({ services: { notifications: svc } });
    expect(await h.call(IPC.app.testNotification, undefined, 'viewer')).toEqual(forbidden);
    expect(await h.call(IPC.app.openNotificationSettings, undefined, 'viewer')).toEqual(forbidden);
    expect(svc.test).not.toHaveBeenCalled();
  });

  it('answer "Not implemented yet" until the notifier is plugged in', async () => {
    const h = await setup();
    expect(await h.call(IPC.app.testNotification)).toEqual({
      ok: false,
      error: { code: 'E_INTERNAL', message: 'Not implemented yet' },
    });
  });
});
