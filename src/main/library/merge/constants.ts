/** Merge matching constants (09 §10.2). */

/** Candidates passed to the LLM judge. */
export const K = 8;
/** Minimum prefilter cosine similarity. */
export const PREFILTER_MIN = 0.05;
/** Minimum judge score for a suggestion. */
export const MERGE_THRESHOLD = 0.75;
/** Judge call timeout. */
export const JUDGE_TIMEOUT_MS = 30_000;
/** `MergeSuggestion.reason` cap (09 §10.4). */
export const MAX_REASON = 200;
/** `lastError` after a failed accept (09 §10.6 step 11). */
export const MERGE_FAILED_MESSAGE = 'Merge failed. Both documents were left unchanged.';
/** `lastError` when HOOK-LIB-02 refuses the pair at accept time (09 §10.6 step 3). */
export const MERGE_INELIGIBLE_MESSAGE = 'These documents cannot be merged.';
