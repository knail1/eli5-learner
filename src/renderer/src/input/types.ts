import type { SourceInput } from '../../../preload/contract';

/** The job being composed in the input zone (11 §5.4). */
export interface InputDraft {
  /** "draft-" + 8 hex; new one after every clear. A start keeps the draft, and its id (11 §5.4). */
  draftId: string;
  /** Shown as chips, in the order added. */
  inputs: SourceInput[];
  /** Uncommitted text in the URL field. */
  urlText: string;
  /** Optional specifics. */
  clarifying: string;
  /** Initialised from settings glossary.defaultOn. */
  glossary: boolean;
}
