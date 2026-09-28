// Generating stage (06 §5.4): orders 02's task calls, maps failures, checkpoints each output.
import type { ExtractedContent } from '../../extract';
import {
  deserializePrepared,
  sectionText,
  serializePrepared,
  type DocumentDraftTab,
  type GlossaryDraft,
  type PreparedContent,
  type PreparedContentJson,
  type StepCtx,
} from '../../llm';
import { PipelineFailure } from '../errors';
import type { Job, JobStep, JobWarning } from '../types';
import { addWarning, checkpointOf, stageIndex, throwIfAborted, type StageContext } from './context';

/** gen/ artifact names (06 §5.4 rule 5). */
export const GEN = {
  prepared: 'gen/prepared.json',
  document: 'gen/document.json',
  glossary: 'gen/glossary.json',
  summary: 'gen/summary.json',
} as const;

export interface DocumentStepOutput {
  indepth: DocumentDraftTab;
  eli5: DocumentDraftTab | null;
  prompts: string[];
  /** The provider the job started generating with (06 §12). */
  provider: { id: string; model: string };
}

export interface GlossaryStepOutput {
  draft: GlossaryDraft | null;
  prompt?: string;
}

export interface SummaryStepOutput {
  summary: string;
  source: 'llm' | 'fallback';
  topicSlugHint?: string;
  prompt?: string;
}

