// Section runner (08 §6.2-§6.4, §7.1): generating stage (context + LLM), then the saving stage
// (re-read and re-parse under withDocLock, precondition, pure mutator, render, post-check, write).
import type { DocUpdatedEvent } from '../../../preload/contract';
import { LibraryError, sourcesForMeta, type DocumentMeta, type SourceSidecar, type VersionChange } from '../../library';
import {
  DeepContextTooLargeError,
  estimateTokens,
  sectionText,
  type DeepAskSource,
  type DocumentDraftTab,
  type SectionAnswerDraft,
  type SectionDeeperAnswerDraft,
  type SectionDraft,
} from '../../llm';
import { PipelineFailure, type SectionRunContext, type SectionRunner } from '../../pipeline';
import { canonicalJson } from '../canonical-json';
import { DocumentBuildError, DocumentFormatError, DocumentMutationError, TooManyTabsError } from '../errors';
import { collapseWs } from '../html';
import { sectionIdsOf } from '../ids';
import {
  addSectionEli5Tab,
  getSectionContext,
  inDepthForAsk,
  insertAnswer,
  replaceSection,
  tabsForDeepAsk,
} from '../mutate';
import { parseDocument } from '../parse';
import { renderDocument } from '../render';
import { DOC_RUNTIME_VERSION, compareRuntimeVersions } from '../runtime-assets';
import type {
  AnswerSourceMode,
  DocRuntime,
  DocumentModel,
  ParsedDocument,
  Section,
  SectionContext,
  SectionJobPayload,
  Tab,
} from '../types';
import { isUserQuestion } from '../validate';
import { sectionHash } from './hash';
import { blockIndexOfSelection, selectionContext } from './selection-context';
import { changeLabel, mirrorTabs, type ResolvedDeps } from './types';

/** 08 §6.2 step 5: target plus neighbours may use 60% of the input budget. */
export const SECTION_BUDGET_SHARE = 0.6;
/** 08 §6.2 step 5: a shrunk neighbour keeps its heading and its first 1500 characters. */
export const NEIGHBOUR_CHARS = 1500;
/** At most this many In depth sections go along with an action on a Deadpan section. */
export const FACT_SECTIONS = 3;

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

export { compareRuntimeVersions };

/**
 * D12 (07 §5.5): the runtime a re-render of `parsed` uses. A document whose runtime is older than
 * the bundled one gets the bundled runtime (and its version stamped on the model); otherwise its
 * own stays. When the bundled runtime is missing (no build pre-step) the document keeps its own.
 */
export function runtimeFor(
  parsed: Pick<ParsedDocument, 'model' | 'runtime'>,
  bundled: () => DocRuntime,
): { runtime: DocRuntime; upgraded: boolean; stamp(m: DocumentModel): DocumentModel } {
  const keep = { runtime: parsed.runtime, upgraded: false, stamp: (m: DocumentModel) => m };
  if (compareRuntimeVersions(parsed.model.generator.runtimeVersion, DOC_RUNTIME_VERSION) >= 0) return keep;
  let runtime: DocRuntime;
  try {
    runtime = bundled();
  } catch {
    return keep;
  }
  return {
    runtime,
    upgraded: true,
    stamp: (m) => ({ ...m, generator: { ...m.generator, runtimeVersion: DOC_RUNTIME_VERSION } }),
  };
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

/**
 * The In depth sections a Deadpan section's facts come from (08 Ask, §6.3): the tab retells In depth
 * section by section, so the one at the same position first, then its neighbours outwards, while
 * they fit in `budgetTokens`; at most FACT_SECTIONS, in document order. A counterpart too large on
 * its own goes shrunk, like a neighbour; nothing when even that does not fit. Undefined for every
 * other tab, or when In depth has no content.
 */
function factSectionsFor(
  model: DocumentModel,
  ctx: SectionContext,
  budgetTokens: number | undefined,
): SectionDraft[] | undefined {
  if (ctx.tab.kind !== 'deadpan') return undefined;
  const all = inDepthForAsk(model)?.sections;
  if (!all?.length) return undefined;
  const at = ctx.tab.sections.filter((s) => s.kind === 'content').findIndex((s) => s.id === ctx.section.id);
  const centre = Math.min(Math.max(at, 0), all.length - 1);
  const order = [centre];
  for (let k = 1; order.length < Math.min(FACT_SECTIONS, all.length); k++) {
    if (centre - k >= 0) order.push(centre - k);
    if (centre + k < all.length && order.length < FACT_SECTIONS) order.push(centre + k);
  }
  const picked = new Map<number, SectionDraft>();
  let left = budgetTokens ?? Infinity;
  for (const i of order) {
    const whole = all[i] as SectionDraft;
    const d = tokens(whole) <= left ? whole : i === centre ? shrink(whole) : undefined;
    if (!d || tokens(d) > left) break;
    picked.set(i, d);
    left -= tokens(d);
  }
  const out = [...picked.keys()].sort((a, b) => a - b).map((i) => picked.get(i) as SectionDraft);
  return out.length ? out : undefined;
}

/** What is left of the section share once the section and its (fitted) neighbours are counted. */
function factBudget(
  budgetTokens: number | undefined,
  ...used: (SectionDraft | string | undefined)[]
): number | undefined {
  if (budgetTokens === undefined) return undefined;
  const spent = used.reduce((n, u) => n + (typeof u === 'string' ? estimateTokens(u) : tokens(u)), 0);
  return Math.max(0, Math.floor(budgetTokens * SECTION_BUDGET_SHARE) - spent);
}

const isTabDraft = (v: unknown): v is DocumentDraftTab =>
  typeof v === 'object' && v !== null && Array.isArray((v as { sections?: unknown }).sections);
const isSectionDraft = (v: unknown): v is SectionDraft =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { heading?: unknown }).heading === 'string' &&
  Array.isArray((v as { blocks?: unknown }).blocks);

