import type { JobSnapshot, JobStatus } from '../../../preload/contract';

/** Status area model helpers (11 §5.5). */

export const isTerminal = (s: JobStatus): boolean => s === 'done' || s === 'failed';

/** Newest at the bottom. */
export function sortJobs(jobs: readonly JobSnapshot[]): JobSnapshot[] {
  return [...jobs].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1,
  );
}

/** A changed snapshot replaces the line with the same id, or adds one. */
export function upsertJob(jobs: readonly JobSnapshot[], s: JobSnapshot): JobSnapshot[] {
  const i = jobs.findIndex((j) => j.id === s.id);
  if (i === -1) return sortJobs([...jobs, s]);
  const next = [...jobs];
  next[i] = s;
  return next;
}

/** Leading glyph; aria-hidden, the status is in the text. */
export function jobGlyph(s: JobStatus): 'spinner' | 'check' | 'cross' {
  if (s === 'done') return 'check';
  if (s === 'failed') return 'cross';
  return 'spinner';
}

/** Splits a label around "Settings" so an LLM_AUTH line can link to it (11 §5.5). */
export function settingsLinkParts(line: string): [string, string] | null {
  const i = line.indexOf('Check Settings');
  if (i === -1) return null;
  const at = i + 'Check '.length;
  return [line.slice(0, at), line.slice(at + 'Settings'.length)];
}
