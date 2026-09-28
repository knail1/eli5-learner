/**
 * Library types (09 §5, §6.2, §9, §10). Wire types shared with the renderer live in the preload
 * contract and are re-exported here, never redefined.
 */
import type {
  CatalogEntry,
  DocHistoryState,
  FolderId,
  LibraryFolder,
  LibraryInfo,
  LibraryLocation,
  LibraryMoveReceipt,
  LibraryOrganization,
  MenuAction,
  MergeSuggestion,
  MergeSuggestionStatus,
  PublicationRecord,
  SectionId,
  TrashItem,
} from '../../preload/contract';
import type { Edition } from '../editions';
import type { SkippedSource } from '../sources';
import type { JobWarning } from '../pipeline';

export type {
  CatalogEntry,
  DocHistoryState,
  FolderId,
  LibraryFolder,
  LibraryInfo,
  LibraryLocation,
  LibraryMoveReceipt,
  LibraryOrganization,
  TrashItem,
  MenuAction,
  MergeSuggestion,
  MergeSuggestionStatus,
  PublicationRecord,
  SectionId,
};

/** catalog.json (09 §5.1). */
export interface CatalogFile {
  schemaVersion: number;
  /** App version that last wrote the file (diagnostics only). */
  appVersion: string;
  updatedAt: string;
  /** Stored newest-first by createdAt; readers must not rely on order. */
  entries: CatalogEntry[];
}

/** Section-action log entry; shape owned by 08 §6.6. Stores no content. */
export interface ActionRecord {
  at: string;
  action: MenuAction;
  sectionId: SectionId;
  tabKey: string;
  note?: string;
  jobId: string;
  /** Set for 'eli5-tab'. */
  resultTabKey?: string;
}

/** 09 §5.2. Local paths are basenames only; URLs have no fragment. */
export interface SourceRecord {
  ref: string;
  kind: 'file' | 'clipboard' | 'url' | 'mcp';
  mimeType?: string;
  sha256?: string;
  /** e.g. 'merge:<sourceDocId>' when it arrived via a merge. */
  origin?: string;
}

/** 09 §5.2; kind mirrors 07 Tab['kind'], sourceSectionId/createdAt owned by 08 §6.6. */
export interface TabRecord {
  /** 'indepth', 'eli5', or 'sx' + 6 hex (07 §4.1). */
  key: string;
  kind: 'indepth' | 'eli5' | 'section-eli5';
  label: string;
  sectionCount: number;
  sourceSectionId?: SectionId;
  createdAt: string;
}

/** 09 §5.2, §10.6 step 7. */
export interface MergeRecord {
  suggestionId: string;
  sourceDocId: string;
  sourceTitle: string;
  sourceSlug: string;
  sourceSummary: string;
  mergedAt: string;
  /** Marker sections inserted by the merge (09 §10.3). */
  anchorSectionIds: SectionId[];
}

/** meta.json (09 §5.2). Non-strict on read: unknown fields are preserved. */
export interface DocumentMeta {
  schemaVersion: number;
  id: string;
  topicSlug: string;
  title: string;
  summary: string;
  summarySource: 'llm' | 'fallback';
  createdAt: string;
  updatedAt: string;
  jobId: string;
  edition: Edition;
  clarifyingInput: string;
  glossaryEnabled: boolean;
  sourcesUsed: SourceRecord[];
  sourcesSkipped: SkippedSource[];
  tabs: TabRecord[];
  retiredIds: SectionId[];
  generation: { provider: string; model: string; prompts: string[] };
  warnings: JobWarning[];
  merges: MergeRecord[];
  actions?: ActionRecord[];
  publications: PublicationRecord[];
}

/** One `.trash/` entry's record in `.eli5/organization.json` (09 §4.2). */
export interface TrashRecord {
  docId: string;
  trashedAt: string;
  reason: 'trashed' | 'merged';
  from: Exclude<LibraryLocation, 'trash'>;
  fromName?: string;
  mergedInto?: string;
}

