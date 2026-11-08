import { z } from 'zod';
import { log } from '../security';
import { LLMError } from './errors';
import {
  ChunkNotesSchema,
  DRAFT_SCHEMAS,
  DocumentDraftTabSchema,
  DraftBlockSchema,
  SectionDraftSchema,
  SteBlockSchema,
  SteDraftSchema,
  draftJsonSchema,
  draftPromptSchema,
  usesPromptedJson,
  stripNullProperties,
  type ChartCandidate,
  type DraftBlock,
  type DraftSchemaName,
  type MergePlanDraft,
} from './schemas/draft';
import type { GenerationRequest, GenerationResult, LLMProvider, TokenUsage } from './types';

/** 02 §10.1 step 3: blocks may be dropped when at most this share fails. */
export const MAX_DROP_RATIO = 0.2;
export const MAX_SVG_BYTES = 100 * 1024;

export type DraftOf<N extends DraftSchemaName> = z.infer<(typeof DRAFT_SCHEMAS)[N]>;

/** The model hit max_tokens; `partialText` lets in-depth retry with fewer sections (02 §8.5). */
export class OutputTruncated extends LLMError {
  constructor(public readonly partialText: string) {
    super('invalid_output', 'The model ran out of output tokens before finishing.');
    this.name = 'OutputTruncated';
  }
}

export interface ValidationContext {
  /** Labels of the ImageInputs sent with the request; `figure.imageLabel` must be one of them. */
  imageLabels?: ReadonlySet<string>;
  /** SteDraft only: the in-depth section count the STE tab must match (D15); a mismatch asks for a repair. */
  steSectionCount?: number;
  /**
   * SteDraft only: per In depth section, the indexes of its visual blocks a `keep` may name. A section
   * with no text of its own and no keep of one of these would resolve to nothing, so it asks for a repair.
   */
  steKeepable?: readonly (readonly number[])[];
}

export type ValidationOutcome<T> = { ok: true; data: T; dropped: string[] } | { ok: false; errors: string[] };

// ---- semantic checks (02 §10.1 step 2) ----

/**
 * Structural chart checks only (02 §10.1): every series as long as the categories, finite
 * values. Everything else is fixed in code by the renderer (07 §5.2) and never triggers a repair
 * call: repeated categories merge, a blank title is derived, and presentation rules (series caps,
 * sparse series, text case, annotations, a pie with negative values, which becomes a bar chart)
 * are normalized.
 */
function chartErrors(c: ChartCandidate, at: string): string[] {
  const errs: string[] = [];
  c.series.forEach((s, i) => {
    if (s.values.length !== c.categories.length) {
      errs.push(
        `${at}.series[${i}].values: has ${s.values.length} values but there are ${c.categories.length} categories`,
      );
    }
    s.values.forEach((v, j) => {
      if (v !== null && !Number.isFinite(v)) errs.push(`${at}.series[${i}].values[${j}]: must be a finite number`);
    });
  });
  return errs;
}

export function blockErrors(b: DraftBlock, at: string, ctx: ValidationContext): string[] {
  switch (b.type) {
    case 'chart':
      return chartErrors(b.chart, `${at}.chart`);
    case 'figure':
      return ctx.imageLabels?.has(b.imageLabel)
        ? []
        : [`${at}.imageLabel: "${b.imageLabel}" is not a supplied image label`];
    case 'table':
      return b.rows.flatMap((r, i) =>
        r.length === b.header.length ? [] : [`${at}.rows[${i}]: ${r.length} cells but header has ${b.header.length}`],
      );
    case 'photo': {
      const errs: string[] = [];
      if (!b.query.trim()) errs.push(`${at}.query: must be a few generic words`);
      if (!b.alt.trim()) errs.push(`${at}.alt: must describe the photo`);
      return errs;
    }
    case 'animation':
      // 02 §10.1: never a repair. Document validation (07 §5.2) lints the code, sanitizes the
      // poster and drops the block on any problem (warning animation-dropped).
      return [];
    case 'diagram': {
      const errs: string[] = [];
      if (!b.svg.trimStart().startsWith('<svg')) errs.push(`${at}.svg: must start with <svg`);
      if (Buffer.byteLength(b.svg, 'utf8') >= MAX_SVG_BYTES) errs.push(`${at}.svg: must be under 100 KB`);
      return errs;
    }
    default:
      return [];
  }
}

