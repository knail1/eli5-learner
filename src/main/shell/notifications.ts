import type { Settings } from '../config';
import type { DocumentMeta } from '../library';
import { log } from '../security';
import type { PublicationRecord, TestNotificationResult, UiRoute } from '../../preload/contract';

/**
 * Completion notifications (11 §14). `createNotifier(deps)` posts one native "Document ready"
 * per finished create job and routes its click at click time (§14.4). Electron's main-process
 * `Notification` class is injected so this file stays testable and never imports the pipeline.
 * Bootstrap wires JobQueue `done` to `Notifier.documentReady` (shell/completion.ts).
 */

export interface DocumentReadyEvent {
  slug: string;
  docId: string;
  title: string;
}

/** HOOK-UI-03 body policy; public default `{hideTitle:false}` (01 §6.2 `notificationPolicy()`). */
export interface NotificationPolicy {
  hideTitle: boolean;
}

export const PUBLIC_NOTIFICATION_POLICY: NotificationPolicy = Object.freeze({ hideTitle: false });

/** The constructor options this module passes to Electron's `Notification` (11 §14.3). */
export interface NotificationOptions {
  title: string;
  body: string;
  silent: boolean;
}

/** The subset of Electron's `Notification` instance the notifier uses. */
export interface NotificationLike {
  on(event: 'click' | 'close', listener: () => void): unknown;
  show(): void;
  close(): void;
}

export type NotificationClass = new (opts: NotificationOptions) => NotificationLike;

export interface NotifierDeps {
  /** Electron's main-process `Notification` class. */
  Notification: NotificationClass;
  /** Electron Notification.isSupported(). */
  isSupported: () => boolean;
  now: () => number;
  /** showMainWindow() (11 §3.2 step 6), recreating the window if needed. */
  showMainWindow: () => void;
  /** 11 §14.4 'app' route for an existing document: viewer.open(slug) + navigate {view:'doc'}. */
  openInApp: (slug: string) => void;
  /** Emits `eli5:app:navigate` (not-found, settings). */
  navigate: (route: UiRoute) => void;
  /** safeOpenExternal (12 §7.5); rejects on refusal. */
  openExternal: (url: string) => Promise<void>;
  /** 09; null when the document is gone. */
  getMeta: (slug: string) => Promise<DocumentMeta | null>;
  /** Read live, never cached. */
  settings: () => Settings['notifications'];
  /** registry.notificationPolicy() (HOOK-UI-03), read at post time. */
  policy: () => NotificationPolicy;
}

export interface Notifier {
  documentReady(e: DocumentReadyEvent): void;
  test(): TestNotificationResult;
  /** Retained live notifications (11 §14.5); for tests and diagnostics. */
  liveCount(): number;
}

export const NOTIFICATION_TITLE = 'Document ready';
export const GENERIC_BODY = 'Your document is ready';
export const TEST_BODY = 'This is a test notification';
export const MAX_LIVE_NOTIFICATIONS = 20;
const MAX_BODY = 120;

// C0/C1 controls and bidi marks, as for tray labels (11 §4.1, §14.3).
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/** 11 §14.3 body: the cleaned title (≤ 120 chars + "…"), or generic when hidden or empty. */
export function notificationBody(title: string, hideTitle: boolean): string {
  if (hideTitle) return GENERIC_BODY;
  const clean = title.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim();
  if (!clean) return GENERIC_BODY;
  const chars = Array.from(clean);
  return chars.length > MAX_BODY ? `${chars.slice(0, MAX_BODY).join('').trimEnd()}…` : clean;
}

function isHttps(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !!u.hostname;
  } catch {
    return false;
  }
}

const PREFERRED_KIND: Record<Settings['notifications']['preferredLink'], PublicationRecord['kind'] | undefined> = {
  drive: 'drive',
  site: 'git',
  'most-recent': undefined,
};

/**
 * 11 §14.4 steps 1–3: https candidates only (local exports never count), newest of the preferred
 * publisher kind, else the newest candidate of any kind.
 */
