import { useEffect, useRef, useState } from 'react';
import type { CatalogEntry } from '../../../preload/contract';
import { updatedLabel } from '../library/order';
import { HistoryButtons } from './HistoryButtons';
import { PublishControls } from './PublishControls';

/**
 * Document header (11 §5.3): title, updated time, Undo / Redo, Reveal in Finder, and the publish slot
 * (PublishControls, owned by the publishing slice).
 */
export function DocHeader(p: { slug: string; entry: CatalogEntry | undefined }) {
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
        <button type="button" onClick={() => void reveal()}>
          Reveal in Finder
        </button>
      </div>
      <PublishControls slug={p.slug} />
      {error && <p className="inline-error">{error}</p>}
    </header>
  );
}
