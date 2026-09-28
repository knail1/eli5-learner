import { buildLaneRouter } from '../../../../src/main/sources/lanes';
import { DEFAULT_RESOLVE_LIMITS, type ResolveContext } from '../../../../src/main/sources/types';

export function fakeCtx(over: Partial<ResolveContext> = {}): ResolveContext {
  return {
    jobId: 'job-1',
    edition: 'public',
    stagingDir: '/tmp/eli5-test/jobs/job-1',
    signal: new AbortController().signal,
    limits: { ...DEFAULT_RESOLVE_LIMITS },
    fetchUrl: () => Promise.reject(new Error('no network in unit tests')),
    lanes: buildLaneRouter([]),
    log: () => {},
    ...over,
  };
}