/**
 * `.eli5/organization.json` (09 §4.2): folders, where each document is filed, and what the Trash
 * holds. Keyed by document id, so a catalog rebuild never touches it. Missing file: all unfiled.
 */
export interface OrganizationFile {
  schemaVersion: number;
  folders: LibraryFolder[];
  /** Document id -> 'archive' or a folder id; absent means unfiled. */
  placement: Record<string, 'archive' | FolderId>;
  /** Trash id (the `.trash/` folder name) -> record. */
  trashed: Record<string, TrashRecord>;
}

/** .eli5/suggestions.json (09 §10.5). */
export interface SuggestionsFile {
  schemaVersion: 1;
  suggestions: MergeSuggestion[];
  /** Doc IDs with a < b (sorted string order). */
  dismissedPairs: { a: string; b: string; at: string }[];
}

/** 09 §6.2. */
export interface SlugReservation {
  slug: string;
  release(): void;
}

/** Input to resolveLibraryRoot (09 §3.1). */
export interface LibraryRootInput {
  isPackaged: boolean;
  /** Project root in dev (app.getAppPath() resolved by electron-vite). */
  repoRoot: string;
  /** app.getPath('userData'). */
  userData: string;
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * HOOK-LIB-01 · Enterprise library storage policy (09 §3). The public default resolves the root
 * per §3.1, stores plain files, keeps trash and resolved suggestions 30 days, and records source
 * URLs in full (minus fragment, 09 §5.2).
 */
export interface LibraryPolicy {
  /** May pin or restrict the root; must return an absolute path. */
  resolveRoot(input: LibraryRootInput): string;
  /** `.trash/` retention (09 §7 step 8). */
  trashRetentionDays: number;
  /** Pruning of accepted/dismissed/stale suggestions (09 §10.5). */
  resolvedSuggestionRetentionDays: number;
  /** Whether meta.json may record source URLs ('full') or only redacted forms. */
  sourceUrls: 'full' | 'redacted';
}

/** HOOK-LIB-02 · Merge eligibility predicate (09 §10.2). Public build: `() => true`. */
export type MergeEligibility = (a: DocumentMeta, b: DocumentMeta) => boolean;

/**
 * An in-place change to an existing document (09 §9). With `html`, the library first keeps the
 * current files as the document's single prior version (09 §4.1); `label` names the change for
 * the Undo tooltip, e.g. "re-explained 'Pricing'" (default "last change").
 */
export interface DocumentPatch {
  html?: string;
  meta: (m: DocumentMeta) => DocumentMeta;
  label?: string;
}

/** `.prev/state.json` (09 §4.1). */
export interface PriorVersionState {
  schemaVersion: 1;
  /** 'undo': the slot holds the older version; 'redo': it holds the newer one after an undo. */
  slot: 'undo' | 'redo';
  /** The change between the two versions. */
  label: string;
  /** `updatedAt` of the live meta.json this slot pairs with; any other live meta voids the slot. */
  pairedUpdatedAt: string;
}

/** 09 §9. */
export type LibraryChangeReason = 'created' | 'updated' | 'removed' | 'merged' | 'reconciled' | 'restored';

/** Library facade (09 §9). Implemented in M1. */
export interface Library {
  readonly root: string;
  readonly readOnly: boolean;
  list(): CatalogEntry[];
  recents(n?: number): CatalogEntry[];
  getEntry(idOrSlug: string): CatalogEntry | undefined;
  getMeta(slug: string): Promise<DocumentMeta>;
  docPath(slug: string, file?: 'index.html' | 'meta.json'): string;
  allocateSlug(title: string, hint?: string): Promise<SlugReservation>;
  commitDocument(r: SlugReservation, stagingDir: string, meta: DocumentMeta): Promise<CatalogEntry>;
  updateDocument(slug: string, patch: DocumentPatch): Promise<CatalogEntry>;
  touch(slug: string): Promise<CatalogEntry>;
  /** One-level undo/redo (09 §4.1). `history` never includes `busy`; 08 adds it. */
  history(slug: string): Promise<DocHistoryState>;
  undo(slug: string): Promise<DocHistoryState>;
  redo(slug: string): Promise<DocHistoryState>;
  withDocLock<T>(slug: string, fn: () => Promise<T>): Promise<T>;
  withDocLocks<T>(slugs: string[], fn: () => Promise<T>): Promise<T>;
  reconcile(): Promise<void>;
  runMergeCheck(docId: string): Promise<MergeSuggestion | null>;
  suggestions(): MergeSuggestion[];
  acceptSuggestion(id: string): Promise<{ targetSlug: string }>;
  dismissSuggestion(id: string): Promise<void>;
  /** Folders, Archive and Trash (09 §4.2). */
  organization(): Promise<LibraryOrganization>;
  folders(): LibraryFolder[];
  locationOf(docId: string): Exclude<LibraryLocation, 'trash'>;
  createFolder(name: string): Promise<LibraryFolder>;
  renameFolder(id: string, name: string): Promise<LibraryFolder>;
  deleteFolder(id: string): Promise<{ trashed: number }>;
  moveDocument(slug: string, to: LibraryLocation, opts?: { undo?: boolean }): Promise<LibraryMoveReceipt>;
  putBack(trashId: string): Promise<{ slug: string }>;
  deletePermanently(trashId: string): Promise<void>;
  emptyTrash(): Promise<{ deleted: number }>;
  on(event: 'changed', cb: (e: { reason: LibraryChangeReason; slugs: string[] }) => void): () => void;
  on(event: 'suggestions', cb: (s: MergeSuggestion[]) => void): () => void;
  /** Folders, placement or Trash changed (09 §4.2). */
  on(event: 'organization', cb: () => void): () => void;
  /** A document was moved (09 §4.2); the app shows an Undo toast (11 §5.2). */
  on(event: 'moved', cb: (r: LibraryMoveReceipt) => void): () => void;
}

/** 09 §9. */
export type LibraryErrorCode =
  | 'WRITE_FAILED'
  | 'SLUG_TAKEN'
  | 'NOT_FOUND'
  | 'META_INVALID'
  | 'LIBRARY_READ_ONLY'
  | 'LOCK_REENTRY'
  | 'LOCK_NOT_HELD'
  | 'SUGGESTION_STALE'
  | 'MERGE_FAILED'
  | 'PATH_OUTSIDE_ROOT'
  | 'HISTORY_EMPTY'
  | 'FOLDER_NOT_FOUND'
  | 'FOLDER_NAME_INVALID'
  | 'FOLDER_NAME_TAKEN'
  | 'TRASH_ITEM_NOT_FOUND';

export class LibraryError extends Error {
  readonly code: LibraryErrorCode;
  readonly detail: object | undefined;
  constructor(code: LibraryErrorCode, detail?: object) {
    super(code);
    this.name = 'LibraryError';
    this.code = code;
    this.detail = detail;
  }
}

/** Injected time source (13 §3.2: constructor-injected; FakeClock in tests). */
export interface LibraryClock {
  now(): Date;
}

/** Injected randomness; structurally the document module's IdSource (SeededIdSource in tests). */
export interface LibraryIdSource {
  /** Exactly `chars` lowercase hex characters. */
  hex(chars: number): string;
}

/** Why the library refuses writes (09 §8.5). */
export type ReadOnlyReason = 'locked' | 'newer-schema';

/** Probes used by the process lock's staleness check (09 §8.4). Injected in tests. */
export interface ProcessProbe {
  /** `process.kill(pid, 0)` succeeds or fails with EPERM. */
  isAlive(pid: number): boolean;
  /** Actual start time (`ps -o lstart=`), or undefined when it cannot be read. */
  startTime(pid: number): Promise<Date | undefined>;
  /** Executable name (`ps -o comm=`), or undefined when it cannot be read. */
  command(pid: number): Promise<string | undefined>;
}
