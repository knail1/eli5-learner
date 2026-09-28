import type { Settings } from '../config';
import type { TabKind } from '../document';
import type { ExtractedContent } from '../extract';
import { log } from '../security';
import type { SkippedSource } from '../sources';
import {
  contentToPromptText,
  contentUnits,
  estimateTokens,
  inputBudget,
  planChunks,
  renderChunk,
  visibleOutput,
  wrapSource,
} from './budget';
import { LLMError } from './errors';
import { prepareImages, toImageInput, type ImageReencoder } from './images';
import { defaultPromptPolicy } from './policy';
import type { PromptCatalogue } from './prompts';
import { cancelled } from './retry';
import type {
  ChunkNotes,
  DocumentDraftTab,
  DraftSchemaName,
  GlossaryDraft,
  MergeMatchDraft,
  SectionDraft,
  SummaryDraft,
} from './schemas/draft';
import { FALLBACK_SKILL_TEXT, type SkillLibrary, type SkillSlot, type SkillTask } from './skills';
import { addUsage, generateStructured, OutputTruncated, ZERO_USAGE, type DraftOf } from './structured';
import type { GenerationRequest, ImageInput, LLMProvider, PromptId, PromptPolicy, TokenUsage } from './types';

/**
 * Task functions (02 §12): the only surface other main-process modules call. Each step makes one
 * logical call (plus the repair pass and the output-overflow retry), throws LLMError on failure, and
 * leaves the fail/degrade decision to 06. Steps read only prompts and skills; they write nothing.
 */

export interface PreparedContent {
  mode: 'raw' | 'notes';
  /** mode 'raw': the extracted content with image bytes removed (they live in `images`). */
  contents?: ExtractedContent[];
  /** mode 'notes' */
  notes?: ChunkNotes[];
  /** Serialized, delimited content (raw) or notes that the writing prompts receive. */
  promptText: string;
  images: ImageInput[];
  sourceList: { ref: string; label: string }[];
  skipped: SkippedSource[];
  warnings: string[];
  usage: TokenUsage;
  prompts: string[];
}

export interface StepCtx {
  clarifyingInput: string;
  signal: AbortSignal;
  onRetry?: (attempt: number, waitMs: number) => void;
}

export interface StepResult<T> {
  draft: T;
  usage: TokenUsage;
  prompt: string; // "id@version"
}

export type SectionAction = 'expand' | 'reexplain' | 'analogy' | 'deeper' | 'eli5-tab';

export interface SectionActionInput {
  action: SectionAction;
  tabKind: TabKind;
  section: SectionDraft;
  outline: string[];
  prev?: SectionDraft;
  next?: SectionDraft;
  selection: string;
  note?: string;
  sourceExcerpt?: string;
  signal: AbortSignal;
}

export interface MergeCandidate {
  catalogId: string;
  title: string;
  summary: string;
}

export interface TaskDeps {
  /** The active provider (registry.llm()); resolved per call so settings changes apply. */
  provider: () => LLMProvider;
  prompts: PromptCatalogue;
  skills?: SkillLibrary;
  /** HOOK-LLM-02 prompt policy (registry.promptPolicy()); default pass-through. */
  policy?: () => PromptPolicy;
  settings: () => Pick<Settings, 'llm'>;
  reencodeImage?: ImageReencoder;
}

export const MODEL_ERROR_WHILE_READING = 'model error while reading';
export const MAX_REDUCE_LEVELS = 2;
export const MERGE_MAX_CANDIDATES = 8;
export const SUMMARY_EXCERPT_TOKENS = 2000;

const ACTION_PROMPT: Record<SectionAction, PromptId> = {
  expand: 'section-expand',
  reexplain: 'section-reexplain',
  analogy: 'section-analogy',
  deeper: 'section-deeper',
  'eli5-tab': 'section-eli5-tab',
};

const CONTENT_MODE = {
  raw: 'the original source content',
  notes:
    'condensed notes taken from sources too long to read in one pass. You are reading notes, not the sources: do not invent detail the notes lack',
} as const;

