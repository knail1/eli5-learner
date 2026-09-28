import type {
  CatalogEntry,
  LibraryFolder,
  LibraryLocation,
  LibraryMoveReceipt,
  LibraryOrganization,
  TrashItem,
} from '../../../preload/contract';
import { filterCatalog, relativeDate } from './order';

/**
 * Library grouping for the sidebar (11 §5.2, 09 §4.2): unfiled documents first, then user folders
 * by name, then the built-in Archive; the Trash row sits at the bottom. The filter searches inside
 * folders and the Archive and opens the ones that match.
 */

export const ARCHIVE_KEY = 'archive';

export interface FolderGroup {
  folder: LibraryFolder;
  entries: CatalogEntry[];
  open: boolean;
}

export interface LibraryGroups {
  unfiled: CatalogEntry[];
  folders: FolderGroup[];
  archive: { entries: CatalogEntry[]; open: boolean; shown: boolean };
  /** Documents shown after the filter. */
  matches: number;
}

export const EMPTY_ORGANIZATION: LibraryOrganization = {
  folders: [],
  placement: {},
  trash: [],
  trashRetentionDays: 30,
};

/** Where a catalogued document is filed in `org`; dangling folder placements read as unfiled. */
export function placeOf(org: LibraryOrganization, docId: string): Exclude<LibraryLocation, 'trash'> {
  const p = org.placement[docId];
  if (p === 'archive') return 'archive';
  if (p && org.folders.some((f) => f.id === p)) return p;
  return 'unfiled';
}

/** `entries` in Library order; `expanded` holds folder ids (and 'archive') the user opened. */
export function groupLibrary(
  entries: readonly CatalogEntry[],
  org: LibraryOrganization,
  query: string,
  expanded: ReadonlySet<string>,
): LibraryGroups {
  const q = query.trim().toLowerCase();
  const matched = new Set(filterCatalog(entries, q).map((e) => e.id));
  const byPlace = new Map<string, CatalogEntry[]>();
  for (const e of entries) {
    const at = placeOf(org, e.id);
    byPlace.set(at, [...(byPlace.get(at) ?? []), e]);
  }
  const shownOf = (list: CatalogEntry[], nameMatches = false) =>
    !q || nameMatches ? list : list.filter((e) => matched.has(e.id));

  const unfiled = shownOf(byPlace.get('unfiled') ?? []);
  const folders: FolderGroup[] = [];
  for (const folder of [...org.folders].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )) {
    const shown = shownOf(byPlace.get(folder.id) ?? [], !!q && folder.name.toLowerCase().includes(q));
    if (q && shown.length === 0) continue;
    folders.push({ folder, entries: shown, open: expanded.has(folder.id) || (!!q && shown.length > 0) });
  }
  const archived = shownOf(byPlace.get('archive') ?? []);
  const archive = {
    entries: archived,
    shown: !q || archived.length > 0,
    open: expanded.has(ARCHIVE_KEY) || (!!q && archived.length > 0),
  };
  const matches = unfiled.length + folders.reduce((n, f) => n + f.entries.length, 0) + archived.length;
  return { unfiled, folders, archive, matches };
}

const folderName = (org: LibraryOrganization, id: string): string | undefined =>
  org.folders.find((f) => f.id === id)?.name;

/** The Undo toast's text (11 §5.2). */
export function moveMessage(r: LibraryMoveReceipt, org: LibraryOrganization): string {
  if (r.to === 'trash') return 'Moved to Trash';
  if (r.to === 'archive') return 'Moved to Archive';
  if (r.to !== 'unfiled') return `Moved to “${folderName(org, r.to) ?? 'folder'}”`;
  if (r.from === 'archive') return 'Removed from Archive';
  const from = r.from === 'unfiled' ? undefined : folderName(org, r.from);
  return from ? `Removed from “${from}”` : 'Removed from folder';
}

function ago(iso: string, now: number): string {
  const r = relativeDate(iso, now);
  if (r === 'now') return 'just now';
  return /^\d+[mhdw]$/.test(r) ? `${r} ago` : `on ${r}`;
}

/** Secondary line of a Trash row: when, and where from or what it was merged into. */
export function trashDetail(t: TrashItem, now: number = Date.now()): string {
  if (t.reason === 'merged' && t.mergedInto) return `Merged into “${t.mergedInto}” ${ago(t.trashedAt, now)}`;
  const from = t.from === 'archive' ? ' · from Archive' : t.fromName ? ` · from “${t.fromName}”` : '';
  return `Deleted ${ago(t.trashedAt, now)}${from}`;
}
