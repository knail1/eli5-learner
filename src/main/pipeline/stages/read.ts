// Reading stage (06 §5.2): every input becomes a ResolvedSource or a SkippedSource (03 §4).
import { stat } from 'node:fs/promises';
import { DEFAULT_RESOLVE_LIMITS, resolveAll, type ResolvedSource } from '../../sources';
import { PipelineFailure } from '../errors';
import { checkpointOf, debugLog, emptyCheckpoint, stageIndex, throwIfAborted, type StageContext } from './context';

/** True when every resolved source's staged payload still exists (06 §9.3 validity). */
export async function resolvedArtifactsExist(resolved: readonly ResolvedSource[]): Promise<boolean> {
  for (const r of resolved) {
    if (r.payload.kind !== 'path') continue;
    if (
      !(await stat(r.payload.path).then(
        (s) => s.isFile(),
        () => false,
      ))
    )
      return false;
  }
  return true;
}

/** Waits for `p`, but gives up as soon as the job is cancelled (06 §8.1: cancel within 2 s). */
async function abortable(p: Promise<void>, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  let onAbort = (): void => {};
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([p, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  throwIfAborted(signal);
}

export async function readStage(ctx: StageContext): Promise<void> {
  const { job, deps } = ctx;
  // Resume: sources already resolved are not refetched while their staged artifacts exist (§5.2 step 4).
  if (stageIndex(job.checkpoint?.stage) > 0 && (await resolvedArtifactsExist(job.resolved))) {
    job.progress.sourcesDone = job.progress.sourcesTotal;
    return;
  }
  // 06 §9.2: a copy that could not be cloned finishes before its file is read.
  await abortable(ctx.inputsReady(), ctx.signal);
  job.resolved = [];
  job.skipped = [];
  job.progress.sourcesTotal = job.inputs.length;
  job.progress.sourcesDone = 0;
  job.checkpoint = emptyCheckpoint();

  const mcp = deps.mcp?.();
  const out = await resolveAll(
    job.inputs,
    {
      jobId: job.id,
      edition: deps.edition,
      stagingDir: ctx.store.stagingDir(job.id),
      ...(mcp ? { mcp } : {}),
      signal: ctx.signal,
      limits: deps.resolveLimits ?? DEFAULT_RESOLVE_LIMITS,
      fetchUrl: deps.fetchUrl,
      lanes: deps.laneRouter(),
      log: debugLog(deps.log, 'pipeline.resolve'),
      onInputSettled: () => {
        job.progress.sourcesDone = Math.min(job.progress.sourcesTotal, job.progress.sourcesDone + 1);
        ctx.progress();
      },
    },
    deps.resolvers(),
  );
  throwIfAborted(ctx.signal);
  job.resolved = out.resolved;
  job.skipped = out.skipped;
  job.progress.sourcesDone = job.progress.sourcesTotal;
  // 03 §4 step 7: nothing resolved is owned here as NO_USABLE_CONTENT.
  if (out.resolved.length === 0) throw new PipelineFailure('NO_USABLE_CONTENT', 'nothing-resolved');
  const cp = checkpointOf(job);
  cp.stage = 'extracting';
  cp.resolvedRefs = out.resolved.map((r) => r.ref);
  await ctx.persist();
}
