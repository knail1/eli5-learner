import type { NotificationClass, NotificationLike, NotificationOptions } from './notifications';

/**
 * Test-build notifier spy (13 §8.2 E16, §8.3). Stands in for Electron's `Notification` so e2e
 * specs can read what would have been posted and invoke its click handler from the main process.
 * Bootstrap loads it only under `__ELI5_TEST__` with the fake LLM; packaged builds never contain it.
 */

export interface SpiedNotification extends NotificationOptions {
  shown: boolean;
  closed: boolean;
  /** Fires the listeners the notifier registered for a click. */
  click(): void;
  close(): void;
}

export interface NotificationSpy {
  Notification: NotificationClass;
  /** Every notification constructed, in order. */
  records: SpiedNotification[];
}

export function createNotificationSpy(): NotificationSpy {
  const records: SpiedNotification[] = [];

  class SpyNotification implements NotificationLike {
    private readonly listeners = { click: [] as (() => void)[], close: [] as (() => void)[] };
    private readonly record: SpiedNotification;

    constructor(opts: NotificationOptions) {
      this.record = {
        title: opts.title,
        body: opts.body,
        silent: opts.silent,
        shown: false,
        closed: false,
        click: () => {
          for (const l of [...this.listeners.click]) l();
        },
        close: () => this.close(),
      };
    }

    on(event: 'click' | 'close', listener: () => void): this {
      this.listeners[event].push(listener);
      return this;
    }

    show(): void {
      this.record.shown = true;
      records.push(this.record);
    }

    close(): void {
      if (this.record.closed) return;
      this.record.closed = true;
      for (const l of [...this.listeners.close]) l();
    }
  }

  return { Notification: SpyNotification, records };
}