function zodErrors(e: z.ZodError, prefix = ''): string[] {
  return e.issues.map((i) => {
    const p = i.path.map((x) => (typeof x === 'number' ? `[${x}]` : `.${String(x)}`)).join('');
    return `${prefix}${p || '(root)'}: ${i.message}`;
  });
}

const LenientSection = SectionDraftSchema.extend({ blocks: z.array(z.unknown()).min(1).max(60) });
const LenientTab = DocumentDraftTabSchema.extend({ sections: z.array(LenientSection).min(1).max(40) });

interface BlockCheck {
  sections: { blocks: unknown[] }[];
  at: (s: number, b: number) => string;
}

/** Validates blocks one by one; drops failures when the rest is valid and ≤ 20% fail. */
function checkBlocks(
  c: BlockCheck,
  ctx: ValidationContext,
  checkOne: (raw: unknown, at: string) => string[] = (raw, at) => {
    const parsed = DraftBlockSchema.safeParse(raw);
    return parsed.success ? blockErrors(parsed.data, at, ctx) : zodErrors(parsed.error, at);
  },
): { ok: true; dropped: string[] } | { ok: false; errors: string[] } {
  const bad: { s: number; b: number; errs: string[] }[] = [];
  let total = 0;
  c.sections.forEach((sec, s) => {
    sec.blocks.forEach((raw, b) => {
      total++;
      const at = c.at(s, b);
      const errs = checkOne(raw, at);
      if (errs.length) bad.push({ s, b, errs });
    });
  });
  if (bad.length === 0) return { ok: true, dropped: [] };
  const errors = bad.flatMap((x) => x.errs);
  const emptied = c.sections.some((sec, s) => bad.filter((x) => x.s === s).length >= sec.blocks.length);
  if (bad.length / total > MAX_DROP_RATIO || emptied) return { ok: false, errors };
  for (const x of [...bad].reverse()) c.sections[x.s]?.blocks.splice(x.b, 1);
  return { ok: true, dropped: bad.map((x) => c.at(x.s, x.b)) };
}

/** Parse + semantic validation of one structured result (02 §10.1 step 2-3). */
export function validateDraft<N extends DraftSchemaName>(
  name: N,
  input: unknown,
  ctx: ValidationContext = {},
): ValidationOutcome<DraftOf<N>> {
  const json = stripNullProperties(input);
  if (name === 'SteDraft') return validateSte(json, ctx) as ValidationOutcome<DraftOf<N>>;
  if (name === 'DocumentDraftTab' || name === 'SectionDraft') {
    const lenient = name === 'DocumentDraftTab' ? LenientTab.safeParse(json) : LenientSection.safeParse(json);
    if (!lenient.success) return { ok: false, errors: zodErrors(lenient.error) };
    const data = lenient.data as { sections?: { blocks: unknown[] }[]; blocks?: unknown[] };
    const check: BlockCheck =
      name === 'DocumentDraftTab'
        ? { sections: data.sections ?? [], at: (s, b) => `sections[${s}].blocks[${b}]` }
        : { sections: [{ blocks: data.blocks ?? [] }], at: (_s, b) => `blocks[${b}]` };
    const blocks = checkBlocks(check, ctx);
    if (!blocks.ok) return blocks;
    const final = DRAFT_SCHEMAS[name].safeParse(data);
    if (!final.success) return { ok: false, errors: zodErrors(final.error) };
    return { ok: true, data: final.data as DraftOf<N>, dropped: blocks.dropped };
  }
  const parsed = DRAFT_SCHEMAS[name].safeParse(json);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
  if (name === 'MergePlanDraft') {
    // Written blocks get the same semantic checks as section drafts; any failure asks for a repair.
    const errors = mergePlanErrors(parsed.data as MergePlanDraft, ctx);
    if (errors.length) return { ok: false, errors };
  }
  if (name === 'ChunkNotes') {
    // Malformed chart candidates are hints only: drop them rather than repair.
    const notes = ChunkNotesSchema.parse(parsed.data);
    const dropped: string[] = [];
    notes.chartCandidates = notes.chartCandidates.filter((c, i) => {
      const ok = chartErrors(c, '').length === 0;
      if (!ok) dropped.push(`chartCandidates[${i}]`);
      return ok;
    });
    return { ok: true, data: notes as DraftOf<N>, dropped };
  }
  return { ok: true, data: parsed.data as DraftOf<N>, dropped: [] };
}