export function pickPublishedLink(
  publications: readonly PublicationRecord[],
  preferred: Settings['notifications']['preferredLink'],
): string | undefined {
  const newest = (xs: readonly PublicationRecord[]) =>
    [...xs].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0))[0];
  const candidates = publications.filter((p) => p.kind !== 'local' && isHttps(p.primaryUrl));
  const kind = PREFERRED_KIND[preferred];
  const pick = (kind ? newest(candidates.filter((p) => p.kind === kind)) : undefined) ?? newest(candidates);
  return pick?.primaryUrl;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  // 11 §14.5: keep references until click/close so the click handler survives GC.
  const live = new Map<string, NotificationLike>();
  let seq = 0;

  /** Returns false when show() throws (11 §13): the entry is released and nothing escapes. */
  const post = (keyBase: string, body: string, onClick: () => void): boolean => {
    const key = `${keyBase}:${deps.now()}:${seq++}`;
    const n = new deps.Notification({ title: NOTIFICATION_TITLE, body, silent: true });
    n.on('click', () => {
      live.delete(key);
      onClick();
    });
    n.on('close', () => live.delete(key));
    while (live.size >= MAX_LIVE_NOTIFICATIONS) {
      const [oldestKey, oldest] = live.entries().next().value as [string, NotificationLike];
      live.delete(oldestKey);
      oldest.close();
    }
    live.set(key, n);
    try {
      n.show();
      return true;
    } catch {
      live.delete(key);
      return false;
    }
  };

  const openApp = async (slug: string): Promise<void> => {
    deps.showMainWindow();
    const meta = await deps.getMeta(slug).catch(() => null);
    if (meta) deps.openInApp(slug);
    else deps.navigate({ view: 'not-found', slug });
  };

  const openLink = async (slug: string): Promise<void> => {
    const meta = await deps.getMeta(slug).catch(() => null);
    const url = meta ? pickPublishedLink(meta.publications, deps.settings().preferredLink) : undefined;
    if (url) {
      try {
        await deps.openExternal(url);
        return;
      } catch {
        // Refused or rate limited: fall back below.
      }
    }
    log.info('notification.fallback', { slug, kind: 'app' });
    await openApp(slug);
  };

  const onClick = (slug: string): void => {
    // Resolved at click time (11 §14.4).
    const kind = deps.settings().clickAction;
    log.info('notification.clicked', { slug, kind });
    const run = kind === 'published-link' ? openLink(slug) : openApp(slug);
    run.catch((err: unknown) => log.error('notification.click-failed', { slug }, err));
  };

  const blocked = (): TestNotificationResult | undefined => {
    if (!deps.isSupported()) return { shown: false, reason: 'unsupported' };
    if (!deps.settings().enabled) return { shown: false, reason: 'disabled' };
    return undefined;
  };

  return {
    documentReady(e) {
      if (!deps.isSupported()) return log.info('notification.fallback', { slug: e.slug, kind: 'app' });
      if (!deps.settings().enabled) return;
      if (!post(e.slug, notificationBody(e.title, deps.policy().hideTitle), () => onClick(e.slug))) {
        return log.info('notification.fallback', { slug: e.slug, kind: 'app' });
      }
      log.info('notification.shown', { slug: e.slug, kind: 'ready' });
    },
    test() {
      const reason = blocked();
      if (reason) return reason;
      const shown = post('test', TEST_BODY, () => {
        deps.showMainWindow();
        deps.navigate({ view: 'settings', section: 'notifications' });
      });
      if (!shown) {
        // 11 §13: a throwing show() is treated as unsupported; the IPC call never rejects.
        log.info('notification.fallback', { kind: 'app' });
        return { shown: false, reason: 'unsupported' };
      }
      log.info('notification.shown', { kind: 'test' });
      return { shown: true };
    },
    liveCount: () => live.size,
  };
}

/** 11 §14.6: the fixed System Settings deep link (the 12 §7.5 exception). Never renderer-supplied. */
export const NOTIFICATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension';

const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export interface NotificationControlsDeps {
  notifier: Pick<Notifier, 'test'>;
  /** Electron `shell.openExternal`; called only with NOTIFICATION_SETTINGS_URL. */
  openExternal: (url: string) => Promise<void>;
  now: () => number;
  /** The app's bundle id, appended as `id` when it is a reverse-DNS identifier. */
  bundleId?: string;
}

/** `eli5:app:test-notification` and `eli5:app:open-notification-settings` (ipc/app.ts). */
export function createNotificationControls(d: NotificationControlsDeps): {
  test(): TestNotificationResult;
  openSystemSettings(): Promise<void>;
} {
  const url =
    d.bundleId && BUNDLE_ID.test(d.bundleId)
      ? `${NOTIFICATION_SETTINGS_URL}?id=${encodeURIComponent(d.bundleId)}`
      : NOTIFICATION_SETTINGS_URL;
  let times: number[] = [];
  return {
    test: () => d.notifier.test(),
    async openSystemSettings() {
      // Same limit as safeOpenExternal (12 §7.5 step 2): 2 per second, 20 per minute.
      const now = d.now();
      times = times.filter((t) => now - t < 60_000);
      if (times.filter((t) => now - t < 1000).length >= 2 || times.length >= 20) {
        log.warn('open-external.rate-limited', { count: times.length });
        return;
      }
      times.push(now);
      await d.openExternal(url);
    },
  };
}
