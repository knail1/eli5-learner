/** Public StagingPolicy (HOOK-SRC-04): standard staging and retention per 06 §9. */
import { join } from 'node:path';
import type { StagingPolicy } from './types';

export const defaultStagingPolicy: StagingPolicy = Object.freeze({
  /** One staging root per job (06 §9.2). */
  stagingDir: (userData: string, jobId: string) => join(userData, 'jobs', jobId),
  mayStageToDisk: () => true,
  /** 06 §9.5: deleted at `done`; kept up to 7 days (or until dismissed) after `failed`. */
  retention: () => 'default' as const,
  secureDelete: false,
  persistedLocation: (src: { location: string }) => src.location,
  documentLabel: () => null,
});
