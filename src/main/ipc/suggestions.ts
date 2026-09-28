import { z } from 'zod';
import { IPC, type DocUpdatedEvent, type MergeSuggestion } from '../../preload/contract';
import { NoPayload, type Register } from './handle';

type Unsub = () => void;

/**
 * Merge suggestions service (09 §10), implemented by the merge slice (src/main/library/merge/).
 * Throw LibraryError('SUGGESTION_STALE' | 'MERGE_FAILED' | 'LIBRARY_READ_ONLY' | ...) for errors;
 * the boundary maps them (01 §5.1).
 */
export interface MergeSuggestions {
  /** `eli5:suggestions:list`: pending and accepting suggestions (09 §11). */
  list(): Promise<MergeSuggestion[]>;
  /** `eli5:suggestions:accept` (09 §10.6). */
  accept(suggestionId: string): Promise<{ targetSlug: string }>;
  /** `eli5:suggestions:dismiss` (09 §10.7). */
  dismiss(suggestionId: string): Promise<void>;
  /** Pushed to the app as `eli5:suggestions:changed {suggestions}`. */
  onChanged(cb: (suggestions: MergeSuggestion[]) => void): Unsub;
  /** A merge rewrote the target: pushed as `eli5:doc:updated` (09 §10.6 step 12). */
  onDocUpdated(cb: (e: DocUpdatedEvent) => void): Unsub;
}

/** Suggestion ids are UUIDs (09 §10.4). */
export const SuggestionIdPayload = z.object({ suggestionId: z.uuid() });

/** `eli5:suggestions:*` invokes (09 §11). Events are wired by registerIpc. */
export function registerSuggestionsIpc(on: Register, d: { suggestions: MergeSuggestions }): void {
  on(IPC.suggestions.list, NoPayload, () => d.suggestions.list());
  on(IPC.suggestions.accept, SuggestionIdPayload, (p) => d.suggestions.accept(p.suggestionId));
  on(IPC.suggestions.dismiss, SuggestionIdPayload, (p) => d.suggestions.dismiss(p.suggestionId));
}
