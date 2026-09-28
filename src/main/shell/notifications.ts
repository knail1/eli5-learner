import type { Settings } from '../config';
import type { DocumentMeta } from '../library';

/**
 * Completion notifications (11 §14). Contract only; the notifications slice implements
 * `createNotifier(deps)` and the notification-settings opener in this file (exported through
 * shell/index.ts by `export *`). Bootstrap wires JobQueue `done` to `Notifier.documentReady`.
 */

export interface DocumentReadyEvent {
  slug: string;
  docId: string;
  title: string;
}

export interface NotifierDeps {
  /** Electron Notification.isSupported(). */
  isSupported: () => boolean;
  now: () => number;
  /** 11 §14.4 'app' route. */
  openInApp: (slug: string) => void;
  /** safeOpenExternal (12 §7.5); rejects on refusal. */
  openExternal: (url: string) => Promise<void>;
  /** 09; null when the document is gone. */
  getMeta: (slug: string) => Promise<DocumentMeta | null>;
  /** Read live, never cached. */
  settings: () => Settings['notifications'];
}

export interface Notifier {
  documentReady(e: DocumentReadyEvent): void;
  test(): { shown: boolean; reason?: 'disabled' | 'unsupported' };
}
