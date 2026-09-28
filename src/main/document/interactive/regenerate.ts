// Section runner (08 §6.2-§6.4, §7.1): generating stage (context + LLM), then the saving stage
// (re-read and re-parse under withDocLock, precondition, pure mutator, render, post-check, write).
import type { DocUpdatedEvent } from '../../../preload/contract';
import { LibraryError, type DocumentMeta } from '../../library';
import { estimateTokens, sectionText, type DocumentDraftTab, type SectionDraft } from '../../llm';
import { PipelineFailure, type SectionRunContext, type SectionRunner } from '../../pipeline';
import { canonicalJson } from '../canonical-json';
import { DocumentBuildError, DocumentFormatError, DocumentMutationError, TooManyTabsError } from '../errors';
import { sectionIdsOf } from '../ids';
import { addSectionEli5Tab, getSectionContext, replaceSection } from '../mutate';
import { parseDocument } from '../parse';
import { renderDocument } from '../render';
import type { DocumentModel, ParsedDocument, Section, SectionContext, SectionJobPayload, Tab } from '../types';
import { sectionHash } from './hash';
import { changeLabel, mirrorTabs, type ResolvedDeps } from './types';

/** 08 §6.2 step 5: target plus neighbours may use 60% of the input budget. */
export const SECTION_BUDGET_SHARE = 0.6;
/** 08 §6.2 step 5: a shrunk neighbour keeps its heading and its first 1500 characters. */
export const NEIGHBOUR_CHARS = 1500;

export interface RunnerEnv {
  deps: ResolvedDeps;
  /**
   * 08 §8.1: true when this job holds (or can take) its section's busy key. False for a status-line
   * retry queued while another action holds the section.
   */
  claim(p: SectionJobPayload, jobId: string): boolean;
  /** Lock released and the write done: drop this job's busy key, broadcast, emit updated (08 §6.4 step 8). */
  committed(p: SectionJobPayload, jobId: string, e: DocUpdatedEvent): void;
  /** True once for a job the user retried: its baseHash is re-taken (08 §9 "fresh baseHash"). */
  consumeRetry(jobId: string): boolean;
}

const corrupt = (): PipelineFailure => new PipelineFailure('INTERNAL', 'document_corrupt');

function findSection(model: DocumentModel, id: string): { tab: Tab; section: Section } | undefined {
  for (const tab of model.tabs) {
    const section = tab.sections.find((s) => s.id === id);
    if (section) return { tab, section };
  }
  return undefined;
}

/** Reads and parses index.html: DOC_GONE when missing, INTERNAL document_corrupt when invalid. */
async function readDoc(d: ResolvedDeps, slug: string): Promise<ParsedDocument> {
  if (!d.library.hasSlug(slug)) throw new PipelineFailure('DOC_GONE');
  let html: string;
  try {
    html = await d.readFile(d.library.docPath(slug));
  } catch {
    throw new PipelineFailure('DOC_GONE');
  }
  try {
    return parseDocument(html);
  } catch (err) {
    if (err instanceof DocumentFormatError) throw corrupt();
    throw err;
  }
}

const tokens = (d: SectionDraft | undefined): number => (d ? estimateTokens(JSON.stringify(d)) : 0);

function shrink(d: SectionDraft): SectionDraft {
  const body = sectionText({ heading: '', blocks: d.blocks }).trim().slice(0, NEIGHBOUR_CHARS);
  return { heading: d.heading, blocks: body ? [{ type: 'paragraph', md: body }] : [] };
}

/** 08 §6.2 step 5: shrink neighbours to fit; SECTION_TOO_LARGE when the target alone cannot. */
function fitBudget(ctx: SectionContext, budgetTokens: number | undefined): Pick<SectionContext, 'prev' | 'next'> {
  const { prev, next } = ctx;
  if (budgetTokens === undefined) return { ...(prev ? { prev } : {}), ...(next ? { next } : {}) };
  const limit = Math.floor(budgetTokens * SECTION_BUDGET_SHARE);
  const own = tokens(ctx.draft);
  if (own > limit) throw new PipelineFailure('SECTION_TOO_LARGE');
  if (own + tokens(prev) + tokens(next) <= limit) return { ...(prev ? { prev } : {}), ...(next ? { next } : {}) };
  return { ...(prev ? { prev: shrink(prev) } : {}), ...(next ? { next: shrink(next) } : {}) };
}

const isTabDraft = (v: unknown): v is DocumentDraftTab =>
  typeof v === 'object' && v !== null && Array.isArray((v as { sections?: unknown }).sections);
const isSectionDraft = (v: unknown): v is SectionDraft =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { heading?: unknown }).heading === 'string' &&
  Array.isArray((v as { blocks?: unknown }).blocks);

/**
 * Generating stage (08 §6.2): context from the embedded model, then one LLM call. Also returns the
 * target's current hash, which a user retry uses as its baseHash.
 */
