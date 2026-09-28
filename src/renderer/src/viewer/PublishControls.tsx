import { useEffect, useRef, useState } from 'react';
import type { PublishResult, PublishTarget, UiFeature } from '../../../preload/contract';
import { useEdition } from '../edition/FeatureGate';

/**
 * Publish slot in the document header (11 §5.3, §11; 10 §7). The public slot holds only Export
 * copy for the `local` target; drive and git targets are mounted only when HOOK-UI-01 enables
 * their UiFeature. Owned by the publishing slice (result chip, history, progress, errors).
 */

const FEATURE_FOR: Record<PublishTarget['kind'], UiFeature | null> = {
  local: null,
  drive: 'publish.drive',
  git: 'publish.git',
};

export function PublishControls(p: { slug: string }) {
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

  const primary = result?.links.find((l) => l.primary) ?? result?.links[0];

  return (
    <>
      {visible.length > 0 && (
        <div className="doc-actions publish-controls">
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
      )}
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
    </>
  );
}