/** Fallback summary: the first 2 sentences of the in-depth lead section, at most 300 chars (06 §7.1). */
export function fallbackSummary(indepth: DocumentDraftTab): string {
  const lead = indepth.sections[0];
  if (!lead) return indepth.title.slice(0, 300);
  const body = sectionText(lead)
    .split('\n')
    .slice(1) // heading
    .join(' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = body.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [body];
  const text = sentences.slice(0, 2).join('').trim() || indepth.title;
  return text.length > 300 ? `${text.slice(0, 299).trimEnd()}…` : text;
}

function stepWarning(kind: JobWarning['kind']): JobWarning {
  const messages: Record<JobWarning['kind'], string> = {
    'source-skipped': 'A source was skipped',
    'eli5-placeholder': 'The ELI5 version could not be generated',
    'glossary-omitted': 'Glossary notes were omitted',
    'summary-fallback': 'The summary was taken from the lead section',
    'input-truncated': 'Some source content was cut to fit the model',
  };
  return { kind, message: messages[kind] };
}

function clearWarnings(job: Job, kind: JobWarning['kind']): void {
  job.warnings = job.warnings.filter((w) => w.kind !== kind);
}

/** Loads every extracted source of the job in resolved order. */
export async function loadContents(ctx: StageContext): Promise<ExtractedContent[]> {
  const out: ExtractedContent[] = [];
  for (const r of ctx.job.resolved) {
    const c = await ctx.store.readExtracted(ctx.job.id, r.id);
    if (!c) throw new PipelineFailure('INTERNAL', 'extracted-artifact-missing');
    out.push(c);
  }
  return out;
}

async function prepared(ctx: StageContext, step: StepCtx): Promise<PreparedContent> {
  const { job, store, deps } = ctx;
  const saved = (await store.readJson(job.id, GEN.prepared)) as PreparedContentJson | null;
  if (saved && Array.isArray(saved.images) && typeof saved.promptText === 'string') return deserializePrepared(saved);
  const contents = await loadContents(ctx);
  const p = await deps.tasks.prepareContent({
    contents,
    sourceList: job.resolved.map((r) => ({ ref: r.ref, label: r.title?.trim() || r.ref })),
    ...step,
  });
  throwIfAborted(ctx.signal);
  // Sources the model could not read (02 §8.3-§8.4) and truncation (02 §8.4 step 4, 06 §5.4 rule 3).
  for (const s of p.skipped) {
    if (!job.skipped.some((x) => x.ref === s.ref && x.code === s.code)) job.skipped.push(s);
  }
  if (p.warnings.includes('content-truncated')) addWarning(job, stepWarning('input-truncated'));
  await ctx.persist();
  await store.writeJson(job.id, GEN.prepared, serializePrepared(p));
  return p;
}

/** Runs step 1 with the in-depth and ELI5 calls concurrently; the status line follows the running set. */
async function documentStep(ctx: StageContext, p: PreparedContent, step: StepCtx): Promise<DocumentStepOutput> {
  const { job, deps } = ctx;
  throwIfAborted(ctx.signal);
  const running = new Set<JobStep>(['indepth', 'eli5']);
  const order: JobStep[] = ['indepth', 'eli5'];
  ctx.setRunningSteps(order);
  const settle = <T>(s: JobStep, pr: Promise<T>): Promise<T> =>
    pr.finally(() => {
      running.delete(s);
      if (!ctx.signal.aborted) ctx.setRunningSteps(order.filter((x) => running.has(x)));
    });
  const provider = deps.llmInfo();
  clearWarnings(job, 'eli5-placeholder');
  const [indepth, eli5] = await Promise.allSettled([
    settle('indepth', deps.tasks.generateIndepth(p, { ...step, glossary: job.options.glossary })),
    settle('eli5', deps.tasks.generateEli5(p, step)),
  ]);
  throwIfAborted(ctx.signal);
  if (indepth.status === 'rejected') throw indepth.reason; // required (06 §7.2); mapped by the runner
  const prompts = [indepth.value.prompt];
  let eli5Draft: DocumentDraftTab | null = null;
  if (eli5.status === 'fulfilled') {
    eli5Draft = eli5.value.draft;
    prompts.push(eli5.value.prompt);
  } else {
    deps.log.warn('pipeline.step-degraded', { jobId: job.id, step: 'eli5', errorKind: errorKind(eli5.reason) });
    addWarning(job, stepWarning('eli5-placeholder'));
  }
  return { indepth: indepth.value.draft, eli5: eli5Draft, prompts, provider };
}

function errorKind(err: unknown): string {
  const k = (err as { kind?: unknown } | null)?.kind;
  return typeof k === 'string' ? k : err instanceof Error ? err.name : 'unknown';
}

/** Optional steps degrade; only cancellation escapes (06 §5.4 rule 6, §7.1). */
async function optional<T>(ctx: StageContext, step: JobStep, run: () => Promise<T>): Promise<T | null> {
  throwIfAborted(ctx.signal);
  ctx.setRunningSteps([step]);
  try {
    return await run();
  } catch (err) {
    throwIfAborted(ctx.signal);
    ctx.deps.log.warn('pipeline.step-degraded', { jobId: ctx.job.id, step, errorKind: errorKind(err) });
    return null;
  }
}

export async function generateStage(ctx: StageContext): Promise<void> {
  const { job, deps, store } = ctx;
  const cp = checkpointOf(job);
  if (stageIndex(cp.stage) > stageIndex('generating')) return;
  const completed = new Set<JobStep>(cp.completedSteps);
  const step: StepCtx = { clarifyingInput: job.options.clarifyingInput, signal: ctx.signal };
  const persistStep = async (...steps: JobStep[]): Promise<void> => {
    for (const s of steps) completed.add(s);
    cp.completedSteps = job.progress.stepsPlanned.filter((s) => completed.has(s));
    await ctx.persist();
  };

  let doc = completed.has('indepth')
    ? ((await store.readJson(job.id, GEN.document)) as DocumentStepOutput | null)
    : null;
  if (!doc) {
    // 06 §7.2 item 2: no key for the selected provider fails before any network request.
    if (deps.hasApiKey && !(await deps.hasApiKey())) throw new PipelineFailure('LLM_AUTH', 'no-api-key');
    const p = await prepared(ctx, step);
    doc = await documentStep(ctx, p, step);
    await store.writeJson(job.id, GEN.document, doc);
    await persistStep('indepth', 'eli5');
  }
  const indepth = doc.indepth;

  if (job.options.glossary && !completed.has('glossary')) {
    clearWarnings(job, 'glossary-omitted');
    const r = await optional(ctx, 'glossary', () => deps.tasks.generateGlossary(indepth, step));
    if (!r) addWarning(job, stepWarning('glossary-omitted'));
    const out: GlossaryStepOutput = r ? { draft: r.draft, prompt: r.prompt } : { draft: null };
    await store.writeJson(job.id, GEN.glossary, out);
    await persistStep('glossary');
  }

  if (!completed.has('summary')) {
    clearWarnings(job, 'summary-fallback');
    const r = await optional(ctx, 'summary', () => deps.tasks.summarize(indepth, step));
    const summary = r?.draft.summary.trim();
    let out: SummaryStepOutput;
    if (r && summary) {
      out = { summary, source: 'llm', topicSlugHint: r.draft.topicSlugHint, prompt: r.prompt };
    } else {
      addWarning(job, stepWarning('summary-fallback'));
      out = { summary: fallbackSummary(indepth), source: 'fallback' };
    }
    await store.writeJson(job.id, GEN.summary, out);
    await persistStep('summary');
  }
  ctx.setRunningSteps([]);
  throwIfAborted(ctx.signal);
  cp.stage = 'saving';
  await ctx.persist();
}
