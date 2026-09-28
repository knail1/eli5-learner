// Extracting stage (06 §5.3): ExtractedContent per resolved source, staged as the generation checkpoint.
import {
  DEFAULT_EXTRACT_LIMITS,
  JobImageBudget,
  skippedSource,
  type ContentBlock,
  type ExtractedContent,
} from '../../extract';
import { IMAGE_FORMATS, type ResolvedSource } from '../../sources';
import { PipelineFailure } from '../errors';
import { checkpointOf, sourceIndex, stageIndex, throwIfAborted, type StageContext } from './context';

/** Per-job extraction parallelism (06 §5.3 step 2). */
export const EXTRACT_PARALLELISM = 2;

const IMAGE_SET = new Set<string>(IMAGE_FORMATS);

/** Dropped or pasted images: extracted first with standalone budget priority (06 §5.3 step 1). */
export function isStandaloneImage(s: ResolvedSource): boolean {
  return IMAGE_SET.has(s.format);
}

function hasUsableBlock(blocks: readonly ContentBlock[]): boolean {
  return blocks.some((b) => {
    if (b.kind === 'image') return true;
    if (b.kind === 'slide' || b.kind === 'page')
      return hasUsableBlock(b.blocks) || (b.kind === 'slide' && !!b.notes?.text.trim());
    if (b.kind === 'list') return b.items.some((i) => i.text.trim() !== '');
    if (b.kind === 'table') return [...(b.header ?? []), ...b.rows.flat()].some((c) => c.trim() !== '');
    return b.text.trim() !== '';
  });
}

/** 06 §5.3 step 5: a text block with a non-whitespace character, or an image. */
export function isUsable(c: ExtractedContent): boolean {
  return c.images.length > 0 || hasUsableBlock(c.blocks);
}

async function pool<T>(items: readonly T[], width: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, () => worker()));
}

export async function extractStage(ctx: StageContext): Promise<void> {
  const { job, deps, store } = ctx;
  const cp = checkpointOf(job);
  if (stageIndex(cp.stage) > stageIndex('extracting')) return; // generation checkpoint already staged

  // Resume: keep artifacts that exist and parse; rebuild the image budget from them (§5.3 step 4).
  const done = new Set<number>();
  const budget = new JobImageBudget();
  for (const idx of cp.extractedIndexes) {
    const src = job.resolved.find((r) => sourceIndex(r.id) === idx);
    const content = src ? await store.readExtracted(job.id, src.id) : null;
    if (!content) continue;
    done.add(idx);
    for (const img of content.images) budget.tryReserve(img.byteLength, img.origin);
  }
  const pending = job.resolved.filter((r) => !done.has(sourceIndex(r.id)));
  const standalone = pending.filter(isStandaloneImage);
  const others = pending.filter((r) => !isStandaloneImage(r));
  budget.reserveStandalone(standalone.length);

  const failed = new Set<string>();
  const runner = deps.createExtractRunner(job.id);
  const one = async (src: ResolvedSource): Promise<void> => {
    throwIfAborted(ctx.signal);
    const r = await runner.extract(src, {
      signal: ctx.signal,
      limits: deps.extractLimits ?? DEFAULT_EXTRACT_LIMITS,
      budget,
    });
    throwIfAborted(ctx.signal);
    if (r.ok && isUsable(r.content)) {
      await store.writeExtracted(job.id, r.content);
      done.add(sourceIndex(src.id));
      cp.extractedIndexes = [...done].sort((a, b) => a - b);
    } else {
      // §5.3 step 3: the source moves to skipped with the extractor's reason.
      job.skipped.push(r.ok ? skippedSource(src, 'empty') : r.skipped);
      failed.add(src.id);
      job.resolved = job.resolved.filter((x) => x.id !== src.id);
    }
    ctx.progress();
  };
  try {
    for (const s of standalone) await one(s); // standalone images reserve budget first
    await pool(others, EXTRACT_PARALLELISM, one);
  } finally {
    runner.dispose();
  }
  throwIfAborted(ctx.signal);
  if (job.resolved.length === 0) throw new PipelineFailure('NO_USABLE_CONTENT', 'nothing-extracted');
  cp.stage = 'generating';
  await ctx.persist();
}
