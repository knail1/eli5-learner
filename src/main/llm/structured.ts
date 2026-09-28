import { z } from 'zod';
import { log } from '../security';
import { LLMError } from './errors';
import {
  ChunkNotesSchema,
  DRAFT_SCHEMAS,
  DocumentDraftTabSchema,
  DraftBlockSchema,
  SectionDraftSchema,
  draftJsonSchema,
  stripNullProperties,
  type ChartSpec,
  type DraftBlock,
  type DraftSchemaName,
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
}

export type ValidationOutcome<T> = { ok: true; data: T; dropped: string[] } | { ok: false; errors: string[] };

// ---- semantic checks (02 §10.1 step 2) ----

function chartErrors(c: ChartSpec, at: string): string[] {
  const errs: string[] = [];
  c.series.forEach((s, i) => {
    if (s.values.length !== c.categories.length) {
      errs.push(
        `${at}.series[${i}].values: has ${s.values.length} values but there are ${c.categories.length} categories`,
      );
    }
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
): { ok: true; dropped: string[] } | { ok: false; errors: string[] } {
  const bad: { s: number; b: number; errs: string[] }[] = [];
  let total = 0;
  c.sections.forEach((sec, s) => {
    sec.blocks.forEach((raw, b) => {
      total++;
      const at = c.at(s, b);
      const parsed = DraftBlockSchema.safeParse(raw);
      const errs = parsed.success ? blockErrors(parsed.data, at, ctx) : zodErrors(parsed.error, at);
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

// ---- call + single repair (02 §10.1) ----

export interface StructuredCall<N extends DraftSchemaName> {
  provider: LLMProvider;
  request: Omit<GenerationRequest, 'jsonSchema'>;
  schema: N;
  validation?: ValidationContext;
  /** HOOK-LLM-02 preSendFilter, applied to the repair request too (the first is filtered by the caller). */
  filter?: (req: GenerationRequest) => GenerationRequest | Promise<GenerationRequest>;
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

export function repairPrompt(errors: string[]): string {
  const listed = errors.slice(0, MAX_LISTED_ERRORS).map((e) => `- ${e}`);
  if (errors.length > MAX_LISTED_ERRORS) listed.push(`- ...and ${errors.length - MAX_LISTED_ERRORS} more`);
  return `The JSON above failed validation:\n${listed.join('\n')}\n\nReturn corrected JSON only.`;
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
      return validateDraft(name, JSON.parse(r.text) as unknown, ctx);
    } catch {
      return { ok: false, errors: ['(root): output is not valid JSON'] };
    }
  }
  return validateDraft(name, r.json, ctx);
}

/**
 * Schema-constrained call (02 §10.1): native structured output, zod + semantic validation, block
 * dropping for small failures, otherwise exactly one repair call; a second failure is invalid_output.
 */
export async function generateStructured<N extends DraftSchemaName>(
  call: StructuredCall<N>,
): Promise<StructuredResult<DraftOf<N>>> {
  const ctx = call.validation ?? {};
  const req: GenerationRequest = {
    ...call.request,
    jsonSchema: { name: schemaToolName(call.schema), schema: draftJsonSchema(call.schema) },
  };
  const first = await send(call.provider, req);
  let usage = first.usage;
  const outcome = check(first, call.schema, ctx);
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
      { role: 'assistant', text: first.text.trim() === '' ? '(no output)' : first.text },
      { role: 'user', text: repairPrompt(outcome.errors) },
    ],
  };
  log.info('llm.repair', { taskId: req.taskId, count: outcome.errors.length });
  const second = await send(call.provider, call.filter ? await call.filter(repairReq) : repairReq);
  usage = addUsage(usage, second.usage);
  const again = check(second, call.schema, ctx);
  if (!again.ok) {
    throw new LLMError('invalid_output', 'The model returned output that failed validation twice.');
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

/** snake_case name for jsonSchema.name (tool names and OpenAI schema names). */
export function schemaToolName(name: DraftSchemaName): string {
  return name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}