/** An answer paragraph insertAnswer keeps: some text, and not a question back to the reader. */
const keptParagraph = (p: unknown): p is string =>
  typeof p === 'string' && collapseWs(p) !== '' && !isUserQuestion(p.trim());

/** 08 Ask: a topic and at least one answer paragraph insertAnswer will keep. */
const isAnswerDraft = (v: unknown): v is SectionAnswerDraft =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { topic?: unknown }).topic === 'string' &&
  Array.isArray((v as { paragraphs?: unknown }).paragraphs) &&
  (v as { paragraphs: unknown[] }).paragraphs.some(keptParagraph);

type Draft = SectionDraft | DocumentDraftTab | SectionAnswerDraft;

/**
 * 08 §6.9 (decision 8): the kept texts a Deep Ask may use are the sidecar entries that match a record
 * of the live meta.sourcesUsed. Entries without text (images, omitted, unreadable) and records with
 * no entry at all are listed with `text: null`, once each. null: no sidecar at all.
 */
export function deepAskSources(
  sidecar: SourceSidecar | null,
  used: DocumentMeta['sourcesUsed'],
): DeepAskSource[] | null {
  if (sidecar === null) return null;
  const m = sourcesForMeta(sidecar, used);
  // Records that match no entry at all (with or without text): every entry counts as present.
  const anyText = Object.fromEntries(sidecar.manifest.sources.map((e) => [e.id, '']));
  const unmatched = sourcesForMeta({ manifest: sidecar.manifest, texts: anyText }, used).missing;
  return [
    ...m.entries.map((e) => ({
      id: e.id,
      ref: e.ref,
      label: e.label,
      format: e.format,
      text: m.texts[e.id] ?? null,
      truncated: e.truncated,
    })),
    ...unmatched.map((s, i) => ({
      id: `missing-${i + 1}`,
      ref: s.ref,
      label: s.ref,
      format: 'unknown',
      text: null,
      truncated: false,
    })),
  ];
}

interface Generated {
  draft: Draft;
  currentHash: string;
  /** Deep Ask only: what the answer was checked against (the box badge). */
  sourceMode?: AnswerSourceMode;
}

/**
 * Generating stage (08 §6.2): context from the embedded model, then one LLM call. Also returns the
 * target's current hash, which a user retry uses as its baseHash.
 */
