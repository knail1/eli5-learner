import { useEffect, useRef, useState } from 'react';
import type { CatalogEntry } from '../../../preload/contract';
import { updatedLabel } from '../library/order';
import { HistoryButtons } from './HistoryButtons';
import { PublishControls } from './PublishControls';

/** The Versions toggle's state, owned by the shell (11 §5.3, §5.7). */
export interface VersionsToggle {
  open: boolean;
  /** Versions of the open document; the badge shows when there is more than one. */
  count: number;
  /** The window is too narrow for the panel: show the hint instead of opening it. */
  hint: boolean;
  onToggle(): void;
}

export const NARROW_VERSIONS_HINT = 'Widen the window or hide the library to show versions.';

/** A small branch glyph drawn with currentColor. */
function BranchIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" />
    </svg>
  );
}

/**
 * Document header (11 §5.3): title, updated time, Undo / Redo, the Versions toggle, Reveal in
 * Finder, and the publish slot (PublishControls, owned by the publishing slice).
 */
export function DocHeader(p: { slug: string; entry: CatalogEntry | undefined; versions?: VersionsToggle }) {
  const v = p.versions;
  const [error, setError] = useState<string | null>(null);
  const slugRef = useRef(p.slug);
  slugRef.current = p.slug;
  useEffect(() => setError(null), [p.slug]);

  const reveal = async () => {
    const slug = p.slug;
    const r = await window.eli5.library.reveal(slug);
    if (slugRef.current !== slug) return;
    setError(r.ok ? null : r.error.message);
  };

  return (
    <header className="doc-header">
      <div className="doc-title">
        <h1>{p.entry?.title ?? p.slug}</h1>
        {p.entry && <span className="muted">{updatedLabel(p.entry.updatedAt)}</span>}
      </div>
      <div className="doc-actions">
        <HistoryButtons slug={p.slug} />
        {v && (
          <button
            type="button"
            className="versions-toggle"
            aria-expanded={v.open}
            aria-controls="version-panel"
            aria-keyshortcuts="Meta+Y"
            onClick={v.onToggle}
          >
            <BranchIcon /> Versions
            {v.count > 1 && <span className="count-badge">{v.count}</span>}
          </button>
        )}
        <button type="button" onClick={() => void reveal()}>
          Reveal in Finder
        </button>
      </div>
      <PublishControls slug={p.slug} />
      {v?.hint && (
        <p className="inline-hint versions-hint" role="status">
          {NARROW_VERSIONS_HINT}
        </p>
      )}
      {error && <p className="inline-error">{error}</p>}
    </header>
  );
}
