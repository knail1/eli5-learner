/**
 * Merge suggestions (09 §10): matching, suggestions.json, accept and dismiss. Re-exported from
 * src/main/library/index.ts by `export *`. Bootstrap plugs `createMergeSuggestions(...).service`
 * into the IPC slot; FsLibrary.runMergeCheck (06 §10) delegates to the attached engine.
 */
export * from './constants';
export { LexicalScorer, STOPWORDS, stem, tokenize } from './similarity';
export type { SimilarityScorer } from './similarity';
export { createMergeSuggestions, SUGGESTIONS_FILE } from './engine';
export type {
  WeaveMerged,
  MergeJudge,
  MergeSuggestionsHandle,
  MergeSuggestionsOptions,
  MergeSuggestionsService,
} from './engine';
