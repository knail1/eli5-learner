import { IPC, type TestNotificationResult } from '../../preload/contract';
import { NoPayload, type Register } from './handle';

/**
 * Notification controls (11 §14.6, §14.7), implemented by the notifications slice
 * (src/main/shell/notifications.ts). Completion notifications themselves are wired by bootstrap
 * from the job queue's `done` event, not over IPC.
 */
export interface NotificationControls {
  /** `eli5:app:test-notification`: Notifier.test(). */
  test(): TestNotificationResult;
  /**
   * `eli5:app:open-notification-settings`: opens the fixed System Settings URL constant, rate
   * limited like safeOpenExternal (12 §7.5 exception). Never takes a renderer-supplied URL.
   */
  openSystemSettings(): Promise<void>;
}

/** `eli5:app:*` notification invokes (11 §10). navigate / context-menu are registered by registerIpc. */
export function registerAppIpc(on: Register, d: { notifications: NotificationControls }): void {
  on(IPC.app.testNotification, NoPayload, (): TestNotificationResult => d.notifications.test());
  on(IPC.app.openNotificationSettings, NoPayload, () => d.notifications.openSystemSettings());
}
