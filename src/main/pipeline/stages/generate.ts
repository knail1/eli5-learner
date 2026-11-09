// Generating stage (06 §5.4): orders 02's task calls, maps failures, checkpoints each output.
import type { StockPhotoInput } from '../../document';
import type { ExtractedContent } from '../../extract';
import {
  deserializePrepared,
  sectionText,
  serializePrepared,
  type DocumentDraftTab,
  type GlossaryDraft,
  type PreparedContent,
  type PreparedContentJson,
  type SteStepDraft,
  critiquable,
  type StepCtx,
  type TokenUsage,
  usageOf,
} from '../../llm';
import { PipelineFailure } from '../errors';
import { plannedSteps } from '../job';
import type { Job, JobStep, JobWarning } from '../types';
import { addWarning, checkpointOf, stageIndex, throwIfAborted, type StageContext } from './context';

/** gen/ artifact names (06 §5.4 rule 5). */
export const GEN = {
  prepared: 'gen/prepared.json',
  document: 'gen/document.json',
  ste: 'gen/ste.json',
  eli5Critique: 'gen/eli5-critique.json',
  glossary: 'gen/glossary.json',
  summary: 'gen/summary.json',
  photos: 'gen/photos.json',
} as const;

/** gen/photos.json (07 §7.4): resolved stock photos, bytes as base64. */
export interface PhotosStepOutput {
  photos: (Omit<StockPhotoInput, 'bytes'> & { bytes: string })[];
  prompt?: string;
}

export function decodePhotos(out: PhotosStepOutput | null): StockPhotoInput[] {
  return (out?.photos ?? []).map((p) => ({ ...p, bytes: new Uint8Array(Buffer.from(p.bytes, 'base64')) }));
}

export interface DocumentStepOutput {
  indepth: DocumentDraftTab;
  eli5: DocumentDraftTab | null;
  prompts: string[];
  /** The writing prompts offered `photo` blocks (07 §7.4). */
  photos?: boolean;
  /** The provider the job started generating with (06 §12). */
  provider: { id: string; model: string };
  /** Token usage per call (D25); absent in records written before usage logging. */
  usage?: { indepth?: TokenUsage; eli5?: TokenUsage };
}

/** gen/ste.json (06 §5.4 step 1b): the ASD-STE100 tab, or null when the step failed (`ste-omitted`). */
export interface SteStepOutput {
  ste: SteStepDraft | null;
  prompt?: string;
  usage?: TokenUsage;
}

/**
 * gen/eli5-critique.json (06 §5.4 step 1b, D17): the revised ELI5 view when the accept gate took it;
 * null keeps the step 1 draft (critique skipped, failed or rejected).
 */
export interface Eli5CritiqueStepOutput {
  eli5: DocumentDraftTab | null;
  outcome: 'accepted' | 'rejected' | 'failed' | 'skipped';
  reason?: string;
  prompt?: string;
  usage?: TokenUsage;
}

export interface GlossaryStepOutput {
  draft: GlossaryDraft | null;
  prompt?: string;
  usage?: TokenUsage;
}

export interface SummaryStepOutput {
  summary: string;
  source: 'llm' | 'fallback';
  topicSlugHint?: string;
  prompt?: string;
  usage?: TokenUsage;
}

