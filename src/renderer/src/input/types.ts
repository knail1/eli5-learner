import type { SourceInput } from '../../../preload/contract';

/** The job being composed in the input zone (11 §5.4). */
export interface InputDraft {
  /**
   * "draft-" + 8 hex; new one after every clear. After a start it changes only when no unsent
   * staged paste still needs its staging folder (11 §5.4 step 5).
   */
  draftId: string;
  /** Shown as chips, in the order added: the inputs the next Start sends. */
  inputs: SourceInput[];
  /** URL inputs of the last successful start, shown as a dimmed Last run row (11 §5.4). */
  lastRun: SourceInput[];
  /** Uncommitted text in the URL field. */
  urlText: string;
  /** Optional specifics. */
  clarifying: string;
  /** Initialised from settings glossary.defaultOn. */
  glossary: boolean;
}