async function generate(env: RunnerEnv, p: SectionJobPayload, signal: AbortSignal): Promise<Generated> {
  const d = env.deps;
  const { model } = await readDoc(d, p.slug);
  let ctx: SectionContext;
  try {
    ctx = getSectionContext(model, p.sectionId);
  } catch (err) {
    if (err instanceof DocumentMutationError) throw new PipelineFailure('SECTION_GONE');
    throw err;
  }
  if (p.action === 'ask') {
    if (!p.question?.trim()) throw new PipelineFailure('INTERNAL', 'no_question');
    // 08 Ask: the section, its neighbours (budgeted like a rewrite), the selection and the question.
    // On a Deadpan section the answer keeps the tone but its facts come only from the material, so
    // a quick ask also carries the In depth sections it retells, in what is left of the section
    // budget (deep and deeper get In depth through `tabs`, which never holds the Deadpan tab).
    const budget = d.inputBudgetTokens?.();
    const near = fitBudget(ctx, budget);
    const facts =
      p.depth !== 'deep' && p.depth !== 'deeper'
        ? factSectionsFor(model, ctx, factBudget(budget, ctx.draft, near.prev, near.next))
        : undefined;
    const local = {
      tabKind: ctx.tab.kind,
      section: ctx.draft,
      outline: ctx.outline,
      ...near,
      selection: p.selectionText,
      question: p.question,
      ...(facts ? { factSections: facts } : {}),
      signal,
    };
    let out: unknown;
    let sourceMode: AnswerSourceMode | undefined;
    if (p.depth === 'deeper' && d.tasks.answerDeeperQuestion) {
      // 08 §6.10: the same material as Ask deep, then the web and general knowledge, each marked.
      const tabs = tabsForDeepAsk(model);
      const sidecar = (await d.library.readSources?.(p.slug)) ?? null;
      const used = sidecar === null ? [] : (await d.library.getMeta(p.slug)).sourcesUsed;
      const sources = deepAskSources(sidecar, used);
      try {
        const r = await d.tasks.answerDeeperQuestion({ ...local, tabs, sources });
        // Counts only: never the question, the answer or a URL (08 §6.10 step 8).
        d.log?.info('document.deep-ask', {
          slug: p.slug,
          sectionId: p.sectionId,
          kind: 'deeper',
          sourceMode: r.plan.sourceMode,
          count: r.plan.chunks,
          inputTokens: r.plan.inputTokens,
          webSearches: r.webSearches,
          webKept: r.draft.web.length,
        });
        out = r.draft;
        sourceMode = r.plan.sourceMode;
      } catch (err) {
        if (err instanceof DeepContextTooLargeError) throw new PipelineFailure('SECTION_TOO_LARGE', 'deep_context');
        throw err;
      }
    } else if (p.depth === 'deep' || p.depth === 'deeper') {
      // 08 §6.9: also every tab and the kept source text the live meta still uses.
      const tabs = tabsForDeepAsk(model);
      const sidecar = (await d.library.readSources?.(p.slug)) ?? null;
      const used = sidecar === null ? [] : (await d.library.getMeta(p.slug)).sourcesUsed;
      const sources = deepAskSources(sidecar, used);
      try {
        const r = await d.tasks.answerDeepQuestion({ ...local, tabs, sources });
        d.log?.info('document.deep-ask', {
          slug: p.slug,
          sectionId: p.sectionId,
          kind: r.plan.sourceMode,
          count: r.plan.chunks,
          inputTokens: r.plan.inputTokens,
        });
        out = r.draft;
        sourceMode = r.plan.sourceMode;
      } catch (err) {
        if (err instanceof DeepContextTooLargeError) throw new PipelineFailure('SECTION_TOO_LARGE', 'deep_context');
        throw err;
      }
    } else {
      out = await d.tasks.answerSectionQuestion(local);
    }
    // No paragraph left after insertAnswer's filter: the output is unusable (no OUTPUT_INVALID code).
    if (!isAnswerDraft(out)) throw new PipelineFailure('INTERNAL', 'invalid_output');
    return { draft: out, currentHash: sectionHash(ctx.section), ...(sourceMode ? { sourceMode } : {}) };
  }
  const focused = p.action === 'eli5-selection';
  const budget = d.inputBudgetTokens?.();
  // 08 §7.5: a selection ELI5 sends the selection plus brief context, never the neighbours.
  const around: Pick<SectionContext, 'prev' | 'next'> & { context?: string } = focused
    ? { context: selectionContext(model, p.sectionIds ?? [p.sectionId], p.selectionText) }
    : fitBudget(ctx, budget);
  // A Deadpan section's facts (kept or added) come from the In depth sections it retells.
  const facts = factSectionsFor(model, ctx, factBudget(budget, ctx.draft, around.prev, around.next, around.context));
  // sourceExcerpt (08 §6.2 step 4) is omitted: only Deep Ask reads the kept source text (08 §6.9).
  const out: unknown = await d.tasks.runSectionAction({
    action: p.action,
    tabKind: ctx.tab.kind,
    section: ctx.draft,
    outline: ctx.outline,
    ...around,
    selection: p.selectionText,
    ...(p.note ? { note: p.note } : {}),
    ...(facts ? { factSections: facts } : {}),
    signal,
  });
  const ok = p.action === 'eli5-tab' || focused ? isTabDraft(out) : isSectionDraft(out) && !isTabDraft(out);
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
  /** Undo label of the version this creates (08 §6.7). */
  label: string;
  /** What the new version node records (09 §4.1). */
  change: VersionChange;
}