/** The ELI5 view the document uses: the accepted critique revision, else the step 1 draft. */
export function finalEli5(doc: DocumentStepOutput, critique: Eli5CritiqueStepOutput | null): DocumentDraftTab | null {
  return critique?.eli5 ?? doc.eli5;
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

export function stepWarning(kind: JobWarning['kind']): JobWarning {
  const messages: Record<JobWarning['kind'], string> = {
    'source-skipped': 'A source was skipped',
    'eli5-placeholder': 'The ELI5 version could not be generated',
    'glossary-omitted': 'Glossary notes were omitted',
    'summary-fallback': 'The summary was taken from the lead section',
    'input-truncated': 'Some source content was cut to fit the model',
    'ste-omitted': 'The ASD-STE100 version could not be generated',
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
  if (p.usage.inputTokens || p.usage.outputTokens) logUsage(ctx, 'prepare', p.usage);
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
  const photos = photosOn(ctx);
  const write: StepCtx = { ...step, photos };
  const [indepth, eli5] = await Promise.allSettled([
    settle('indepth', deps.tasks.generateIndepth(p, { ...write, glossary: job.options.glossary })),
    settle('eli5', deps.tasks.generateEli5(p, write)),
  ]);
  throwIfAborted(ctx.signal);
  if (indepth.status === 'rejected') {
    // Required (06 §7.2); mapped by the runner. The tokens already spent are still logged (D25).
    logUsage(ctx, 'indepth', usageOf(indepth.reason));
    if (eli5.status === 'fulfilled') logUsage(ctx, 'eli5', eli5.value.usage);
    throw indepth.reason;
  }
  const prompts = [indepth.value.prompt];
  logUsage(ctx, 'indepth', indepth.value.usage);
  let eli5Draft: DocumentDraftTab | null = null;
  const usage: NonNullable<DocumentStepOutput['usage']> = { indepth: indepth.value.usage };
  if (eli5.status === 'fulfilled') {
    eli5Draft = eli5.value.draft;
    prompts.push(eli5.value.prompt);
    usage.eli5 = eli5.value.usage;
    logUsage(ctx, 'eli5', eli5.value.usage);
  } else {
    deps.log.warn('pipeline.step-degraded', { jobId: job.id, step: 'eli5', errorKind: errorKind(eli5.reason) });
    logUsage(ctx, 'eli5', usageOf(eli5.reason));
    addWarning(job, stepWarning('eli5-placeholder'));
  }
  return { indepth: indepth.value.draft, eli5: eli5Draft, prompts, provider, photos, usage };
}

/** D25: one `pipeline.usage` line per LLM step (token counts only, never content). */
function logUsage(ctx: StageContext, step: string, u: TokenUsage | undefined): void {
  if (!u) return;
  ctx.deps.log.info('pipeline.usage', {
    jobId: ctx.job.id,
    step,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheRead: u.cachedInputTokens ?? 0,
  });
}

/**
 * Step 1b (06 §5.4): the ASD-STE100 tab from the final In depth draft and one critique pass over
 * the ELI5 draft, concurrently. Both degrade: a failed STE step omits the tab (`ste-omitted`); a
 * failed or rejected critique keeps the step 1 draft without a user-facing warning (D17). The
 * critique is skipped when there is no ELI5 draft or when no revision of it could pass the gate's
 * section rule (a 1-section draft). Each step's result is handed to `save` as soon as that step
 * settles, so an interruption while the other call runs does not pay for a finished one again.
 */
async function stepOneB(
  ctx: StageContext,
  doc: DocumentStepOutput,
  step: StepCtx,
  todo: { ste: boolean; critique: boolean },
  save: {
    ste: (out: SteStepOutput) => Promise<void>;
    critique: (out: Eli5CritiqueStepOutput) => Promise<void>;
  },
): Promise<void> {
  const { deps } = ctx;
  throwIfAborted(ctx.signal);
  const eli5 = doc.eli5 && critiquable(doc.eli5) ? doc.eli5 : null;
  const order: JobStep[] = [];
  if (todo.ste) order.push('ste');
  if (todo.critique && eli5) order.push('eli5-critique');
  const running = new Set<JobStep>(order);
  ctx.setRunningSteps(order);
  /** Runs one step's call, then (unless the job was aborted) saves its outcome right away. */
  const branch = async <T, O>(
    s: JobStep,
    call: () => Promise<T>,
    outcome: (r: PromiseSettledResult<T>) => O,
    put: (o: O) => Promise<void>,
  ): Promise<void> => {
    let r: PromiseSettledResult<T>;
    try {
      r = { status: 'fulfilled', value: await call() };
    } catch (err) {
      r = { status: 'rejected', reason: err };
    } finally {
      running.delete(s);
      if (!ctx.signal.aborted) ctx.setRunningSteps(order.filter((x) => running.has(x)));
    }
    if (ctx.signal.aborted) return;
    await put(outcome(r));
  };
  const branches: Promise<void>[] = [];
  if (todo.ste)
    branches.push(
      branch(
        'ste',
        () => deps.tasks.generateSte(doc.indepth, step),
        (r) => steOutcome(ctx, r),
        save.ste,
      ),
    );
  if (todo.critique) {
    if (eli5)
      branches.push(
        branch(
          'eli5-critique',
          () => deps.tasks.critiqueEli5(eli5, doc.indepth, step),
          (r) => critiqueOutcome(ctx, r),
          save.critique,
        ),
      );
    else branches.push(save.critique({ eli5: null, outcome: 'skipped' }));
  }
  const settled = await Promise.allSettled(branches);
  throwIfAborted(ctx.signal);
  for (const r of settled) if (r.status === 'rejected') throw r.reason;
}

function steOutcome(
  ctx: StageContext,
  r: PromiseSettledResult<Awaited<ReturnType<StageContext['deps']['tasks']['generateSte']>>>,
): SteStepOutput {
  const { job, deps } = ctx;
  clearWarnings(job, 'ste-omitted');
  if (r.status === 'fulfilled') {
    const v = r.value;
    logUsage(ctx, 'ste', v.usage);
    deps.log.info('pipeline.ste-lint', {
      jobId: job.id,
      count: v.draft.lint.final.failing,
      status: v.draft.lint.repairTried ? (v.draft.lint.repairAccepted ? 'repaired' : 'repair-kept-first') : 'first',
    });
    return { ste: v.draft, prompt: v.prompt, usage: v.usage };
  }
  deps.log.warn('pipeline.step-degraded', { jobId: job.id, step: 'ste', errorKind: errorKind(r.reason) });
  addWarning(job, stepWarning('ste-omitted'));
  const spent = usageOf(r.reason);
  logUsage(ctx, 'ste', spent);
  return { ste: null, ...(spent ? { usage: spent } : {}) };
}

function critiqueOutcome(
  ctx: StageContext,
  r: PromiseSettledResult<Awaited<ReturnType<StageContext['deps']['tasks']['critiqueEli5']>>>,
): Eli5CritiqueStepOutput {
  const { job, deps } = ctx;
  if (r.status === 'fulfilled') {
    const v = r.value;
    logUsage(ctx, 'eli5-critique', v.usage);
    if (v.gate.ok) return { eli5: v.draft, outcome: 'accepted', prompt: v.prompt, usage: v.usage };
    deps.log.info('pipeline.eli5-critique-rejected', { jobId: job.id, code: v.gate.reason ?? 'unknown' });
    return { eli5: null, outcome: 'rejected', ...(v.gate.reason ? { reason: v.gate.reason } : {}), usage: v.usage };
  }
  deps.log.warn('pipeline.step-degraded', { jobId: job.id, step: 'eli5-critique', errorKind: errorKind(r.reason) });
  const spent = usageOf(r.reason);
  logUsage(ctx, 'eli5-critique', spent);
  return { eli5: null, outcome: 'failed', ...(spent ? { usage: spent } : {}) };
}

/** Stock photos are offered when the setting is on and a real (non-stub) provider is wired (07 §7.4). */
function photosOn(ctx: StageContext): boolean {
  const s = ctx.deps.settings();
  return (s.images?.stockPhotos ?? false) && ctx.deps.photos !== undefined && ctx.deps.photos.available();
}

function hasPhotoBlocks(drafts: { indepth: DocumentDraftTab; eli5: DocumentDraftTab | null }): boolean {
  return [drafts.indepth, drafts.eli5].some((t) => t?.sections.some((s) => s.blocks.some((b) => b.type === 'photo')));
}

/**
 * 07 §7.4: after the drafts, find stock photos for their photo slots. Fire-and-forget: any failure
 * leaves the slots unresolved (build drops them) without a warning; only cancellation escapes.
 */
async function photosStep(
  ctx: StageContext,
  doc: DocumentStepOutput,
  drafts: { indepth: DocumentDraftTab; eli5: DocumentDraftTab | null },
): Promise<void> {
  const { job, deps, store } = ctx;
  if ((await store.readJson(job.id, GEN.photos)) !== null) return;
  let out: PhotosStepOutput = { photos: [] };
  const service = deps.photos;
  if (service && doc.photos && photosOn(ctx) && hasPhotoBlocks(drafts)) {
    throwIfAborted(ctx.signal);
    ctx.setRunningSteps(['summary']);
    try {
      const r = await service.resolve(drafts, { jobId: job.id, signal: ctx.signal });
      out = {
        photos: r.photos.map((p) => ({ ...p, bytes: Buffer.from(p.bytes).toString('base64') })),
        ...(r.prompt ? { prompt: r.prompt } : {}),
      };
    } catch (err) {
      throwIfAborted(ctx.signal);
      deps.log.warn('pipeline.photos-skipped', { jobId: job.id, errorKind: errorKind(err) });
    }
  }
  await store.writeJson(job.id, GEN.photos, out);
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
    logUsage(ctx, step, usageOf(err));
    return null;
  }
}

export async function generateStage(ctx: StageContext): Promise<void> {
  const { job, deps, store } = ctx;
  const cp = checkpointOf(job);
  if (stageIndex(cp.stage) > stageIndex('generating')) return;
  // A record written before step 1b plans the new steps on resume (06 §9.3).
  const planned = plannedSteps(job.options);
  if (job.kind === 'create' && planned.some((s) => !job.progress.stepsPlanned.includes(s))) {
    job.progress.stepsPlanned = planned;
  }
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

  // Step 1b: ASD-STE100 tab || ELI5 critique (06 §5.4).
  const todo = { ste: !completed.has('ste'), critique: !completed.has('eli5-critique') };
  if (todo.ste || todo.critique) {
    await stepOneB(ctx, doc, step, todo, {
      ste: async (out) => {
        await store.writeJson(job.id, GEN.ste, out);
        await persistStep('ste');
      },
      critique: async (out) => {
        await store.writeJson(job.id, GEN.eli5Critique, out);
        await persistStep('eli5-critique');
      },
    });
  }
  const critique = (await store.readJson(job.id, GEN.eli5Critique)) as Eli5CritiqueStepOutput | null;
  const eli5 = finalEli5(doc, critique);

  if (job.options.glossary && !completed.has('glossary')) {
    clearWarnings(job, 'glossary-omitted');
    const r = await optional(ctx, 'glossary', () => deps.tasks.generateGlossary(indepth, step));
    if (!r) addWarning(job, stepWarning('glossary-omitted'));
    logUsage(ctx, 'glossary', r?.usage);
    const out: GlossaryStepOutput = r ? { draft: r.draft, prompt: r.prompt, usage: r.usage } : { draft: null };
    await store.writeJson(job.id, GEN.glossary, out);
    await persistStep('glossary');
  }

  if (!completed.has('summary')) {
    clearWarnings(job, 'summary-fallback');
    const r = await optional(ctx, 'summary', () => deps.tasks.summarize(indepth, step));
    const summary = r?.draft.summary.trim();
    logUsage(ctx, 'summary', r?.usage);
    let out: SummaryStepOutput;
    if (r && summary) {
      out = { summary, source: 'llm', topicSlugHint: r.draft.topicSlugHint, prompt: r.prompt, usage: r.usage };
    } else {
      addWarning(job, stepWarning('summary-fallback'));
      out = { summary: fallbackSummary(indepth), source: 'fallback' };
    }
    await store.writeJson(job.id, GEN.summary, out);
    await persistStep('summary');
  }
  await photosStep(ctx, doc, { indepth, eli5 });
  ctx.setRunningSteps([]);
  throwIfAborted(ctx.signal);
  cp.stage = 'saving';
  await ctx.persist();
}
