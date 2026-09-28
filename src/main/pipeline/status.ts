// Status line strings (06 §6) and the JobStatus transition table (06 §3.2, §8.2).
// status.ts is the only producer of status line text (06 §6, 11).
import type { Job, JobFailureCode, JobKind, JobStatus, JobStep } from './types';

/** When false, every generating row collapses to the literal PRD wording `Generating document` (06 §6). */
export const GENERATING_DETAIL: boolean = true;

/** Titles longer than this are truncated with an ellipsis (06 §6). */
const TITLE_MAX = 60;

/** The 06 §6 table. Placeholders are filled by statusLine(). */
export const STATUS_LINES = {
  queued: 'Queued',
  queuedAhead: (n: number) => `Queued (${n} ahead)`,
  resuming: 'Resuming',
  reading: (done: number, total: number) => `Reading sources (${done} of ${total})`,
  readingSingle: 'Reading sources',
  extracting: 'Extracting content',
  generating: 'Generating document',
  generatingBoth: 'Generating document (in-depth and ELI5)',
  generatingIndepth: 'Generating document (in-depth explainer)',
  generatingEli5: 'Generating document (ELI5 version)',
  generatingGlossary: 'Generating document (glossary notes)',
  generatingSummary: 'Generating document (finishing up)',
  saving: 'Saving',
  done: (title: string) => `Done: ${title}`,
  doneSkipped: (title: string, k: number) => `Done: ${title} · ${k} source(s) skipped`,
  doneNotes: (title: string) => `Done: ${title} · with notes`,
  sectionRunning: (heading: string) => `Updating section: ${heading}`,
  sectionDone: (heading: string) => `Updated: ${heading}`,
  sectionEli5Running: (heading: string) => `Adding ELI5 tab: ${heading}`,
  selectionEli5Running: (heading: string) => `Adding ELI5 tab for a selection: ${heading}`,
  sectionEli5Done: (label: string) => `Added tab: ${label}`,
  failed: {
    NO_USABLE_CONTENT: (n: number) => `Failed: no usable content in ${n} source(s)`,
    LLM_AUTH: 'Failed: API key rejected. Check Settings',
    LLM_UNAVAILABLE: 'Failed: AI service unavailable. Try again later',
    SAVE_FAILED: 'Failed: could not save the document',
    CANCELLED: 'Cancelled',
    INTERRUPTED: 'Failed: interrupted by app restart',
    INTERNAL: 'Failed: something went wrong',
    SECTION_TOO_LARGE: 'Failed: section too long to rewrite',
    SECTION_GONE: 'Failed: section no longer exists',
    SECTION_CHANGED: 'Failed: section changed, try again',
    DOC_GONE: 'Failed: document no longer exists',
    TOO_MANY_TABS: 'Failed: too many ELI5 tabs', // 08 §9
  } satisfies Record<Exclude<JobFailureCode, 'NO_USABLE_CONTENT'>, string> & {
    NO_USABLE_CONTENT: (n: number) => string;
  },
} as const;

/** The Job fields the status line depends on. */
export type StatusLineJob = Pick<
  Job,
  'kind' | 'status' | 'inputs' | 'progress' | 'skipped' | 'warnings' | 'result' | 'failure' | 'section' | 'resuming'
>;

/** Queue/runtime state that is not on the persisted Job record. */
export interface StatusLineContext {
  /** Number of jobs ahead in the lane, including a running one (06 §6 "position"). */
  queuePosition?: number;
  /** Generation steps currently running (06 §5.4 rule 4); defaults to progress.step. */
  runningSteps?: readonly JobStep[];
  /** Label of the tab an `eli5-tab` section job added; defaults to result.title. */
  tabLabel?: string;
}

