import { useCallback, useEffect, useRef, useState, type Ref } from 'react';
import type {
  CatalogEntry,
  IpcResult,
  LibraryFolder,
  LibraryLocation,
  LibraryMoveReceipt,
  LibraryOrganization,
} from '../../../preload/contract';
import { useAnnounce } from '../a11y/Announcer';
import { isTextEntry, libraryUndoWins, matchHistoryKey } from '../a11y/shortcuts';
import { DocRow } from './DocRow';
import { ARCHIVE_KEY, groupLibrary, moveMessage, placeOf } from './organize';
import type { SwipeSide } from './swipe';

/**
 * Library sidebar (11 §5.2): unfiled documents newest first, then folders (one level, collapsible,
 * renamable), the built-in Archive, and the Trash row at the bottom. Filter, empty and error
 * states, native context menu, swipe to Archive or Trash, drag onto a folder, and an Undo toast.
 */

export interface LibrarySidebarProps {
  /** Already in Library order; null while loading. */
  entries: CatalogEntry[] | null;
  organization: LibraryOrganization;
  error: string | null;
  selectedSlug: string | null;
  /** The Trash view is showing (the Trash row is the current item). */
  trashSelected?: boolean;
  onOpen(slug: string): void;
  onOpenTrash(): void;
  onRetry(): void;
  filterRef?: Ref<HTMLInputElement>;
}

/** How long the "Moved to … · Undo" toast stays (11 §5.2). */
export const TOAST_MS = 5000;
const EXPANDED_KEY = 'eli5.libraryExpanded';

interface Toast {
  seq: number;
  message: string;
  /** The move Undo reverses; absent for toasts without Undo. */
  receipt?: LibraryMoveReceipt;
}

function readExpanded(): Set<string> {
  try {
    const v = JSON.parse(window.localStorage.getItem(EXPANDED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeExpanded(s: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...s]));
  } catch {
    // per-viewer convenience only
  }
}

const dropTargetAt = (x: number, y: number): string | null =>
  (document.elementFromPoint?.(x, y) as Element | null)?.closest('[data-drop]')?.getAttribute('data-drop') ?? null;