async function generate(
  env: RunnerEnv,
  p: SectionJobPayload,
  signal: AbortSignal,
): Promise<{ draft: SectionDraft | DocumentDraftTab; currentHash: string }> {
  const d = env.deps;
  const { model } = await readDoc(d, p.slug);
  let ctx: SectionContext;
  try {
    ctx = getSectionContext(model, p.sectionId);
  } catch (err) {
    if (err instanceof DocumentMutationError) throw new PipelineFailure('SECTION_GONE');
    throw err;
  }
  const around = fitBudget(ctx, d.inputBudgetTokens?.());
  // sourceExcerpt (08 §6.2 step 4) is omitted: 09 retains no extracted source text in v1.
  const out: unknown = await d.tasks.runSectionAction({
    action: p.action,
    tabKind: ctx.tab.kind,
    section: ctx.draft,
    outline: ctx.outline,
    ...around,
    selection: p.selectionText,
    ...(p.note ? { note: p.note } : {}),
    signal,
  });
  const ok = p.action === 'eli5-tab' ? isTabDraft(out) : isSectionDraft(out) && !isTabDraft(out);
  if (!ok) throw new PipelineFailure('INTERNAL', 'invalid_output');
  return { draft: out as SectionDraft | DocumentDraftTab, currentHash: sectionHash(ctx.section) };
}

/** 08 §6.4 step 6 / §7.1 step 4: the rendered file parses and keeps every pre-existing SectionId. */
function postCheck(out: string, before: DocumentModel, next: DocumentModel, target?: string): void {
  let reparsed: DocumentModel;
  try {
    reparsed = parseDocument(out).model;
  } catch {
    throw corrupt();
  }
  const ids = [...sectionIdsOf(reparsed.tabs)];
  const expected = [...sectionIdsOf(next.tabs)];
  if (canonicalJson(ids) !== canonicalJson(expected)) throw corrupt();
  const kept = new Set(ids);
  for (const id of sectionIdsOf(before.tabs)) if (!kept.has(id)) throw corrupt();
  if (target !== undefined) {
    const a = findSection(reparsed, target)?.section;
    const b = findSection(next, target)?.section;
    if (!a || !b || canonicalJson(a) !== canonicalJson(b)) throw corrupt();
  } else if (reparsed.tabs.at(-1)?.key !== next.tabs.at(-1)?.key) {
    throw corrupt();
  }
}

/** Mutator errors that mean the model output was unusable (07 §5.1 step 3). */
function mutationFailure(err: unknown): never {
  if (err instanceof TooManyTabsError) throw new PipelineFailure('TOO_MANY_TABS');
  if (err instanceof DocumentBuildError) throw new PipelineFailure('INTERNAL', 'invalid_output');
  if (err instanceof DocumentMutationError) throw new PipelineFailure('SECTION_GONE');
  throw err;
}

interface Planned {
  html: string;
  meta: (m: DocumentMeta) => DocumentMeta;
  event: DocUpdatedEvent;
  tabLabel?: string;
  /** Undo label for the prior version (08 §6.7). */
  label: string;
}

/** Saving stage body, under withDocLock (08 §6.4 steps 1-6, §7.1 steps 1-4). */
async function plan(
  env: RunnerEnv,
  p: SectionJobPayload,
  jobId: string,
  draft: SectionDraft | DocumentDraftTab,
  baseHash: string,
  now: string,
): Promise<Planned> {
  const d = env.deps;
  const parsed = await readDoc(d, p.slug);
  const { model, assets } = parsed;
  const hit = findSection(model, p.sectionId);
  if (!hit) throw new PipelineFailure('SECTION_GONE');
  const renderOpts = { runtime: parsed.runtime, theme: parsed.theme };
  const entry = {
    at: now,
    action: p.action,
    sectionId: p.sectionId,
    tabKey: p.tabKey,
    ...(p.note ? { note: p.note } : {}),
    jobId,
  };
  if (p.action === 'eli5-tab') {
    const retiredIds = (await d.library.getMeta(p.slug)).retiredIds ?? [];
    let added: { model: DocumentModel; tabKey: string; warnings: string[] };
    try {
      added = addSectionEli5Tab(model, p.sectionId, p.selectionText, draft as DocumentDraftTab, now, {
        idSource: d.sectionIds,
        retiredIds,
        assets,
      });
    } catch (err) {
      mutationFailure(err);
    }
    for (const w of added.warnings) d.log?.warn('document.section-warning', { slug: p.slug, code: w });
    const html = renderDocument(added.model, assets, renderOpts);
    postCheck(html, model, added.model);
    const next = added.model;
    return {
      html,
      meta: (m) => ({
        ...m,
        tabs: mirrorTabs(next.tabs),
        actions: [...(m.actions ?? []), { ...entry, resultTabKey: added.tabKey }],
      }),
      event: { slug: p.slug, tabKey: added.tabKey },
      tabLabel: next.tabs.at(-1)?.label ?? '',
      label: changeLabel('eli5-tab', next.tabs.at(-1)?.label ?? ''),
    };
  }
  // 08 §6.4 step 3: a mismatch means something outside this feature changed it; the newer wins.
  if (sectionHash(hit.section) !== baseHash) throw new PipelineFailure('SECTION_CHANGED');
  let replaced: { model: DocumentModel; warnings: string[] };
  try {
    replaced = replaceSection(model, p.sectionId, draft as SectionDraft, p.action, now, {
      idSource: d.sectionIds,
      assets,
    });
  } catch (err) {
    mutationFailure(err);
  }
  // 08 §6.5 rule 1: dropped glossary notes arrive as 'glossary-dropped' warnings.
  for (const w of replaced.warnings) {
    d.log?.warn('document.section-warning', { slug: p.slug, sectionId: p.sectionId, code: w });
  }
  const html = renderDocument(replaced.model, assets, renderOpts);
  postCheck(html, model, replaced.model, p.sectionId);
  const next = replaced.model;
  return {
    html,
    meta: (m) => ({ ...m, tabs: mirrorTabs(next.tabs), actions: [...(m.actions ?? []), entry] }),
    event: { slug: p.slug, sectionId: p.sectionId, tabKey: p.tabKey },
    label: changeLabel(p.action, hit.section.heading),
  };
}