/** Task kind for a skill's `appliesTo` front matter (02 §11). */
function skillTask(id: PromptId): SkillTask | undefined {
  if (id === 'in-depth') return 'indepth';
  if (id === 'eli5') return 'eli5';
  return id.startsWith('section-') ? 'section' : undefined;
}

// ---- text helpers ----

export function sectionText(s: SectionDraft): string {
  const lines = [s.heading];
  for (const b of s.blocks) {
    switch (b.type) {
      case 'paragraph':
      case 'analogy':
      case 'callout':
        lines.push(b.md);
        break;
      case 'list':
        lines.push(...b.items.map((i) => `- ${i}`));
        break;
      case 'pullquote':
        lines.push(`"${b.text}"${b.attribution ? ` (${b.attribution})` : ''}`);
        break;
      case 'table':
        lines.push(
          [b.caption ?? '', b.header.join(' | '), ...b.rows.map((r) => r.join(' | '))].filter(Boolean).join('\n'),
        );
        break;
      case 'chart':
        lines.push(`Chart: ${b.chart.title}${b.chart.subtitle ? ` (${b.chart.subtitle})` : ''}`);
        break;
      case 'diagram':
        lines.push(`Diagram: ${b.title}. ${b.alt}`);
        break;
      case 'figure':
        lines.push(`Figure: ${b.caption}`);
        break;
      case 'stepper':
        lines.push(b.title, ...b.steps.map((st, i) => `${i + 1}. ${st.label}: ${st.md}`));
        break;
    }
  }
  return lines.join('\n');
}

function sourceListText(list: readonly { ref: string; label: string }[]): string {
  return list.length
    ? list.map((s) => (s.label === s.ref ? `- ${s.label}` : `- ${s.label} (${s.ref})`)).join('\n')
    : '';
}