/** Saving stage body, under withDocLock (08 §6.4 steps 1-6, §7.1 steps 1-4). */
async function plan(
  env: RunnerEnv,
  p: SectionJobPayload,
  jobId: string,
  draft: Draft,
  baseHash: string,
  now: string,
  sourceMode?: AnswerSourceMode,
): Promise<Planned> {
  const d = env.deps;
  const parsed = await readDoc(d, p.slug);
  const { model, assets } = parsed;
  const hit = findSection(model, p.sectionId);
  if (!hit) throw new PipelineFailure('SECTION_GONE');
  const rt = runtimeFor(parsed, d.bundledRuntime);
  const renderOpts = { runtime: rt.runtime, theme: parsed.theme };
  const here = { tabKey: p.tabKey, sectionId: p.sectionId };
  if (p.action === 'ask') {
    // 08 Ask: an answer box goes after the passage asked about; the rest of the document is unchanged.
    if (sectionHash(hit.section) !== baseHash) throw new PipelineFailure('SECTION_CHANGED');
    const answer = draft as SectionAnswerDraft;
    const question = p.question ?? '';
    // 08 §6.9 / §6.10: an unknown depth (never expected) is answered and stored as quick.
    const depth = p.depth === 'deep' || p.depth === 'deeper' ? p.depth : undefined;
    const deeper = depth === 'deeper' ? (answer as Partial<SectionDeeperAnswerDraft>) : undefined;
    const retiredIds = (await d.library.getMeta(p.slug)).retiredIds ?? [];
    let inserted: { model: DocumentModel; qaId: string };
    try {
      inserted = insertAnswer(
        model,
        p.sectionId,
        blockIndexOfSelection(model, hit.section, p.selectionText),
        {
          question,
          topic: answer.topic,
          quote: p.selectionText,
          paragraphs: answer.paragraphs,
          // 08 §6.9: a missing mode (never expected) shows the honest "tabs only" badge.
          ...(depth ? { depth, sources: sourceMode ?? 'none' } : {}),
          ...(deeper?.reach ? { reach: deeper.reach } : {}),
          ...(deeper?.web ? { web: deeper.web } : {}),
        },
        now,
        { idSource: d.sectionIds, retiredIds },
      );
    } catch (err) {
      mutationFailure(err);
    }
    const { qaId } = inserted;
    const next = rt.stamp(inserted.model);
    const html = renderDocument(next, assets, renderOpts);
    postCheck(html, model, next, p.sectionId);
    const box = findSection(next, p.sectionId)?.section.blocks.find((b) => b.type === 'qa' && b.id === qaId);
    // The box holds the question and topic as stored (whitespace collapsed, capped).
    const stored = box?.type === 'qa' ? box : { topic: answer.topic, question };
    const { topic } = stored;
    const asked = {
      at: now,
      sectionId: p.sectionId,
      tabKey: p.tabKey,
      question: stored.question,
      qaId,
      jobId,
      ...(depth ? { depth } : {}),
    };
    return {
      html,
      meta: (m) => ({ ...m, tabs: mirrorTabs(next.tabs), asks: [...(m.asks ?? []), asked] }),
      event: { slug: p.slug, sectionId: p.sectionId, tabKey: p.tabKey, anchorId: qaId },
      label: changeLabel('ask', topic, { depth }),
      change: {
        kind: 'ask',
        topic,
        heading: hit.section.heading,
        question: stored.question,
        target: { ...here, anchorId: qaId },
        undoTarget: here,
        jobId,
        ...(depth ? { depth } : {}),
      },
    };
  }
  const entry = {
    at: now,
    action: p.action,
    sectionId: p.sectionId,
    tabKey: p.tabKey,
    ...(p.note ? { note: p.note } : {}),
    jobId,
  };
  if (p.action === 'eli5-tab' || p.action === 'eli5-selection') {
    const retiredIds = (await d.library.getMeta(p.slug)).retiredIds ?? [];
    const covered = p.action === 'eli5-selection' ? (p.sectionIds ?? [p.sectionId]) : undefined;
    let added: { model: DocumentModel; tabKey: string; warnings: string[] };
    try {
      added = addSectionEli5Tab(model, p.sectionId, p.selectionText, draft as DocumentDraftTab, now, {
        idSource: d.sectionIds,
        retiredIds,
        assets,
        ...(covered ? { selectionOf: covered } : {}),
      });
    } catch (err) {
      mutationFailure(err);
    }
    for (const w of added.warnings) d.log?.warn('document.section-warning', { slug: p.slug, code: w });
    const next = rt.stamp(added.model);
    const html = renderDocument(next, assets, renderOpts);
    postCheck(html, model, next);
    const tabLabel = next.tabs.at(-1)?.label ?? '';
    return {
      html,
      meta: (m) => ({
        ...m,
        tabs: mirrorTabs(next.tabs),
        actions: [
          ...(m.actions ?? []),
          { ...entry, ...(covered ? { sectionIds: covered } : {}), resultTabKey: added.tabKey },
        ],
      }),
      event: { slug: p.slug, tabKey: added.tabKey },
      tabLabel,
      label: changeLabel(p.action, tabLabel),
      change: {
        kind: p.action,
        topic: tabLabel,
        heading: hit.section.heading,
        target: { tabKey: added.tabKey },
        undoTarget: here,
        jobId,
      },
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
  const next = rt.stamp(replaced.model);
  const html = renderDocument(next, assets, renderOpts);
  postCheck(html, model, next, p.sectionId);
  return {
    html,
    meta: (m) => ({ ...m, tabs: mirrorTabs(next.tabs), actions: [...(m.actions ?? []), entry] }),
    event: { slug: p.slug, sectionId: p.sectionId, tabKey: p.tabKey },
    label: changeLabel(p.action, hit.section.heading),
    change: {
      kind: p.action,
      topic: hit.section.heading,
      heading: hit.section.heading,
      target: here,
      undoTarget: here,
      jobId,
    },
  };
}

type RunResult = Awaited<ReturnType<SectionRunner>>;
interface Committed {
  out: RunResult;
  event: DocUpdatedEvent;
}

/**
 * 06 §9.4: a job resumed after a crash between its write and the persisted `done` finds its own
 * meta.json actions (or, for an Ask, asks) entry. It then commits nothing again (no LLM call, no
 * second tab, answer box or entry).
 */
async function alreadyCommitted(d: ResolvedDeps, p: SectionJobPayload, jobId: string): Promise<Committed | undefined> {
  let m: DocumentMeta;
  try {
    m = await d.library.getMeta(p.slug);
  } catch {
    return undefined; // DOC_GONE and friends surface from the normal path.
  }
  const result = { docId: m.id, topicSlug: m.topicSlug, title: m.title };
  const asked = m.asks?.find((x) => x.jobId === jobId);
  if (asked) {
    return {
      out: { result },
      event: { slug: p.slug, sectionId: asked.sectionId, tabKey: asked.tabKey, anchorId: asked.qaId },
    };
  }
  const a = m.actions?.find((x) => x.jobId === jobId);
  if (!a) return undefined;
  if (a.resultTabKey !== undefined) {
    const tabLabel = m.tabs.find((t) => t.key === a.resultTabKey)?.label ?? '';
    return { out: { result, tabLabel }, event: { slug: p.slug, tabKey: a.resultTabKey } };
  }
  return { out: { result }, event: { slug: p.slug, sectionId: p.sectionId, tabKey: p.tabKey } };
}

/** 08 §6.4 step 7: one updateDocument call; failures leave both files unchanged (09). */
async function write(d: ResolvedDeps, slug: string, planned: Planned) {
  try {
    return await d.library.updateDocument(slug, {
      html: planned.html,
      meta: planned.meta,
      label: planned.label,
      change: planned.change,
    });
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
    const { draft, currentHash, sourceMode } = await generate(env, p, ctx.signal);
    const baseHash = fresh ? currentHash : p.baseHash;
    await ctx.enterSaving();
    const c = await d.library.withDocLock(p.slug, async (): Promise<Committed> => {
      const again = await alreadyCommitted(d, p, jobId);
      if (again) return again;
      const now = d.clock.now().toISOString();
      const planned = await plan(env, p, jobId, draft, baseHash, now, sourceMode);
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
