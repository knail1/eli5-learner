import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobSnapshot, JobStatus } from '../../../preload/contract';
import { useAnnounce } from '../a11y/Announcer';
import { jobGlyph, settingsLinkParts, sortJobs, upsertJob } from './jobs';

/**
 * Status area (11 §5.5): one pipeline-supplied line per job, newest at the bottom. The shell never
 * composes status text. Empty shows nothing but keeps its column.
 */

export interface StatusAreaProps {
  onOpenDoc(slug: string): void;
  onOpenSettings(): void;
}

export function StatusArea(p: StatusAreaProps) {
  const announce = useAnnounce();
  const [jobs, setJobs] = useState<JobSnapshot[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const seen = useRef(new Map<string, JobStatus>());

  const refetch = useCallback(async () => {
    const r = await window.eli5.jobs.list();
    if (!r.ok) return; // M2 owns the handler; until then the area stays blank.
    for (const j of r.value) seen.current.set(j.id, j.status);
    setJobs(sortJobs(r.value));
  }, []);

  useEffect(() => {
    void refetch();
    return window.eli5.jobs.onChanged((s) => {
      const prev = seen.current.get(s.id);
      seen.current.set(s.id, s.status);
      // Announce terminal transitions only; intermediate stages would be chatter (11 §12).
      if (prev !== s.status && s.status === 'done') announce(`Done: ${s.result?.title ?? s.statusLine}`);
      if (prev !== s.status && s.status === 'failed') announce(s.statusLine, 'assertive');
      setJobs((list) => upsertJob(list, s));
    });
  }, [announce, refetch]);

  const act = async (job: JobSnapshot, action: 'cancel' | 'retry' | 'dismiss') => {
    const r = await window.eli5.jobs[action](job.id);
    if (!r.ok) {
      setErrors((e) => ({ ...e, [job.id]: r.error.message }));
      return;
    }
    setErrors(({ [job.id]: _drop, ...rest }) => rest);
    if (action === 'dismiss') setJobs((list) => list.filter((j) => j.id !== job.id));
  };

  return (
    <section className="status-area" aria-label="Jobs">
      {jobs.length > 0 && (
        <ul className="job-lines">
          {jobs.map((j) => (
            <JobLine
              key={j.id}
              job={j}
              error={errors[j.id]}
              onAct={(a) => void act(j, a)}
              onOpenDoc={p.onOpenDoc}
              onOpenSettings={p.onOpenSettings}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function JobLine(p: {
  job: JobSnapshot;
  error: string | undefined;
  onAct(a: 'cancel' | 'retry' | 'dismiss'): void;
  onOpenDoc(slug: string): void;
  onOpenSettings(): void;
}) {
  const j = p.job;
  const glyph = jobGlyph(j.status);
  const slug = j.status === 'done' ? j.result?.topicSlug : undefined;
  const parts = j.status === 'failed' ? settingsLinkParts(j.statusLine) : null;

  let text;
  if (slug) {
    text = (
      <button type="button" className="link job-text" onClick={() => p.onOpenDoc(slug)}>
        {j.statusLine}
      </button>
    );
  } else if (parts) {
    text = (
      <span className="job-text">
        {parts[0]}
        <button type="button" className="link" onClick={p.onOpenSettings}>
          Settings
        </button>
        {parts[1]}
      </span>
    );
  } else {
    text = <span className="job-text">{j.statusLine}</span>;
  }

  return (
    <li className={`job-line job-${j.status}`} data-status={j.status}>
      <span className={`glyph glyph-${glyph}`} aria-hidden="true">
        {glyph === 'check' ? '✓' : glyph === 'cross' ? '✕' : ''}
      </span>
      {text}
      <span className="job-actions">
        {j.canCancel && (
          <button type="button" onClick={() => p.onAct('cancel')}>
            Cancel
          </button>
        )}
        {j.canRetry && (
          <button type="button" onClick={() => p.onAct('retry')}>
            Retry
          </button>
        )}
        {j.canDismiss && (
          <button type="button" onClick={() => p.onAct('dismiss')}>
            Dismiss
          </button>
        )}
      </span>
      {p.error && <span className="inline-error">{p.error}</span>}
    </li>
  );
}