const LenientSte = SteDraftSchema.extend({
  sections: z
    .array(z.object({ heading: z.string(), blocks: z.array(z.unknown()).min(1).max(60) }))
    .min(1)
    .max(40),
});

/**
 * SteDraft checks (02 §10.1, D15): text blocks are dropped like any draft block (at most 20 %);
 * `keep` numbers are resolved later by resolveSte (bad ones dropped, never repaired). The one
 * structural rule that asks for a repair is the section count: the tab mirrors In depth section by section.
 */
function validateSte(json: unknown, ctx: ValidationContext): ValidationOutcome<DraftOf<'SteDraft'>> {
  const lenient = LenientSte.safeParse(json);
  if (!lenient.success) return { ok: false, errors: zodErrors(lenient.error) };
  const data = lenient.data;
  const errors: string[] = [];
  const want = ctx.steSectionCount;
  if (want !== undefined && data.sections.length !== want) {
    errors.push(
      `sections: has ${data.sections.length} sections but the In depth view has ${want}; return exactly ${want}`,
    );
  }
  const blocks = checkBlocks(
    { sections: data.sections, at: (s, b) => `sections[${s}].blocks[${b}]` },
    ctx,
    (raw, at) => {
      const parsed = SteBlockSchema.safeParse(raw);
      return parsed.success ? [] : zodErrors(parsed.error, at);
    },
  );
  if (!blocks.ok) errors.push(...blocks.errors);
  if (errors.length) return { ok: false, errors };
  const final = SteDraftSchema.safeParse(data);
  if (!final.success) return { ok: false, errors: zodErrors(final.error) };
  const keepable = ctx.steKeepable;
  if (keepable) {
    const empty = final.data.sections.flatMap((sec, si) =>
      sec.blocks.some((b) => b.type !== 'keep' || keepable[si]?.includes(b.block))
        ? []
        : [`sections[${si}]: has no text and keeps no visual of the In depth section; write its STE text`],
    );
    if (empty.length) return { ok: false, errors: empty };
  }
  return { ok: true, data: final.data, dropped: blocks.ok ? blocks.dropped : [] };
}

function mergePlanErrors(plan: MergePlanDraft, ctx: ValidationContext): string[] {
  const errors: string[] = [];
  for (const tab of ['indepth', 'eli5'] as const)
    for (const kind of ['revise', 'insert'] as const)
      plan[tab][kind].forEach((sec, si) =>
        sec.blocks.forEach((b, bi) => {
          if (b.type === 'keep' || b.type === 'incoming') return;
          errors.push(...blockErrors(b, `${tab}.${kind}[${si}].blocks[${bi}]`, ctx));
        }),
      );
  return errors;
}

// ---- call + single repair (02 §10.1) ----

export interface StructuredCall<N extends DraftSchemaName> {
  provider: LLMProvider;
  request: Omit<GenerationRequest, 'jsonSchema'>;
  schema: N;
  validation?: ValidationContext;
  /** HOOK-LLM-02 preSendFilter, applied to the repair request too (the first is filtered by the caller). */
  filter?: (req: GenerationRequest) => GenerationRequest | Promise<GenerationRequest>;
  /** The repair turn for a bulleted error list (catalogue fragment `json-repair`). */
  repairText(errors: string): string;
  /** Stands in for an empty first reply in the repair transcript (fragment `json-no-output`). */
  noOutputText(): string;
  /** Prompted-JSON output contract for a schema and its JSON text (fragment `json-contract`). */
  contractText(schemaName: string, schema: string): string;
}

