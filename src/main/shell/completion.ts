import { log } from '../security';
import type { DocumentReadyEvent } from './notifications';

/** The fields of the job queue's `done` event this listener reads (06 §5.7 step 5). */
export interface CompletionEvent extends DocumentReadyEvent {
  kind: 'create' | 'section';
}

/**
 * 11 §14.2: bootstrap subscribes this to JobQueue `done`. Create jobs post one "Document ready";
 * section jobs post nothing. The notifier slot is read at event time (undefined until the
 * notifications slice is plugged in), and a notifier failure never reaches the queue.
 */
export function notifyOnCreateDone(
  notifier: () => { documentReady(e: DocumentReadyEvent): void } | undefined,
): (e: CompletionEvent) => void {
  return (e) => {
    if (e.kind !== 'create') return;
    try {
      notifier()?.documentReady({ slug: e.slug, docId: e.docId, title: e.title });
    } catch (err) {
      log.error('notification.failed', { slug: e.slug }, err);
    }
  };
}
