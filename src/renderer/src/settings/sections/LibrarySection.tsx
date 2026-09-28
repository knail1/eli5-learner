import { useEffect, useState } from 'react';
import type { LibraryInfo } from '../../../../preload/contract';
import { SettingsSectionFrame, type SectionProps } from '../save';

/** Settings > Library: location, count, read-only reason (11 §7, 09 §11). */
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
  useEffect(() => {
    void window.eli5.library.info().then((r) => {
      if (r.ok) setInfo(r.value);
      else setError(r.error.message);
    });
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
    </>
  );
}