/** Truncate to at most 60 characters with an ellipsis (06 §6). */
export function truncateTitle(title: string): string {
  const chars = [...title];
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('')}…` : title;
}

function generatingLine(job: StatusLineJob, ctx: StatusLineContext): string {
  if (!GENERATING_DETAIL) return STATUS_LINES.generating;
  const running = new Set<JobStep>(ctx.runningSteps ?? (job.progress.step ? [job.progress.step] : []));
  const indepth = running.has('indepth');
  const eli5 = running.has('eli5');
  // Earliest step in 06 §5.4 order wins when several overlap.
  if (indepth && eli5) return STATUS_LINES.generatingBoth;
  if (indepth) return STATUS_LINES.generatingIndepth;
  if (eli5) return STATUS_LINES.generatingEli5;
  if (running.has('glossary')) return STATUS_LINES.generatingGlossary;
  if (running.has('summary')) return STATUS_LINES.generatingSummary;
  return STATUS_LINES.generating;
}

function failedLine(job: StatusLineJob): string {
  const code: JobFailureCode = job.failure?.code ?? 'INTERNAL';
  if (code === 'NO_USABLE_CONTENT') return STATUS_LINES.failed.NO_USABLE_CONTENT(job.inputs.length);
  return STATUS_LINES.failed[code];
}

function sectionLine(job: StatusLineJob, ctx: StatusLineContext): string {
  const heading = job.section?.heading ?? '';
  const action = job.section?.action;
  const eli5Tab = action === 'eli5-tab' || action === 'eli5-selection';
  if (job.status === 'done') {
    return eli5Tab
      ? STATUS_LINES.sectionEli5Done(ctx.tabLabel ?? job.result?.title ?? heading)
      : STATUS_LINES.sectionDone(heading);
  }
  if (action === 'eli5-selection') return STATUS_LINES.selectionEli5Running(heading);
  return eli5Tab ? STATUS_LINES.sectionEli5Running(heading) : STATUS_LINES.sectionRunning(heading);
}

/** The single user-facing status line for a job (06 §6). */
export function statusLine(job: StatusLineJob, ctx: StatusLineContext = {}): string {
  if (job.status === 'failed') return failedLine(job);
  if (job.kind === 'section') return sectionLine(job, ctx);
  switch (job.status) {
    case 'queued': {
      if (job.resuming) return STATUS_LINES.resuming;
      const n = ctx.queuePosition ?? 0;
      return n >= 2 ? STATUS_LINES.queuedAhead(n) : STATUS_LINES.queued;
    }
    case 'reading':
      return job.progress.sourcesTotal <= 1
        ? STATUS_LINES.readingSingle
        : STATUS_LINES.reading(job.progress.sourcesDone, job.progress.sourcesTotal);
    case 'extracting':
      return STATUS_LINES.extracting;
    case 'generating':
      return generatingLine(job, ctx);
    case 'saving':
      return STATUS_LINES.saving;
    case 'done': {
      const title = truncateTitle(job.result?.title ?? '');
      const k = job.skipped.length;
      if (k > 0) return STATUS_LINES.doneSkipped(title, k);
      if (job.warnings.some((w) => w.kind !== 'source-skipped')) return STATUS_LINES.doneNotes(title);
      return STATUS_LINES.done(title);
    }
  }
}

// ---- State machine (06 §3.2) ----

const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(['done', 'failed']);
const RUNNING: ReadonlySet<JobStatus> = new Set<JobStatus>(['reading', 'extracting', 'generating', 'saving']);

const FORWARD: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ['reading'],
  reading: ['extracting'],
  extracting: ['generating'],
  generating: ['saving'],
  saving: ['done'],
  done: [],
  failed: ['queued'], // Retry (06 §7.3)
};

/** True when `from -> to` is in the 06 §3.2 table. `queued -> generating` is legal only for section jobs (06 §8.2). */
export function canTransition(from: JobStatus, to: JobStatus, kind: JobKind = 'create'): boolean {
  if (FORWARD[from].includes(to)) return true;
  if (from === 'queued' && to === 'generating') return kind === 'section';
  if (to === 'failed') return !TERMINAL.has(from); // total failure or cancel
  if (to === 'queued') return RUNNING.has(from); // crash recovery (06 §9.4)
  return false;
}

/** Programming error; the caller logs it and fails the job with INTERNAL (06 §3.2). */
export class IllegalTransitionError extends Error {
  constructor(
    readonly from: JobStatus,
    readonly to: JobStatus,
    readonly kind: JobKind,
  ) {
    super(`Illegal job transition ${from} -> ${to} (${kind})`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition(from: JobStatus, to: JobStatus, kind: JobKind = 'create'): void {
  if (!canTransition(from, to, kind)) throw new IllegalTransitionError(from, to, kind);
}
