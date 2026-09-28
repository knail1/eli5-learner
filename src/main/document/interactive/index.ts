/**
 * Interactive reading (08): section actions, busy tracking, viewer reload + scroll-to. Re-exported
 * from src/main/document/index.ts by `export *`. Bootstrap builds one `createInteractiveReading`,
 * plugs its `runner` into the JobQueue (06 §8.2), calls `attachJobs(jobs)` once the queue exists,
 * and plugs its `actions` into IpcServices.sectionActions.
 */
export { sectionHash } from './hash';
export { RateLimiter, SECTION_ACTIONS_PER_MINUTE, RATE_WINDOW_MS } from './rate-limit';
export { SECTION_BUDGET_SHARE, NEIGHBOUR_CHARS, createSectionRunner } from './regenerate';
export type { RunnerEnv } from './regenerate';
export { SELECTION_CONTEXT_CHARS, selectionContext } from './selection-context';
export { NOTICES, createInteractiveReading } from './service';
export type { InteractiveReading } from './service';
export { SectionActionError, mirrorTabs, failureNotice } from './types';
export type { InteractiveDeps, InteractiveJobs, InteractiveLibrary, ViewerPort } from './types';
export { ViewerRefresh, createElectronViewerPort, viewerSlugOf } from './viewer';
export type { ViewerWebContents } from './viewer';
