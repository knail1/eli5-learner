import { IPC, type CatalogEntry, type LibraryInfo } from '../../preload/contract';
import { DOC_SCHEME, isValidSlug, type LibraryChangeReason } from '../library';
import { log } from '../security';
import { NoPayload, fail, type Register } from './handle';
import { SlugPayload } from './schemas';

/** The library surface the handlers use (09 §9, §11); FsLibrary satisfies it. */
export interface LibraryPort {
  list(): CatalogEntry[];
  info(): LibraryInfo;
  hasSlug(slug: string): boolean;
  on(event: 'changed', cb: (e: { reason: LibraryChangeReason; slugs: string[] }) => void): () => void;
}

/** Viewer and Finder actions, wired by bootstrap to the same shell hooks the Tray uses (11 §4.1). */
export interface DocumentActions {
  /** Loads `eli5doc://doc/<slug>/index.html` into the viewer (09 §11). */
  open(slug: string): void;
  /** Reveals the document folder in Finder (09 §11). */
  reveal(slug: string): void;
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
}