function notesToText(notes: readonly ChunkNotes[]): string {
  return notes
    .map((n, i) => {
      const body = [
        n.notes,
        n.keyFacts.length ? `Key facts:\n${n.keyFacts.map((f) => `- ${f}`).join('\n')}` : '',
        ...n.tables.map((t) =>
          [`Table: ${t.caption}`, `| ${t.header.join(' | ')} |`, ...t.rows.map((r) => `| ${r.join(' | ')} |`)].join(
            '\n',
          ),
        ),
        n.chartCandidates.length ? `Chart candidates (JSON): ${JSON.stringify(n.chartCandidates)}` : '',
        n.jargon.length ? `Jargon: ${n.jargon.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      return wrapSource(`notes ${i + 1}: ${n.sourceRefs.join(', ')}`, body);
    })
    .join('\n\n');
}

function stripImageBytes(c: ExtractedContent): ExtractedContent {
  return { ...c, images: [] };
}

// ---- factory ----

export interface LlmTasks {
  prepareContent(
    input: { contents: ExtractedContent[]; sourceList: { ref: string; label: string }[] } & StepCtx,
  ): Promise<PreparedContent>;
  generateIndepth(p: PreparedContent, ctx: StepCtx & { glossary: boolean }): Promise<StepResult<DocumentDraftTab>>;
  generateEli5(p: PreparedContent, ctx: StepCtx): Promise<StepResult<DocumentDraftTab>>;
  generateGlossary(indepth: DocumentDraftTab, ctx: StepCtx): Promise<StepResult<GlossaryDraft>>;
  summarize(indepth: DocumentDraftTab, ctx: StepCtx): Promise<StepResult<SummaryDraft>>;
  runSectionAction(input: SectionActionInput): Promise<SectionDraft | DocumentDraftTab>;
  matchMerge(summary: string, candidates: MergeCandidate[], signal?: AbortSignal): Promise<MergeMatchDraft>;
}

interface RunOpts {
  images?: ImageInput[];
  signal?: AbortSignal;
  onRetry?: StepCtx['onRetry'];
}

export function createTasks(deps: TaskDeps): LlmTasks {
  const policy = (): PromptPolicy => deps.policy?.() ?? defaultPromptPolicy;

  function skillsText(def: { id: PromptId; skills: string[] }, contextTokens: number): string {
    if (!def.skills.length) return '';
    if (deps.skills) return deps.skills.render(def.skills, contextTokens, skillTask(def.id)).text;
    return def.skills.map((s) => `## Style guide: ${s}\n\n${FALLBACK_SKILL_TEXT[s as SkillSlot] ?? ''}`).join('\n\n');
  }

  function buildRequest(
    id: PromptId,
    vars: Record<string, string | undefined>,
    provider: LLMProvider,
    opts: RunOpts,
  ): { req: Omit<GenerationRequest, 'jsonSchema'>; tag: string; schema: DraftSchemaName } {
    const def = deps.prompts.get(id);
    if (def.output === 'text') throw new LLMError('bad_request', `Prompt ${id} has no output schema`);
    const rendered = deps.prompts.render(id, { ...vars, skills: skillsText(def, provider.limits.contextTokens) });
    const preamble = policy().preamble;
    const setting = deps.settings().llm.maxOutputTokens;
    const req: Omit<GenerationRequest, 'jsonSchema'> = {
      taskId: id,
      system: preamble ? `${preamble}\n\n${rendered.system}` : rendered.system,
      messages: [{ role: 'user', text: rendered.user, ...(opts.images?.length ? { images: opts.images } : {}) }],
      maxOutputTokens: Math.min(def.maxOutputTokens, setting),
      ...(def.temperature !== undefined ? { temperature: def.temperature } : {}),
      ...(def.effort ? { effort: def.effort } : {}),
      cacheSystemPrompt: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onRetry ? { onRetry: opts.onRetry } : {}),
    };
    return { req, tag: def.tag, schema: def.output };
  }

  async function run<T>(
    id: PromptId,
    vars: Record<string, string | undefined>,
    opts: RunOpts = {},
  ): Promise<{ data: T; usage: TokenUsage; tag: string }> {
    const provider = deps.provider();
    const built = buildRequest(id, vars, provider, opts);
    const filtered = (await policy().preSendFilter(built.req as GenerationRequest)) as Omit<
      GenerationRequest,
      'jsonSchema'
    >;
    const labels = new Set((opts.images ?? []).map((i) => i.label));
    const r = await generateStructured({
      provider,
      request: filtered,
      schema: built.schema,
      validation: { imageLabels: labels },
      filter: (req) => policy().preSendFilter(req),
    });
    return { data: r.data as DraftOf<DraftSchemaName> as T, usage: r.usage, tag: built.tag };
  }

  function writingVars(p: PreparedContent, ctx: StepCtx, provider: LLMProvider): Record<string, string> {
    return {
      contentMode: CONTENT_MODE[p.mode],
      visibleOutputTokens: String(visibleOutput(provider.limits, deps.settings().llm.maxOutputTokens)),
      imageLabels: p.images.length ? p.images.map((i) => `- ${i.label}`).join('\n') : '',
      clarifyingInput: ctx.clarifyingInput,
      sourceList: sourceListText(p.sourceList),
      content: p.promptText,
    };
  }

  async function writeTab(
    id: 'in-depth' | 'eli5',
    kind: 'indepth' | 'eli5',
    p: PreparedContent,
    ctx: StepCtx,
    extra: Record<string, string>,
  ): Promise<StepResult<DocumentDraftTab>> {
    const provider = deps.provider();
    const vars = { ...writingVars(p, ctx, provider), ...extra };
    const opts: RunOpts = { images: p.images, signal: ctx.signal, ...(ctx.onRetry ? { onRetry: ctx.onRetry } : {}) };
    let r: { data: DocumentDraftTab; usage: TokenUsage; tag: string };
    try {
      r = await run<DocumentDraftTab>(id, { ...vars, overflowAddendum: '' }, opts);
    } catch (e) {
      // 02 §8.5: one retry with fewer sections; a second overflow is invalid_output.
      if (!(e instanceof OutputTruncated) || id !== 'in-depth') throw e;
      const count = (e.partialText.match(/"heading"\s*:/g) ?? []).length;
      const n = count > 0 ? Math.max(1, Math.floor(count * 0.7)) : 6;
      log.warn('llm.output-overflow', { taskId: id, count: n });
      r = await run<DocumentDraftTab>(
        id,
        { ...vars, overflowAddendum: `Produce at most ${n} sections, prioritize the most important material.` },
        opts,
      );
    }
    return { draft: { ...r.data, kind }, usage: r.usage, prompt: r.tag };
  }

  async function prepareContent(
    input: { contents: ExtractedContent[]; sourceList: { ref: string; label: string }[] } & StepCtx,
  ): Promise<PreparedContent> {
    const provider = deps.provider();
    const limits = provider.limits;
    const setting = deps.settings().llm.maxOutputTokens;
    const imgs = await prepareImages(input.contents, limits, deps.reencodeImage);
    const labelOf = (id: string): string | undefined => imgs.byId.get(id)?.label;
    const skipped = [...imgs.skipped];
    const warnings: string[] = [];
    const base = { sourceList: input.sourceList, skipped, warnings };

    // The in-depth call's system prompt as it will be sent (preamble + rendered template + skills).
    const preamble = policy().preamble;
    const vars = {
      skills: skillsText(deps.prompts.get('in-depth'), limits.contextTokens),
      glossaryInstructions: '',
      contentMode: CONTENT_MODE.raw,
      visibleOutputTokens: String(visibleOutput(limits, setting)),
      imageLabels: imgs.ordered.map((i) => `- ${i.label}`).join('\n'),
      clarifyingInput: input.clarifyingInput,
      sourceList: sourceListText(input.sourceList),
      overflowAddendum: '',
    };
    const rendered = deps.prompts.render('in-depth', { ...vars, content: '' });
    const system = preamble ? `${preamble}\n\n${rendered.system}` : rendered.system;
    const systemTokens = estimateTokens(system);
    const budget = inputBudget(limits, systemTokens, setting);
    const rawText = contentToPromptText(input.contents, labelOf);
    const imageTokenSum = imgs.ordered.reduce((n, i) => n + i.tokens, 0);
    let fits = estimateTokens(rawText) + imageTokenSum <= budget && imgs.ordered.length <= limits.maxImagesPerRequest;
    if (fits && provider.countTokens) {
      // 02 §8.1: one exact count for the final single-call check, when the provider has it. The
      // count request carries source content, so it goes through preSendFilter like a send
      // (HOOK-LLM-02); if the filter blocks it, the estimate stands.
      try {
        const filtered = await policy().preSendFilter({
          taskId: 'in-depth',
          system,
          messages: [{ role: 'user', text: deps.prompts.render('in-depth', { ...vars, content: rawText }).user }],
          maxOutputTokens: setting,
          signal: input.signal,
        });
        const n = await provider.countTokens({
          system: filtered.system,
          messages: filtered.messages,
          signal: input.signal,
        });
        // n covers system + user text; the budget already excludes the system prompt.
        fits = n + imageTokenSum <= budget + systemTokens;
      } catch {
        if (input.signal.aborted) throw cancelled();
        /* keep the estimate */
      }
    }
    if (fits) {
      return {
        mode: 'raw',
        contents: input.contents.map(stripImageBytes),
        promptText: rawText,
        images: imgs.ordered.map(toImageInput),
        ...base,
        usage: ZERO_USAGE,
        prompts: [],
      };
    }

    // ---- chunk-then-synthesize (02 §8.4) ----
    const target = Math.max(1000, Math.floor(0.6 * budget));
    const chunks = planChunks(contentUnits(input.contents, imgs.byId, target), target, limits.maxImagesPerRequest);
    let usage: TokenUsage = ZERO_USAGE;
    const prompts = new Set<string>();
    const noteCall = (
      content: string,
      refs: string[],
      i: number,
      n: number,
      images: ImageInput[],
    ): Promise<{ data: ChunkNotes; usage: TokenUsage; tag: string }> =>
      run<ChunkNotes>(
        'chunk-notes',
        {
          chunkIndex: String(i + 1),
          chunkCount: String(n),
          clarifyingInput: input.clarifyingInput,
          sourceList:
            sourceListText(input.sourceList.filter((s) => refs.includes(s.ref))) ||
            refs.map((r) => `- ${r}`).join('\n'),
          content,
        },
        { images, signal: input.signal, ...(input.onRetry ? { onRetry: input.onRetry } : {}) },
      );
    const mapped = await Promise.allSettled(
      chunks.map((ch, i) =>
        noteCall(
          renderChunk(ch),
          ch.sourceRefs,
          i,
          chunks.length,
          ch.images.map((x) => x),
        ),
      ),
    );
    if (input.signal.aborted) throw cancelled();
    let notes: ChunkNotes[] = [];
    const okRefs = new Set<string>();
    const failedRefs = new Set<string>();
    let firstError: unknown;
    mapped.forEach((r, i) => {
      const ch = chunks[i];
      if (!ch) return;
      if (r.status === 'fulfilled') {
        usage = addUsage(usage, r.value.usage);
        prompts.add(r.value.tag);
        notes.push({
          ...r.value.data,
          sourceRefs: r.value.data.sourceRefs.length ? r.value.data.sourceRefs : ch.sourceRefs,
        });
        ch.sourceRefs.forEach((s) => okRefs.add(s));
      } else {
        firstError ??= r.reason;
        ch.sourceRefs.forEach((s) => failedRefs.add(s));
      }
    });
    if (notes.length === 0)
      throw firstError instanceof LLMError ? firstError : new LLMError('server', 'Every chunk failed');
    for (const ref of failedRefs) {
      if (!okRefs.has(ref)) skipped.push({ ref, reason: MODEL_ERROR_WHILE_READING, code: 'internal-error' });
      else warnings.push('content-partially-read');
    }

    // Reduce: notes of notes, at most two levels (02 §8.4 step 4).
    for (let level = 0; level < MAX_REDUCE_LEVELS && estimateTokens(notesToText(notes)) > budget; level++) {
      const groups: ChunkNotes[][] = [];
      let cur: ChunkNotes[] = [];
      let curTokens = 0;
      for (const n of notes) {
        const t = estimateTokens(notesToText([n]));
        if (cur.length && curTokens + t > target) {
          groups.push(cur);
          cur = [];
          curTokens = 0;
        }
        cur.push(n);
        curTokens += t;
      }
      if (cur.length) groups.push(cur);
      const reduced = await Promise.allSettled(
        groups.map((g, i) =>
          noteCall(notesToText(g), [...new Set(g.flatMap((n) => n.sourceRefs))], i, groups.length, []),
        ),
      );
      if (input.signal.aborted) throw cancelled();
      notes = reduced.flatMap((r, i) => {
        if (r.status === 'rejected') return groups[i] ?? []; // keep the unreduced notes for this group
        usage = addUsage(usage, r.value.usage);
        prompts.add(r.value.tag);
        const refs = [...new Set((groups[i] ?? []).flatMap((n) => n.sourceRefs))];
        return [{ ...r.value.data, sourceRefs: refs }];
      });
    }
    // Beyond two levels: drop the lowest-priority (latest) notes and record a warning.
    let text = notesToText(notes);
    if (estimateTokens(text) > budget) {
      while (notes.length > 1 && estimateTokens(text) > budget) {
        notes = notes.slice(0, -1);
        text = notesToText(notes);
      }
      warnings.push('content-truncated');
      log.warn('llm.content-truncated', { count: notes.length });
    }
    return { mode: 'notes', notes, promptText: text, images: [], ...base, usage, prompts: [...prompts] };
  }

  return {
    prepareContent,

    generateIndepth: (p, ctx) =>
      writeTab('in-depth', 'indepth', p, ctx, {
        glossaryInstructions: ctx.glossary
          ? 'A glossary is built separately from your finished text and can only explain terms that appear in it. Keep every acronym the source uses, spelled out at first use with the acronym in parentheses, for example "customer acquisition cost (CAC)", and use the acronym after that.'
          : '',
      }),

    generateEli5: (p, ctx) => writeTab('eli5', 'eli5', p, ctx, {}),

    async generateGlossary(indepth, ctx) {
      const text = indepth.sections.map((s, i) => `[Section ${i}]\n${sectionText(s)}`).join('\n\n');
      const r = await run<GlossaryDraft>(
        'glossary',
        { clarifyingInput: ctx.clarifyingInput, indepthText: wrapSource('in-depth draft', text) },
        { signal: ctx.signal, ...(ctx.onRetry ? { onRetry: ctx.onRetry } : {}) },
      );
      const entries = r.data.entries.filter((e) => e.anchorSectionIndex < indepth.sections.length);
      return { draft: { entries }, usage: r.usage, prompt: r.tag };
    },

    async summarize(indepth, ctx) {
      const full = indepth.sections.map(sectionText).join('\n\n');
      const excerpt = full.slice(0, Math.floor(SUMMARY_EXCERPT_TOKENS * 3.5));
      const r = await run<SummaryDraft>(
        'summary',
        {
          title: indepth.title,
          outline: indepth.sections.map((s, i) => `${i + 1}. ${s.heading}`).join('\n'),
          indepthExcerpt: wrapSource('in-depth draft', excerpt),
        },
        { signal: ctx.signal, ...(ctx.onRetry ? { onRetry: ctx.onRetry } : {}) },
      );
      return { draft: r.data, usage: r.usage, prompt: r.tag };
    },

    async runSectionAction(input) {
      const id = ACTION_PROMPT[input.action];
      const vars: Record<string, string> = {
        tabKind: input.tabKind,
        outline: input.outline.map((t, i) => `${i + 1}. ${t}`).join('\n'),
        section: wrapSource('current section', JSON.stringify(input.section)),
        prevText: input.prev ? wrapSource('previous section', sectionText(input.prev)) : '',
        nextText: input.next ? wrapSource('next section', sectionText(input.next)) : '',
        selection: input.selection ? wrapSource('selected text', input.selection) : '',
        note: input.note ?? '',
        sourceExcerpt: input.sourceExcerpt ? wrapSource('original source excerpt', input.sourceExcerpt) : '',
      };
      if (input.action === 'eli5-tab') {
        const r = await run<DocumentDraftTab>(id, vars, { signal: input.signal });
        return { ...r.data, kind: 'section-eli5' };
      }
      return (await run<SectionDraft>(id, vars, { signal: input.signal })).data;
    },

    async matchMerge(summary, candidates, signal) {
      const top = candidates.slice(0, MERGE_MAX_CANDIDATES);
      if (top.length === 0) return { matches: [] };
      const r = await run<MergeMatchDraft>(
        'merge-match',
        {
          summary: wrapSource('new document summary', summary),
          candidates: top
            .map((c) =>
              wrapSource(
                `candidate ${c.catalogId}`,
                JSON.stringify({ catalogId: c.catalogId, title: c.title, summary: c.summary }),
              ),
            )
            .join('\n'),
        },
        signal ? { signal } : {},
      );
      const known = new Set(top.map((c) => c.catalogId));
      const matches = r.data.matches.filter((m) => known.has(m.catalogId)).sort((a, b) => b.score - a.score);
      return { matches };
    },
  };
}

// ---- checkpoint serialization (06 persists PreparedContent; images as base64) ----

export type PreparedContentJson = Omit<PreparedContent, 'images'> & {
  images: (Omit<ImageInput, 'data'> & { data: string })[];
};

export function serializePrepared(p: PreparedContent): PreparedContentJson {
  return { ...p, images: p.images.map((i) => ({ ...i, data: i.data.toString('base64') })) };
}

export function deserializePrepared(j: PreparedContentJson): PreparedContent {
  return { ...j, images: j.images.map((i) => ({ ...i, data: Buffer.from(i.data, 'base64') })) };
}
