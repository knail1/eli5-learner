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

/**
 * A done line stays for 10 minutes (06 §6). Main applies the rule only when it answers
 * `jobs:list` and sends no event when a line expires, so the renderer mirrors it.
 */
export const DONE_LINE_MS = 10 * 60_000;

/** When a done line hides (ms since epoch), or null for other lines. */
export function doneExpiry(j: JobSnapshot): number | null {
  if (j.status !== 'done') return null;
  const at = Date.parse(j.finishedAt ?? j.createdAt);
  return Number.isNaN(at) ? null : at + DONE_LINE_MS;
}

/** Drops done lines whose 10 minutes have passed. */
export function dropExpired(jobs: readonly JobSnapshot[], now: number): JobSnapshot[] {
  return jobs.filter((j) => {
    const exp = doneExpiry(j);
    return exp === null || exp > now;
  });
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
