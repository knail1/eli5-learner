import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobSnapshot, JobStatus } from '../../../preload/contract';
import { useAnnounce } from '../a11y/Announcer';
import { doneExpiry, dropExpired, jobGlyph, settingsLinkParts, sortJobs, upsertJob } from './jobs';

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
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const seen = useRef(new Map<string, JobStatus>());
  // Change events carry the newest state: a list answer never overrides a snapshot pushed after the
  // request went out, and an older list answer never overrides a newer one.
  const eventSeq = useRef(0);
  const lastEvent = useRef(new Map<string, { s: JobSnapshot; seq: number }>());
  const listSeq = useRef(0);
  const appliedList = useRef(0);

  const refetch = useCallback(async () => {
    const since = eventSeq.current;
    const mine = ++listSeq.current;
    const r = await window.eli5.jobs.list();
    if (!r.ok) return; // blank until the handler answers; change events still add lines
    if (mine < appliedList.current) return;
    appliedList.current = mine;
    const merged = new Map(r.value.map((j) => [j.id, j]));
    for (const e of lastEvent.current.values()) if (e.seq > since) merged.set(e.s.id, e.s);
    for (const j of merged.values()) seen.current.set(j.id, j.status);
    setJobs(sortJobs(dropExpired([...merged.values()], Date.now())));
  }, []);

  useEffect(() => {
    void refetch();
    return window.eli5.jobs.onChanged((s) => {
      const known = seen.current.has(s.id);
      const prev = seen.current.get(s.id);
      seen.current.set(s.id, s.status);
      lastEvent.current.set(s.id, { s, seq: ++eventSeq.current });
      // Announce terminal transitions only; intermediate stages would be chatter (11 §12).
      if (prev !== s.status && s.status === 'done') announce(`Done: ${s.result?.title ?? s.statusLine}`);
      if (prev !== s.status && s.status === 'failed') announce(s.statusLine, 'assertive');
      setJobs((list) => upsertJob(list, s));
      // A change for an unknown job means the list may be stale: refetch it (11 §13).
      if (!known) void refetch();
    });
  }, [announce, refetch]);

  // Hide each done line when its 10 minutes pass (06 §6): one timer for the earliest expiry.
  useEffect(() => {
    const next = Math.min(...jobs.map((j) => doneExpiry(j) ?? Infinity));
    if (next === Infinity) return;
    const t = setTimeout(() => setJobs((list) => dropExpired(list, Date.now())), Math.max(0, next - Date.now()));
    return () => clearTimeout(t);
  }, [jobs]);

  // Synchronous guard against a double click before the disabled state renders.
  const inFlight = useRef(new Set<string>());
  const setBusyFor = (id: string, on: boolean) => {
    if (on) inFlight.current.add(id);
    else inFlight.current.delete(id);
    setBusy(new Set(inFlight.current));
  };

  const act = async (job: JobSnapshot, action: 'cancel' | 'retry' | 'dismiss') => {
    if (inFlight.current.has(job.id)) return;
    setBusyFor(job.id, true);
    const r = await window.eli5.jobs[action](job.id);
    setBusyFor(job.id, false);
    if (!r.ok && r.error.code !== 'E_NOT_FOUND') {
      setErrors((e) => ({ ...e, [job.id]: r.error.message }));
      return;
    }
    setErrors(({ [job.id]: _drop, ...rest }) => rest);
    // Dismissed, or already gone from main (06 §11 E_NOT_FOUND): drop the line.
    if (action === 'dismiss' || !r.ok) {
      seen.current.delete(job.id);
      lastEvent.current.delete(job.id);
      setJobs((list) => list.filter((j) => j.id !== job.id));
    }
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
              busy={busy.has(j.id)}
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
  busy?: boolean;
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
          <button type="button" disabled={p.busy} onClick={() => p.onAct('cancel')}>
            Cancel
          </button>
        )}
        {j.canRetry && (
          <button type="button" disabled={p.busy} onClick={() => p.onAct('retry')}>
            Retry
          </button>
        )}
        {j.canDismiss && (
          <button type="button" disabled={p.busy} onClick={() => p.onAct('dismiss')}>
            Dismiss
          </button>
        )}
      </span>
      {p.error && <span className="inline-error">{p.error}</span>}
    </li>
  );
}
