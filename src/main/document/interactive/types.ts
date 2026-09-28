// Interactive reading (08 §3): collaborator interfaces, the request error, and meta.json mirroring.
import type {
  DocHistoryState,
  IpcErrorCode,
  JobFailureCode,
  JobSnapshot,
  JobStatus,
  MenuAction,
} from '../../../preload/contract';
import {
  quoteLabel,
  type DocumentMeta,
  type DocumentPatch,
  type LibraryChangeReason,
  type TabRecord,
} from '../../library';
import type { LlmTasks } from '../../llm';
import type { Logger } from '../../security';
import type { IdSource } from '../section-id';
import type { SectionJobPayload, Tab } from '../types';

export type Unsub = () => void;

/**
 * A request refused before any job exists (08 §6.1, §7.2). src/main/ipc/doc.ts maps it to an
 * IpcError with this code and message; the message is the runtime's inline notice (08 §9).
 */
export class SectionActionError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SectionActionError';
  }
}

/** The library calls 08 makes (09 §9). FsLibrary satisfies it. */
export interface InteractiveLibrary {
  readonly readOnly: boolean;
  hasSlug(slug: string): boolean;
  docPath(slug: string, file?: 'index.html' | 'meta.json'): string;
  getMeta(slug: string): Promise<DocumentMeta>;
  withDocLock<T>(slug: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Atomic index.html + meta.json write and catalog bump; caller holds withDocLock (09 §9). With
   * html, the previous files become the prior version labelled `label` (09 §4.1).
   */
  updateDocument(slug: string, patch: DocumentPatch): Promise<{ id: string; topicSlug: string; title: string }>;
  /** 09 §4.1: what the single prior version offers, and the swaps (each takes the doc lock). */
  history(slug: string): Promise<DocHistoryState>;
  undo(slug: string): Promise<DocHistoryState>;
  redo(slug: string): Promise<DocHistoryState>;
  on(event: 'changed', cb: (e: { reason: LibraryChangeReason; slugs: string[] }) => void): () => void;
}

/** The queue calls 08 makes (06 §8.2). JobQueue satisfies it. */
export interface InteractiveJobs {
  enqueueSection(payload: SectionJobPayload): Promise<{ jobId: string }>;
  get(id: string): { status: JobStatus; section?: SectionJobPayload; failure?: { code: JobFailureCode } } | undefined;
  list(): Pick<JobSnapshot, 'id' | 'kind' | 'status'>[];
  on(event: 'changed', cb: (s: Pick<JobSnapshot, 'id' | 'kind' | 'status'>) => void): Unsub;
}

/**
 * The document viewer as main sees it (08 §2 item 4). `onLoadStart` fires for every loadURL and
 * reload (did-start-loading), `onLoadFinish` on did-finish-load of the main frame, `onLoadFail` on
 * did-fail-load of the main frame (no did-finish-load follows it).
 */
export interface ViewerPort {
  /** Slug of the eli5doc:// document the viewer shows, or null. */
  currentSlug(): string | null;
  reload(): void;
  onLoadStart(cb: () => void): Unsub;
  onLoadFinish(cb: () => void): Unsub;
  onLoadFail(cb: () => void): Unsub;
}

export interface InteractiveDeps {
  library: InteractiveLibrary;
  tasks: Pick<LlmTasks, 'runSectionAction'>;
  viewer: ViewerPort;
  /** 08 §6.1 step 5: key present for the selected provider (no network). Default: true. */
  hasApiKey?: () => Promise<boolean>;
  clock?: { now(): Date };
  /** SectionId / tab key randomness (07 §4.2); pipeline deps pass `sectionIds`. */
  sectionIds?: IdSource;
  /** Default: fs.promises.readFile(p, 'utf8'). */
  readFile?: (path: string) => Promise<string>;
  /** Model input budget in tokens (02 §8); 08 §6.2 step 5 uses 60% of it. Absent: no budget check. */
  inputBudgetTokens?: () => number;
  /** 08 §6.1 step 1a. Default: 10 per 60 s. */
  rateLimit?: { max: number; windowMs: number };
  log?: Logger;
}

/** InteractiveDeps with defaults filled in. */
export type ResolvedDeps = Omit<InteractiveDeps, 'clock' | 'readFile'> & {
  clock: { now(): Date };
  readFile: (path: string) => Promise<string>;
};

const ACTION_VERBS: Record<MenuAction, string> = {
  expand: 'expanded',
  reexplain: 're-explained',
  analogy: 'added an analogy to',
  deeper: 'went deeper on',
  'eli5-tab': 'added ELI5 tab',
  'eli5-selection': 'added ELI5 tab',
};

/**
 * 08 §6.7: the Undo/Redo label of a change, e.g. "re-explained 'The particular…'" for a section
 * action on that heading, "added ELI5 tab 'ELI5: Pricing'", "added ELI5 tab 'ELI5: Churn' for a
 * selection", "closed tab 'ELI5: Pricing'".
 */
export function changeLabel(kind: MenuAction | 'close-tab', name: string): string {
  const verb = kind === 'close-tab' ? 'closed tab' : ACTION_VERBS[kind];
  const label = `${verb} '${quoteLabel(name)}'`;
  return kind === 'eli5-selection' ? `${label} for a selection` : label;
}

/** 08 §6.4 step 7: `mirrorTabs` maps each Tab to its meta.json record. */
export function mirrorTabs(tabs: readonly Tab[]): TabRecord[] {
  return tabs.map((t) => ({
    key: t.key,
    kind: t.kind,
    label: t.label,
    sectionCount: t.sections.length,
    ...(t.origin ? { sourceSectionId: t.origin.sectionId } : {}),
    createdAt: t.createdAt,
  }));
}

/** 08 §9: the inline notice for a failed section job, or undefined when none is shown. */
export function failureNotice(code: JobFailureCode): string | undefined {
  switch (code) {
    case 'LLM_AUTH':
    case 'LLM_UNAVAILABLE':
    case 'INTERNAL':
      return "Couldn't update this section. Try again";
    case 'SECTION_TOO_LARGE':
      return 'This section is too long to rewrite in one step';
    case 'SECTION_CHANGED':
      return 'This section changed. Try again';
    case 'TOO_MANY_TABS':
      return 'Close a section ELI5 tab before adding another';
    case 'SAVE_FAILED':
      return "Couldn't save the change";
    default:
      return undefined;
  }
}
