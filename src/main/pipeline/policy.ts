import type { PipelinePolicy } from './types';

/** Public HOOK-PIPE-01 default (06 §9.5 hook): 1-3 create slots, 200 MB copy threshold, 7/30-day retention. */
export const defaultPipelinePolicy: PipelinePolicy = Object.freeze({
  maxCreateSlots: 3,
  snapshotCopyMaxBytes: 200 * 1024 * 1024,
  retention: Object.freeze({ failedStagingDays: 7, recordDays: 30 }),
  stagingRetention: () => 'default' as const,
  resumeAfterCrash: () => true,
});
