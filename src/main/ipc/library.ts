import { z } from 'zod';
import {
  IPC,
  type CatalogEntry,
  type LibraryFolder,
  type LibraryInfo,
  type LibraryLocation,
  type LibraryMoveReceipt,
  type LibraryOrganization,
} from '../../preload/contract';
import { DOC_SCHEME, FOLDER_ID_RE, TRASH_ID_RE, isValidSlug, type LibraryChangeReason } from '../library';
import { log } from '../security';
import { NoPayload, fail, type Register } from './handle';
import { SlugPayload } from './schemas';

/** The library surface the handlers use (09 §9, §11, §4.2); FsLibrary satisfies it. */
export interface LibraryPort {
  list(): CatalogEntry[];
  info(): LibraryInfo;
  hasSlug(slug: string): boolean;
  organization(): Promise<LibraryOrganization>;
  createFolder(name: string): Promise<LibraryFolder>;
  renameFolder(id: string, name: string): Promise<LibraryFolder>;
  deleteFolder(id: string): Promise<{ trashed: number }>;
  moveDocument(slug: string, to: LibraryLocation, opts?: { undo?: boolean }): Promise<LibraryMoveReceipt>;
  putBack(trashId: string): Promise<{ slug: string }>;
  deletePermanently(trashId: string): Promise<void>;
  emptyTrash(): Promise<{ deleted: number }>;
  on(event: 'changed', cb: (e: { reason: LibraryChangeReason; slugs: string[] }) => void): () => void;
  on(event: 'organization', cb: () => void): () => void;
  on(event: 'moved', cb: (r: LibraryMoveReceipt) => void): () => void;
}

/** 09 §4.2 payloads. Name length and reserved names are the library's call (FOLDER_NAME_INVALID). */
const FolderName = z.string().max(200);
const FolderIdSchema = z
  .string()
  .regex(FOLDER_ID_RE)
  .transform((s) => s as `f-${string}`);
const Location = z.union([z.enum(['unfiled', 'archive', 'trash']), FolderIdSchema]);
const TrashId = z.string().max(300).regex(TRASH_ID_RE);
export const CreateFolderPayload = z.object({ name: FolderName });
export const RenameFolderPayload = z.object({ folderId: FolderIdSchema, name: FolderName });
export const FolderPayload = z.object({ folderId: FolderIdSchema });
export const MovePayload = z.object({ slug: SlugPayload.shape.slug, to: Location, undo: z.boolean().optional() });
export const TrashPayload = z.object({ trashId: TrashId });

/** Viewer and Finder actions, wired by bootstrap to the same shell hooks the Tray uses (11 §4.1). */
export interface DocumentActions {
  /** Loads `eli5doc://doc/<slug>/index.html` into the viewer (09 §11). */
  open(slug: string): void;
  /** Reveals the document folder in Finder (09 §11). */
  reveal(slug: string): void;
  /** Reveals the Library root folder in Finder (`eli5:library:reveal-root`, 11 §7). */
  revealRoot(): void;
}

/** The viewer URL of a catalogued document (01 §2.1, 12 §7.7). Throws on an invalid slug. */
export function docUrl(slug: string): string {
  if (!isValidSlug(slug)) throw new Error('Invalid slug');
  return `${DOC_SCHEME}://doc/${slug}/index.html`;
}

/**
 * Main-initiated viewer load; `loadURL` is not subject to the viewer's will-navigate guard
 * (12 §7.2 step 3). A load superseded by the next one rejects with ERR_ABORTED, which is expected.
 * An invalid slug (only possible from an unchecked caller) is ignored.
 */
export function openInViewer(wc: Pick<Electron.WebContents, 'loadURL'> | undefined, slug: string): void {
  if (!wc || !isValidSlug(slug)) return;
  const url = docUrl(slug);
  wc.loadURL(url).catch(() => log.info('viewer.load-failed', { slug }));
}

/** `eli5:library:*` invokes (09 §11). The `changed` event is wired by registerIpc. */
export function registerLibraryIpc(on: Register, d: { library: LibraryPort; documents: DocumentActions }): void {
  const known = (slug: string): void => {
    if (!d.library.hasSlug(slug)) fail('E_NOT_FOUND', 'Document not found');
  };
  on(IPC.library.list, NoPayload, (): CatalogEntry[] => d.library.list());
  on(IPC.library.info, NoPayload, (): LibraryInfo => d.library.info());
  on(IPC.library.open, SlugPayload, (p): void => {
    known(p.slug);
    d.documents.open(p.slug);
  });
  on(IPC.library.reveal, SlugPayload, (p): void => {
    known(p.slug);
    d.documents.reveal(p.slug);
  });
  on(IPC.library.revealRoot, NoPayload, (): void => d.documents.revealRoot());

  // ---- folders, Archive, Trash (09 §4.2): app window only ----
  on(IPC.library.organization, NoPayload, () => d.library.organization());
  on(IPC.library.createFolder, CreateFolderPayload, (p) => d.library.createFolder(p.name));
  on(IPC.library.renameFolder, RenameFolderPayload, (p) => d.library.renameFolder(p.folderId, p.name));
  on(IPC.library.deleteFolder, FolderPayload, (p) => d.library.deleteFolder(p.folderId));
  on(IPC.library.move, MovePayload, (p) => d.library.moveDocument(p.slug, p.to, { undo: p.undo === true }));
  on(IPC.library.putBack, TrashPayload, (p) => d.library.putBack(p.trashId));
  on(IPC.library.deletePermanently, TrashPayload, (p) => d.library.deletePermanently(p.trashId));
  on(IPC.library.emptyTrash, NoPayload, () => d.library.emptyTrash());
}

/**
 * `eli5:library:organization-changed` after any organization change or catalog change other than a
 * content update (a trash, a merge or a put back changes the Trash). Computing it reads `.trash/`, so overlapping pushes can finish
 * out of order; only the newest request is sent.
 */
export function subscribeOrganization(library: LibraryPort, send: (o: LibraryOrganization) => void): () => void {
  let seq = 0;
  const push = (): void => {
    const n = ++seq;
    library.organization().then(
      (o) => {
        if (n === seq) send(o);
      },
      (err: unknown) => log.warn('library.organization-push-failed', { kind: (err as Error)?.name ?? 'error' }),
    );
  };
  // A content update (a section action, an undo) never changes folders or the Trash.
  const subs = [
    library.on('organization', push),
    library.on('changed', (e) => {
      if (e.reason !== 'updated') push();
    }),
  ];
  return () => {
    for (const off of subs) off();
  };
}
