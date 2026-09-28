import { z } from 'zod';
import {
  IPC,
  type CatalogEntry,
  type IpcChannel,
  type JobSnapshot,
  type LibraryOrganization,
} from '../../preload/contract';
import { setTrayActiveJobs, setTrayArchived, setTrayCatalog } from './tray';
import { activeJobCounter, archivedIds } from './tray-model';
import { navigate, shellHooks, showLibraryItemMenu } from './window';

/**
 * Shell entry points for the IPC layer and bootstrap: the Library context menu handler and the
 * Tray feed from app-renderer change events (11 §4.2, §5.2, §10).
 */

/** `eli5:app:context-menu` request (11 §10). */
export const ContextMenuRequest = z.object({ kind: z.literal('library-item'), slug: z.string().min(1).max(200) });
export type ContextMenuRequest = z.infer<typeof ContextMenuRequest>;

/**
 * Pops the native Library item menu. Open navigates; Reveal uses the library hook when wired (09).
 * With the organize hooks, Move to / Archive / Move to Trash file the document in main; the
 * library's `moved` event lets the app show its Undo toast (09 §4.2, 11 §5.2).
 */
export function handleContextMenu(r: ContextMenuRequest): void {
  const hooks = shellHooks();
  const organize = hooks.organizeMenu?.(r.slug);
  showLibraryItemMenu(
    r.slug,
    {
      open: (slug) => {
        shellHooks().openDocument?.(slug);
        navigate({ view: 'doc', slug });
      },
      reveal: (slug) => shellHooks().revealDocument?.(slug),
      ...(hooks.moveDocument ? { move: (slug, to) => shellHooks().moveDocument?.(slug, to) } : {}),
    },
    organize,
  );
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
  } else if (channel === IPC.library.organizationChanged) {
    const o = (payload as { organization?: Partial<LibraryOrganization> } | null)?.organization;
    if (o && typeof o.placement === 'object' && o.placement !== null)
      setTrayArchived(archivedIds({ placement: o.placement }));
  } else if (channel === IPC.jobs.changed) {
    const s = payload as Partial<JobSnapshot> | null;
    if (s && typeof s.id === 'string' && typeof s.status === 'string') {
      setTrayActiveJobs(jobs.update({ id: s.id, status: s.status }));
    }
  }
}

/** Startup seed from `library:list` and `jobs:list` once 09 and 06 are registered (11 §4.2). */
export function seedTray(s: {
  catalog?: readonly CatalogEntry[];
  archived?: ReadonlySet<string>;
  jobs?: readonly JobSnapshot[];
}): void {
  if (s.archived) setTrayArchived(s.archived);
  if (s.catalog) setTrayCatalog(s.catalog);
  if (s.jobs) setTrayActiveJobs(jobs.reset(s.jobs));
}