export function LibrarySidebar(p: LibrarySidebarProps) {
  const announce = useAnnounce();
  const navRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState('');
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  // Inline message next to the row (or folder) whose action failed (11 §13).
  const [rowError, setRowError] = useState<{ key: string; message: string } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(readExpanded);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [swipeOpen, setSwipeOpen] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ slug: string; title: string; x: number; y: number; over: string | null } | null>(
    null,
  );
  const [toast, setToast] = useState<Toast | null>(null);
  const [lastMove, setLastMove] = useState<LibraryMoveReceipt | null>(null);
  const toastSeq = useRef(0);
  const orgRef = useRef(p.organization);
  orgRef.current = p.organization;
  const lastMoveRef = useRef(lastMove);
  lastMoveRef.current = lastMove;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // A newly finished document slides in with a brief highlight; it never steals the selection.
  useEffect(() => {
    if (!p.entries) return;
    const ids = new Set(p.entries.map((e) => e.id));
    if (known.current) {
      const added = [...ids].filter((id) => !known.current?.has(id));
      if (added.length) setFresh(new Set(added));
    }
    known.current = ids;
  }, [p.entries]);

  const setOpen = useCallback((key: string, open: boolean) => {
    setExpanded((cur) => {
      if (cur.has(key) === open) return cur;
      const next = new Set(cur);
      if (open) next.add(key);
      else next.delete(key);
      writeExpanded(next);
      return next;
    });
  }, []);

  // ---- toast and undo (11 §5.2, §9) ----
  const showToast = useCallback(
    (message: string, receipt?: LibraryMoveReceipt) => {
      const seq = ++toastSeq.current;
      setToast({ seq, message, ...(receipt ? { receipt } : {}) });
      announce(message);
    },
    [announce],
  );
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast((cur) => (cur?.seq === toast.seq ? null : cur)), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  // Every move reaches here, including the native item menu's (main performs those).
  useEffect(
    () =>
      window.eli5.library.onMoved((r) => {
        if (r.undo) return;
        setLastMove(r);
        showToast(moveMessage(r, orgRef.current), r);
      }),
    [showToast],
  );

  const undo = useCallback(async () => {
    const r = lastMoveRef.current;
    if (!r) return;
    setLastMove(null);
    setToast(null);
    const res: IpcResult<unknown> =
      r.to === 'trash' && r.trashId
        ? await window.eli5.library.putBack(r.trashId)
        : await window.eli5.library.move(r.slug, r.from, { undo: true });
    if (!res.ok) setRowError({ key: r.slug, message: res.error.message });
    else announce(`Undid: ${moveMessage(r, orgRef.current)}`);
  }, [announce]);

  // Cmd+Z outside text fields: a pending Undo toast (or focus in the Library with a move to undo)
  // takes it before the document's undo, which skips events already prevented (11 §9).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || matchHistoryKey(e) !== 'undo') return;
      if (isTextEntry(e.target instanceof Element ? e.target : document.activeElement)) return;
      const wins = libraryUndoWins({
        toastPending: !!toastRef.current?.receipt,
        focusInSidebar: !!navRef.current?.contains(document.activeElement),
        hasLastMove: !!lastMoveRef.current,
      });
      if (!wins) return;
      e.preventDefault();
      void undo();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [undo]);

  // ---- actions ----
  const move = useCallback(async (slug: string, to: LibraryLocation): Promise<boolean> => {
    setRowError(null);
    const r = await window.eli5.library.move(slug, to);
    if (!r.ok) setRowError({ key: slug, message: r.error.message });
    return r.ok;
  }, []);

  const contextMenu = (slug: string) => {
    setRowError(null);
    void window.eli5.app.contextMenu({ kind: 'library-item', slug }).then((r) => {
      if (!r.ok) setRowError({ key: slug, message: r.error.message });
    });
  };

  const createFolder = async (name: string): Promise<boolean> => {
    const r = await window.eli5.library.createFolder(name);
    if (!r.ok) {
      setRowError({ key: 'new-folder', message: r.error.message });
      return false;
    }
    setRowError(null);
    setCreating(false);
    setOpen(r.value.id, true);
    announce(`Folder “${r.value.name}” created`);
    return true;
  };

  const renameFolder = async (f: LibraryFolder, name: string): Promise<boolean> => {
    if (name.trim() === f.name) {
      setRenaming(null);
      return true;
    }
    const r = await window.eli5.library.renameFolder(f.id, name);
    if (!r.ok) {
      setRowError({ key: f.id, message: r.error.message });
      return false;
    }
    setRowError(null);
    setRenaming(null);
    return true;
  };

  const deleteFolder = async (f: LibraryFolder) => {
    const r = await window.eli5.library.deleteFolder(f.id);
    if (!r.ok) {
      setRowError({ key: f.id, message: r.error.message });
      return;
    }
    setOpen(f.id, false);
    const n = r.value.trashed;
    showToast(n === 0 ? `Deleted folder “${f.name}”` : `Deleted folder “${f.name}” · ${n} moved to Trash`);
  };

  // ---- drag a row onto a folder, the Archive, the Trash or the unfiled list ----
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const dragHandlers = (e: CatalogEntry) => ({
    onDragStart: () => {
      setSwipeOpen(null);
      setDrag({ slug: e.topicSlug, title: e.title, x: -1000, y: -1000, over: null });
    },
    onDragMove: (x: number, y: number) => setDrag((d) => (d ? { ...d, x, y, over: dropTargetAt(x, y) } : d)),
    onDragEnd: (drop: boolean) => {
      const d = dragRef.current;
      setDrag(null);
      if (!drop || !d?.over) return;
      const to = d.over as LibraryLocation;
      if (to !== 'trash' && placeOf(orgRef.current, e.id) === to) return;
      void move(d.slug, to);
    },
  });

  const groups = p.entries ? groupLibrary(p.entries, p.organization, query, expanded) : null;
  const dropCls = (key: string) => (drag?.over === key ? ' drop-over' : '');

  const row = (e: CatalogEntry) => (
    <DocRow
      key={e.id}
      entry={e}
      selected={p.selectedSlug === e.topicSlug}
      fresh={fresh.has(e.id)}
      swipeOpen={swipeOpen === e.topicSlug}
      onSwipeOpen={(open) => setSwipeOpen((cur) => (open ? e.topicSlug : cur === e.topicSlug ? null : cur))}
      onOpen={() => p.onOpen(e.topicSlug)}
      onContextMenu={() => contextMenu(e.topicSlug)}
      onAction={(side: SwipeSide) => move(e.topicSlug, side)}
      {...dragHandlers(e)}
      {...(rowError?.key === e.topicSlug ? { error: rowError.message } : {})}
    />
  );

  const trashCount = p.organization.trash.length;
  const libraryEmpty = p.entries !== null && p.entries.length === 0 && p.organization.folders.length === 0;

  return (
    <nav ref={navRef} className={`library${drag ? ' dragging' : ''}`} aria-label="Library">
      <div className="library-head">
        <h2 className="region-title">Library</h2>
        <button
          type="button"
          className="new-folder"
          aria-label="New folder"
          title="New folder"
          onClick={() => {
            setRowError(null);
            setCreating(true);
          }}
        >
          <span aria-hidden="true">+</span> New folder
        </button>
      </div>
      <input
        ref={p.filterRef}
        className="filter"
        type="search"
        aria-label="Filter library"
        placeholder="Filter"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query) {
            e.preventDefault();
            e.stopPropagation();
            setQuery('');
          }
        }}
      />
      <div className="library-scroll">
        {creating && (
          <NameField
            label="New folder name"
            initial=""
            onSubmit={createFolder}
            onCancel={() => {
              setCreating(false);
              setRowError(null);
            }}
            {...(rowError?.key === 'new-folder' ? { error: rowError.message } : {})}
          />
        )}
        {p.error ? (
          <div className="empty">
            <p>Could not load the Library</p>
            <button type="button" onClick={p.onRetry}>
              Retry
            </button>
          </div>
        ) : libraryEmpty ? (
          <p className="empty">Your finished documents will appear here</p>
        ) : groups && query && groups.matches === 0 ? (
          <div className="empty">
            <p>No documents match &lsquo;{query}&rsquo;</p>
            <button type="button" onClick={() => setQuery('')}>
              Clear
            </button>
          </div>
        ) : (
          groups && (
            <>
              <ul className={`library-list unfiled${dropCls('unfiled')}`} data-drop="unfiled" aria-label="Documents">
                {groups.unfiled.map(row)}
                {drag && groups.unfiled.length === 0 && (
                  <li className="drop-hint" aria-hidden="true">
                    Drop here to remove from its folder
                  </li>
                )}
              </ul>
              {groups.folders.map((g) => {
                const f = g.folder;
                return (
                  <section key={f.id} className="folder" aria-label={`Folder ${f.name}`}>
                    {renaming === f.id ? (
                      <NameField
                        label={`Rename folder ${f.name}`}
                        initial={f.name}
                        onSubmit={(name) => renameFolder(f, name)}
                        onCancel={() => {
                          setRenaming(null);
                          setRowError(null);
                        }}
                        {...(rowError?.key === f.id ? { error: rowError.message } : {})}
                      />
                    ) : (
                      <div className={`folder-head${dropCls(f.id)}`} data-drop={f.id}>
                        <button
                          type="button"
                          className="folder-toggle"
                          aria-expanded={g.open}
                          onClick={() => setOpen(f.id, !g.open)}
                          onDoubleClick={() => setRenaming(f.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'F2') {
                              e.preventDefault();
                              setRenaming(f.id);
                            }
                          }}
                        >
                          <span className="chevron" aria-hidden="true">
                            ▸
                          </span>
                          <span className="folder-name">{f.name}</span>
                          <span className="count">{g.entries.length}</span>
                        </button>
                        {/* Over the count on hover or focus, so every count lines up with Archive and Trash. */}
                        <span className="folder-actions">
                          <button
                            type="button"
                            className="folder-action"
                            aria-label={`Rename folder ${f.name}`}
                            title="Rename folder"
                            onClick={() => setRenaming(f.id)}
                          >
                            <span aria-hidden="true">✎</span>
                          </button>
                          <button
                            type="button"
                            className="folder-action"
                            aria-label={`Delete folder ${f.name}`}
                            title="Delete folder (its documents go to the Trash)"
                            onClick={() => void deleteFolder(f)}
                          >
                            <span aria-hidden="true">×</span>
                          </button>
                        </span>
                      </div>
                    )}
                    {rowError?.key === f.id && renaming !== f.id && (
                      <p className="inline-error" role="status">
                        {rowError.message}
                      </p>
                    )}
                    {g.open && (
                      <ul className="library-list in-folder" aria-label={f.name}>
                        {g.entries.length === 0 ? <li className="empty folder-empty">Empty</li> : g.entries.map(row)}
                      </ul>
                    )}
                  </section>
                );
              })}
              {groups.archive.shown && (
                <section className="folder system" aria-label="Archive">
                  <div className={`folder-head${dropCls(ARCHIVE_KEY)}`} data-drop={ARCHIVE_KEY}>
                    <button
                      type="button"
                      className="folder-toggle"
                      aria-expanded={groups.archive.open}
                      onClick={() => setOpen(ARCHIVE_KEY, !groups.archive.open)}
                    >
                      <span className="chevron" aria-hidden="true">
                        ▸
                      </span>
                      <span className="folder-name">Archive</span>
                      <span className="count">{groups.archive.entries.length}</span>
                    </button>
                  </div>
                  {groups.archive.open && (
                    <ul className="library-list in-folder" aria-label="Archive">
                      {groups.archive.entries.length === 0 ? (
                        <li className="empty folder-empty">Swipe a document left to archive it</li>
                      ) : (
                        groups.archive.entries.map(row)
                      )}
                    </ul>
                  )}
                </section>
              )}
            </>
          )
        )}
      </div>
      <button
        type="button"
        className={`trash-row${dropCls('trash')}`}
        data-drop="trash"
        aria-current={p.trashSelected ? 'page' : undefined}
        onClick={p.onOpenTrash}
      >
        <span className="folder-name">Trash</span>
        <span className="count">{trashCount}</span>
      </button>
      {toast && (
        <div className="toast" role="status">
          <span>{toast.message}</span>
          {toast.receipt && (
            <button type="button" className="link" onClick={() => void undo()}>
              Undo
            </button>
          )}
        </div>
      )}
      {drag && (
        <div className="drag-ghost" aria-hidden="true" style={{ left: drag.x + 12, top: drag.y + 8 }}>
          {drag.title}
        </div>
      )}
    </nav>
  );
}

/** Inline folder name field: Enter saves, Escape cancels, leaving it saves a changed name. */
function NameField(p: {
  label: string;
  initial: string;
  onSubmit(name: string): Promise<boolean>;
  onCancel(): void;
  error?: string;
}) {
  const [value, setValue] = useState(p.initial);
  const busy = useRef(false);
  const submit = async () => {
    if (busy.current) return;
    if (!value.trim()) {
      p.onCancel();
      return;
    }
    busy.current = true;
    try {
      await p.onSubmit(value);
    } finally {
      busy.current = false;
    }
  };
  return (
    <div className="name-field">
      <input
        type="text"
        aria-label={p.label}
        placeholder="Folder name"
        maxLength={60}
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            p.onCancel();
          }
        }}
        onBlur={() => {
          if (value.trim() && value.trim() !== p.initial) void submit();
          else p.onCancel();
        }}
      />
      {p.error && (
        <p className="inline-error" role="status">
          {p.error}
        </p>
      )}
    </div>
  );
}
