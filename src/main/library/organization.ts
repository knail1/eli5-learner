/**
 * Library organization (09 §4.2): user folders (one level), the built-in Archive, and the Trash.
 * `.eli5/organization.json` holds folders, each document's folder by document id, and a record per
 * `.trash/` entry. Pure helpers only; FsLibrary does the I/O under the catalog lock.
 */
import { z } from 'zod';
import { SLUG_PATTERN } from './slug';
import type {
  FolderId,
  LibraryFolder,
  LibraryLocation,
  LibraryOrganization,
  OrganizationFile,
  TrashItem,
  TrashRecord,
} from './types';

export const ORGANIZATION_FILE = 'organization.json';
export const ORGANIZATION_SCHEMA_VERSION = 1;
/** Folder ids: `f-` + 8 hex; never 'archive', 'unfiled' or 'trash'. */
export const FOLDER_ID_RE = /^f-[0-9a-f]{8}$/;
export const MAX_FOLDER_NAME_CHARS = 60;
/** The system rows' names; a user folder may not take them (any case). */
export const RESERVED_FOLDER_NAMES: readonly string[] = ['archive', 'trash'];

/**
 * A user-facing Trash entry: `<slug>--<yyyymmddThhmmss>[-n]` (09 §4). Pre-merge backups
 * (`…-premerge`) are merge housekeeping (09 §10.6 step 5), never listed, emptied or put back.
 */
const SLUG_SRC = SLUG_PATTERN.source.replace(/^\^/, '').replace(/\$$/, '');
export const TRASH_ID_RE = new RegExp(`^(${SLUG_SRC})--(\\d{8}T\\d{6})(?:-(\\d{1,4}))?$`);

export const emptyOrganization = (): OrganizationFile => ({
  schemaVersion: ORGANIZATION_SCHEMA_VERSION,
  folders: [],
  placement: {},
  trashed: {},
});

const Timestamp = z.iso.datetime();
const FolderIdSchema = z.custom<FolderId>((v) => typeof v === 'string' && FOLDER_ID_RE.test(v), {
  message: 'Invalid folder id',
});
const FromSchema = z.union([z.literal('unfiled'), z.literal('archive'), FolderIdSchema]);

export const LibraryFolderSchema = z.object({
  id: FolderIdSchema,
  name: z.string().min(1).max(MAX_FOLDER_NAME_CHARS),
  createdAt: Timestamp,
});

export const TrashRecordSchema = z.object({
  docId: z.string().min(1),
  trashedAt: Timestamp,
  reason: z.enum(['trashed', 'merged']),
  from: FromSchema,
  fromName: z.string().max(MAX_FOLDER_NAME_CHARS).optional(),
  mergedInto: z.string().max(200).optional(),
});

export const OrganizationFileSchema = z.object({
  schemaVersion: z.number().int().min(1),
  folders: z.array(LibraryFolderSchema),
  placement: z.record(z.string(), z.union([z.literal('archive'), FolderIdSchema])),
  trashed: z.record(z.string(), TrashRecordSchema),
});

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _DriftChecks = [
  Assert<Same<z.output<typeof OrganizationFileSchema>, OrganizationFile>>,
  Assert<Same<z.output<typeof TrashRecordSchema>, TrashRecord>>,
  Assert<Same<z.output<typeof LibraryFolderSchema>, LibraryFolder>>,
];

/** One line, trimmed, 1..60 characters, not a system name; undefined when unusable. */
export function cleanFolderName(name: string): string | undefined {
  const one = name.replace(/\s+/g, ' ').trim();
  if (one === '' || Array.from(one).length > MAX_FOLDER_NAME_CHARS) return undefined;
  if (RESERVED_FOLDER_NAMES.includes(one.toLowerCase())) return undefined;
  return one;
}

/** True when another folder (not `exceptId`) already has this name, ignoring case. */
export function folderNameTaken(org: OrganizationFile, name: string, exceptId?: string): boolean {
  const n = name.toLowerCase();
  return org.folders.some((f) => f.id !== exceptId && f.name.toLowerCase() === n);
}

export const isFolderId = (v: string): v is FolderId => FOLDER_ID_RE.test(v);

/** Where a catalogued document lives; unknown or dangling placements read as unfiled. */
export function locationIn(org: OrganizationFile, docId: string): Exclude<LibraryLocation, 'trash'> {
  const p = org.placement[docId];
  if (p === 'archive') return 'archive';
  if (p && org.folders.some((f) => f.id === p)) return p;
  return 'unfiled';
}

/** A copy with `docId` placed at `to` (unfiled removes the placement). */
export function withPlacement(
  org: OrganizationFile,
  docId: string,
  to: Exclude<LibraryLocation, 'trash'>,
): OrganizationFile {
  const placement = { ...org.placement };
  if (to === 'unfiled') delete placement[docId];
  else placement[docId] = to;
  return { ...org, placement };
}

/** The slug part of a trash id, or undefined when the id is not a Trash entry. */
export function slugOfTrashId(trashId: string): string | undefined {
  return TRASH_ID_RE.exec(trashId)?.[1];
}

/** Folders by name for display (the file keeps creation order). */
export function sortedFolders(folders: readonly LibraryFolder[]): LibraryFolder[] {
  return [...folders].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** The wire view: placements only for catalogued ids and existing folders; Trash newest first. */
export function organizationView(
  org: OrganizationFile,
  liveIds: ReadonlySet<string>,
  trash: TrashItem[],
  trashRetentionDays: number,
): LibraryOrganization {
  const placement: LibraryOrganization['placement'] = {};
  for (const id of Object.keys(org.placement)) {
    if (!liveIds.has(id)) continue;
    const at = locationIn(org, id);
    if (at !== 'unfiled') placement[id] = at;
  }
  return {
    folders: sortedFolders(org.folders).map((f) => ({ ...f })),
    placement,
    trash: [...trash].sort((a, b) =>
      a.trashedAt === b.trashedAt ? a.trashId.localeCompare(b.trashId) : a.trashedAt < b.trashedAt ? 1 : -1,
    ),
    trashRetentionDays,
  };
}
