import { useEffect, useState } from 'react';
import type { LibraryInfo } from '../../../../preload/contract';
import { SettingsSectionFrame, useAction, type SectionProps } from '../save';

/**
 * Settings > Library: location (read only), document count, read-only reason, and Reveal in
 * Finder (`eli5:library:reveal-root`) (11 §7, 09 §11).
 */
export function LibrarySection(_p: SectionProps) {
  return (
    <SettingsSectionFrame id="library" title="Library">
      <LibraryInfoPanel />
    </SettingsSectionFrame>
  );
}

function LibraryInfoPanel() {
  const [info, setInfo] = useState<LibraryInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reveal = useAction();
  useEffect(() => {
    let live = true;
    void window.eli5.library.info().then((r) => {
      if (!live) return;
      if (r.ok) setInfo(r.value);
      else setError(r.error.message);
    });
    return () => {
      live = false;
    };
  }, []);
  if (error) return <p className="muted">Library details are not available: {error}</p>;
  if (!info) return null;
  return (
    <>
      <p>
        <span className="field-label">Location</span> <code className="path">{info.root}</code>
      </p>
      <p>
        {info.count} {info.count === 1 ? 'document' : 'documents'}
      </p>
      {info.readOnly && (
        <p className="inline-error">Read only{info.readOnlyReason ? `: ${info.readOnlyReason}` : ''}</p>
      )}
      <div className="row">
        <button
          type="button"
          disabled={reveal.busy}
          onClick={() => void reveal.run(() => window.eli5.library.revealRoot())}
        >
          Reveal in Finder
        </button>
        {reveal.error && <span className="inline-error">{reveal.error}</span>}
      </div>
    </>
  );
}
