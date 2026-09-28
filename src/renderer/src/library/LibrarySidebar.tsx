import { useEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import type { CatalogEntry } from '../../../preload/contract';
import { filterCatalog, relativeDate } from './order';

/** Library sidebar (11 §5.2): newest first, filter, empty and error states, native context menu. */

export interface LibrarySidebarProps {
  /** Already in Library order; null while loading. */
  entries: CatalogEntry[] | null;
  error: string | null;
  selectedSlug: string | null;
  onOpen(slug: string): void;
  onRetry(): void;
  filterRef?: Ref<HTMLInputElement>;
}

export function LibrarySidebar(p: LibrarySidebarProps) {
  const [query, setQuery] = useState('');
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  // Inline message next to the item whose context menu failed (11 §13).
  const [menuError, setMenuError] = useState<{ slug: string; message: string } | null>(null);

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

  const shown = p.entries ? filterCatalog(p.entries, query) : [];

  const contextMenu = (slug: string) => {
    setMenuError(null);
    void window.eli5.app.contextMenu({ kind: 'library-item', slug }).then((r) => {
      if (!r.ok) setMenuError({ slug, message: r.error.message });
    });
  };

  const onItemKey = (e: KeyboardEvent, slug: string) => {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      contextMenu(slug);
    }
  };

  return (
    <nav className="library" aria-label="Library">
      <h2 className="region-title">Library</h2>
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
      {p.error ? (
        <div className="empty">
          <p>Could not load the Library</p>
          <button type="button" onClick={p.onRetry}>
            Retry
          </button>
        </div>
      ) : p.entries && p.entries.length === 0 ? (
        <p className="empty">Your finished documents will appear here</p>
      ) : p.entries && shown.length === 0 ? (
        <div className="empty">
          <p>No documents match &lsquo;{query}&rsquo;</p>
          <button type="button" onClick={() => setQuery('')}>
            Clear
          </button>
        </div>
      ) : (
        <ul className="library-list">
          {shown.map((e) => (
            <li key={e.id} className={fresh.has(e.id) ? 'fresh' : undefined}>
              <button
                type="button"
                className="library-item"
                aria-current={p.selectedSlug === e.topicSlug ? 'page' : undefined}
                aria-description={e.summary || undefined}
                title={e.summary || undefined}
                onClick={() => p.onOpen(e.topicSlug)}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  contextMenu(e.topicSlug);
                }}
                onKeyDown={(ev) => onItemKey(ev, e.topicSlug)}
              >
                <span className="item-title">{e.title}</span>
                <span className="item-date">{relativeDate(e.createdAt)}</span>
              </button>
              {menuError?.slug === e.topicSlug && (
                <p className="inline-error" role="status">
                  {menuError.message}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
