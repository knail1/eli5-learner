import { z } from 'zod';
import { IPC, type CatalogEntry, type IpcChannel, type JobSnapshot } from '../../preload/contract';
import { setTrayActiveJobs, setTrayCatalog } from './tray';
import { activeJobCounter } from './tray-model';
import { navigate, shellHooks, showLibraryItemMenu } from './window';

/**
 * Shell entry points for the IPC layer and bootstrap: the Library context menu handler and the
 * Tray feed from app-renderer change events (11 §4.2, §5.2, §10).
 */

/** `eli5:app:context-menu` request (11 §10). */
export const ContextMenuRequest = z.object({ kind: z.literal('library-item'), slug: z.string().min(1).max(200) });
export type ContextMenuRequest = z.infer<typeof ContextMenuRequest>;

/** Pops the native Library item menu. Open navigates; Reveal uses the library hook when wired (09). */
export function handleContextMenu(r: ContextMenuRequest): void {
  showLibraryItemMenu(r.slug, {
    open: (slug) => {
      shellHooks().openDocument?.(slug);
      navigate({ view: 'doc', slug });
    },
    reveal: (slug) => shellHooks().revealDocument?.(slug),
  });
}

const jobs = activeJobCounter();

/**
 * Observes every event main pushes to the app renderer and keeps the Tray current: recents on
 * `eli5:library:changed`, the busy state on `eli5:jobs:changed` (11 §4.2). Bootstrap routes
 * `IpcDeps.sendToApp` through this.
 */
export function observeAppEvent(channel: IpcChannel, payload: unknown): void {
  if (channel === IPC.library.changed) {
    const entries = (payload as { entries?: unknown } | null)?.entries;
    if (Array.isArray(entries)) setTrayCatalog(entries as CatalogEntry[]);
  } else if (channel === IPC.jobs.changed) {
    const s = payload as Partial<JobSnapshot> | null;
    if (s && typeof s.id === 'string' && typeof s.status === 'string') {
      setTrayActiveJobs(jobs.update({ id: s.id, status: s.status }));
    }
  }
}

/** Startup seed from `library:list` and `jobs:list` once 09 and 06 are registered (11 §4.2). */
export function seedTray(s: { catalog?: readonly CatalogEntry[]; jobs?: readonly JobSnapshot[] }): void {
  if (s.catalog) setTrayCatalog(s.catalog);
  if (s.jobs) setTrayActiveJobs(jobs.reset(s.jobs));
}
