import { useEffect, useRef, useState } from 'react';
import type { CatalogEntry, PublishResult, PublishTarget, UiFeature } from '../../../preload/contract';
import { useEdition } from '../edition/FeatureGate';
import { updatedLabel } from '../library/order';

/**
 * Document header (11 §5.3): title, updated time, Reveal in Finder, and the publish slot. The
 * public slot holds only Export copy for the `local` target; drive and git targets are mounted
 * only when HOOK-UI-01 enables their UiFeature.
 */

const FEATURE_FOR: Record<PublishTarget['kind'], UiFeature | null> = {
  local: null,
  drive: 'publish.drive',
  git: 'publish.git',
};

export function DocHeader(p: { slug: string; entry: CatalogEntry | undefined }) {
  const edition = useEdition();
  const [targets, setTargets] = useState<PublishTarget[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The header stays mounted across documents; async results apply only to the slug that asked.
  const slugRef = useRef(p.slug);
  slugRef.current = p.slug;

  useEffect(() => {
    let live = true;
    setTargets([]);
    setResult(null);
    setError(null);
    void window.eli5.publish.targets(p.slug).then((r) => {
      if (live && r.ok) setTargets(r.value);
    });
    return () => {
      live = false;
    };
  }, [p.slug]);

  const visible = targets.filter((t) => {
    if (!t.available) return false;
    const f = FEATURE_FOR[t.kind];
    return f === null ? t.kind === 'local' : !!edition?.uiFeatures.includes(f);
  });

  const run = async (t: PublishTarget) => {
    const slug = p.slug;
    setBusy(t.id);
    setError(null);
    const r = await window.eli5.publish.run(slug, t.id);
    setBusy(null);
    if (slugRef.current !== slug) return;
    if (r.ok) setResult(r.value);
    else setError(r.error.message);
  };

  const reveal = async () => {
    const slug = p.slug;
    const r = await window.eli5.library.reveal(slug);
    if (slugRef.current !== slug) return;
    setError(r.ok ? null : r.error.message);
  };

  const primary = result?.links.find((l) => l.primary) ?? result?.links[0];

  return (
    <header className="doc-header">
      <div className="doc-title">
        <h1>{p.entry?.title ?? p.slug}</h1>
        {p.entry && <span className="muted">{updatedLabel(p.entry.updatedAt)}</span>}
      </div>
      <div className="doc-actions">
        <button type="button" onClick={() => void reveal()}>
          Reveal in Finder
        </button>
        {visible.map((t) => (
          <button
            key={t.id}
            type="button"
            disabled={busy !== null}
            onClick={() => void run(t)}
            aria-busy={busy === t.id}
          >
            {busy === t.id ? <span className="spinner" aria-hidden="true" /> : null}
            {t.kind === 'local' ? 'Export copy' : t.label}
          </button>
        ))}
      </div>
      {primary && (
        <div className="result-chip" role="group" aria-label="Export result">
          <span className="chip-link" title={primary.url}>
            {primary.label}
          </span>
          <button type="button" onClick={() => void window.eli5.publish.copyLink(primary.url)}>
            Copy link
          </button>
          <button type="button" onClick={() => void window.eli5.publish.openLink(primary.url)}>
            Open
          </button>
          {primary.kind === 'file' && (
            <button type="button" onClick={() => void window.eli5.publish.reveal(primary.url)}>
              Show in Finder
            </button>
          )}
        </div>
      )}
      {error && <p className="inline-error">{error}</p>}
    </header>
  );
}