type RunResult = Awaited<ReturnType<SectionRunner>>;
interface Committed {
  out: RunResult;
  event: DocUpdatedEvent;
}

/**
 * 06 §9.4: a job resumed after a crash between its write and the persisted `done` finds its own
 * meta.json actions entry. It then commits nothing again (no LLM call, no second tab or entry).
 */
async function alreadyCommitted(d: ResolvedDeps, p: SectionJobPayload, jobId: string): Promise<Committed | undefined> {
  let m: DocumentMeta;
  try {
    m = await d.library.getMeta(p.slug);
  } catch {
    return undefined; // DOC_GONE and friends surface from the normal path.
  }
  const a = m.actions?.find((x) => x.jobId === jobId);
  if (!a) return undefined;
  const result = { docId: m.id, topicSlug: m.topicSlug, title: m.title };
  if (a.resultTabKey !== undefined) {
    const tabLabel = m.tabs.find((t) => t.key === a.resultTabKey)?.label ?? '';
    return { out: { result, tabLabel }, event: { slug: p.slug, tabKey: a.resultTabKey } };
  }
  return { out: { result }, event: { slug: p.slug, sectionId: p.sectionId, tabKey: p.tabKey } };
}

/** 08 §6.4 step 7: one updateDocument call; failures leave both files unchanged (09). */
async function write(d: ResolvedDeps, slug: string, planned: Planned) {
  try {
    return await d.library.updateDocument(slug, { html: planned.html, meta: planned.meta, label: planned.label });
  } catch (err) {
    if (err instanceof LibraryError && err.code === 'NOT_FOUND') throw new PipelineFailure('DOC_GONE');
    const detail = err instanceof LibraryError ? `library:${err.code}` : 'write';
    throw new PipelineFailure('SAVE_FAILED', detail);
  }
}

/** The Section-lane executor plugged into the JobQueue (06 §8.2). */
export function createSectionRunner(env: RunnerEnv): SectionRunner {
  return async (ctx: SectionRunContext) => {
    const p = ctx.job.section;
    if (!p) throw new PipelineFailure('INTERNAL', 'no-section-payload');
    const jobId = ctx.job.id;
    const d = env.deps;
    const fresh = env.consumeRetry(jobId);
    // 08 §8.1: one action per section; a retry queued behind another action on it fails fast.
    if (!env.claim(p, jobId)) throw new PipelineFailure('SECTION_CHANGED', 'section_busy');
    const done = (c: Committed): RunResult => {
      env.committed(p, jobId, c.event);
      return c.out;
    };
    const prior = await alreadyCommitted(d, p, jobId);
    if (prior) return done(prior);
    const { draft, currentHash } = await generate(env, p, ctx.signal);
    const baseHash = fresh ? currentHash : p.baseHash;
    await ctx.enterSaving();
    const c = await d.library.withDocLock(p.slug, async (): Promise<Committed> => {
      const again = await alreadyCommitted(d, p, jobId);
      if (again) return again;
      const now = d.clock.now().toISOString();
      const planned = await plan(env, p, jobId, draft, baseHash, now);
      ctx.markCommitStarted();
      const entry = await write(d, p.slug, planned);
      return {
        out: {
          result: { docId: entry.id, topicSlug: entry.topicSlug, title: entry.title },
          ...(planned.tabLabel !== undefined ? { tabLabel: planned.tabLabel } : {}),
        },
        event: planned.event,
      };
    });
    return done(c);
  };
}