export interface StructuredResult<T> {
  data: T;
  usage: TokenUsage;
  model: string;
  attempts: number;
  repaired: boolean;
  dropped: string[];
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const cached = (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

export const ZERO_USAGE: TokenUsage = Object.freeze({ inputTokens: 0, outputTokens: 0 });

const MAX_LISTED_ERRORS = 20;

/** The validation errors as a bulleted list (at most 20 lines plus a count) for the repair turn. */
export function listErrors(errors: string[]): string {
  const listed = errors.slice(0, MAX_LISTED_ERRORS).map((e) => `- ${e}`);
  if (errors.length > MAX_LISTED_ERRORS) listed.push(`- ...and ${errors.length - MAX_LISTED_ERRORS} more`);
  return listed.join('\n');
}

function hasImages(req: Pick<GenerationRequest, 'messages'>): boolean {
  return req.messages.some((m) => (m.images?.length ?? 0) > 0);
}

function send(p: LLMProvider, req: GenerationRequest): Promise<GenerationResult> {
  return hasImages(req) ? p.generateWithImages(req) : p.generate(req);
}

function check<N extends DraftSchemaName>(
  r: GenerationResult,
  name: N,
  ctx: ValidationContext,
): ValidationOutcome<DraftOf<N>> {
  if (r.stopReason === 'refusal') throw new LLMError('refusal', 'The model declined to answer.');
  if (r.stopReason === 'max_tokens') throw new OutputTruncated(r.text);
  if (r.json === undefined) {
    try {
      return validateDraft(name, JSON.parse(extractJsonText(r.text)) as unknown, ctx);
    } catch {
      return { ok: false, errors: ['(root): output is not valid JSON'] };
    }
  }
  return validateDraft(name, r.json, ctx);
}

/** Runs `f`; an LLMError it throws carries the tokens spent so far (D25). */
function withUsage<T>(usage: TokenUsage, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof LLMError) e.usage = usage;
    throw e;
  }
}

/** The tokens a failed call already spent (D25), or undefined. */
export function usageOf(err: unknown): TokenUsage | undefined {
  return err instanceof LLMError ? err.usage : undefined;
}

/**
 * Schema-constrained call (02 §10.1): native structured output, zod + semantic validation, block
 * dropping for small failures, otherwise exactly one repair call; a second failure is invalid_output.
 */
export async function generateStructured<N extends DraftSchemaName>(
  call: StructuredCall<N>,
): Promise<StructuredResult<DraftOf<N>>> {
  const ctx = call.validation ?? {};
  const req: GenerationRequest = usesPromptedJson(call.schema)
    ? {
        ...call.request,
        system: `${call.request.system}\n\n${call.contractText(call.schema, draftPromptSchema(call.schema))}`,
      }
    : { ...call.request, jsonSchema: { name: schemaToolName(call.schema), schema: draftJsonSchema(call.schema) } };
  const first = await send(call.provider, req);
  let usage = first.usage;
  const outcome = withUsage(usage, () => check(first, call.schema, ctx));
  if (outcome.ok) {
    if (outcome.dropped.length) log.warn('llm.blocks-dropped', { taskId: req.taskId, count: outcome.dropped.length });
    return {
      data: outcome.data,
      usage,
      model: first.model,
      attempts: first.attempts,
      repaired: false,
      dropped: outcome.dropped,
    };
  }
  const repairReq: GenerationRequest = {
    ...req,
    messages: [
      ...req.messages,
      { role: 'assistant', text: first.text.trim() === '' ? call.noOutputText() : first.text },
      { role: 'user', text: call.repairText(listErrors(outcome.errors)) },
    ],
  };
  log.info('llm.repair', { taskId: req.taskId, count: outcome.errors.length });
  const second = await send(call.provider, call.filter ? await call.filter(repairReq) : repairReq);
  usage = addUsage(usage, second.usage);
  const spent = usage;
  const again = withUsage(spent, () => check(second, call.schema, ctx));
  if (!again.ok) {
    const e = new LLMError('invalid_output', 'The model returned output that failed validation twice.');
    e.usage = spent;
    throw e;
  }
  return {
    data: again.data,
    usage,
    model: second.model,
    attempts: first.attempts + second.attempts,
    repaired: true,
    dropped: again.dropped,
  };
}

/**
 * The JSON text of a prompted reply: the reply itself when it is JSON, otherwise the outermost
 * {...} span (strips code fences and stray prose), or the reply unchanged when there is none.
 */
export function extractJsonText(text: string): string {
  const t = text.trim();
  if (t.startsWith('{') && t.endsWith('}')) return t;
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  return start >= 0 && end > start ? t.slice(start, end + 1) : text;
}

/** snake_case name for jsonSchema.name (tool names and OpenAI schema names). */
export function schemaToolName(name: DraftSchemaName): string {
  return name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}
