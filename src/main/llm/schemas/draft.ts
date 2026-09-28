import { z } from 'zod';

/**
 * Structured model output (02 §10). Types are inferred from these schemas.
 * The strict JSON Schema export for provider-native structured output is at the end of this file;
 * semantic checks (02 §10.1) live in structured.ts.
 */

export const ChartSpecSchema = z.object({
  kind: z.enum(['bar', 'stacked-bar', 'line', 'area', 'pie', 'scatter']),
  title: z.string(),
  subtitle: z.string().optional(),
  source: z.string().optional(),
  xLabel: z.string().optional(),
  yLabel: z.string().optional(),
  unit: z.string().optional(),
  categories: z.array(z.string()),
  series: z.array(z.object({ name: z.string(), values: z.array(z.number().nullable()) })),
  highlight: z.object({ category: z.string(), note: z.string() }).optional(),
});
export type ChartSpec = z.infer<typeof ChartSpecSchema>;

const TableShape = { caption: z.string().optional(), header: z.array(z.string()), rows: z.array(z.array(z.string())) };

export const DraftBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), md: z.string() }),
  z.object({ type: z.literal('list'), ordered: z.boolean(), items: z.array(z.string()) }),
  z.object({ type: z.literal('pullquote'), text: z.string(), attribution: z.string().optional() }),
  z.object({ type: z.literal('callout'), tone: z.enum(['note', 'warning', 'keypoint']), md: z.string() }),
  z.object({ type: z.literal('table'), ...TableShape }),
  z.object({ type: z.literal('chart'), chart: ChartSpecSchema }),
  z.object({ type: z.literal('diagram'), title: z.string(), svg: z.string(), alt: z.string() }),
  z.object({
    type: z.literal('figure'),
    imageLabel: z.string(),
    caption: z.string(),
    annotations: z.array(z.object({ x: z.number(), y: z.number(), text: z.string() })).optional(),
  }),
  z.object({
    type: z.literal('stepper'),
    title: z.string(),
    steps: z.array(z.object({ label: z.string(), md: z.string() })),
  }),
  z.object({ type: z.literal('analogy'), md: z.string() }),
  // A request for an open-licensed stock photo of a real-world scene (07 §7.4). The app searches for
  // it with `query` (short and generic, never names or source text) and replaces the block with a
  // credited figure, or drops it when nothing fits.
  z.object({
    type: z.literal('photo'),
    query: z.string(),
    purpose: z.string(),
    alt: z.string(),
    caption: z.string().optional(),
    sensitive: z.boolean().optional(),
  }),
]);
export type DraftBlock = z.infer<typeof DraftBlockSchema>;

export const SectionDraftSchema = z.object({
  heading: z.string(),
  blocks: z.array(DraftBlockSchema).min(1).max(60),
});
export type SectionDraft = z.infer<typeof SectionDraftSchema>;

export const DocumentDraftTabSchema = z.object({
  kind: z.enum(['indepth', 'eli5', 'section-eli5']),
  title: z.string(),
  dek: z.string().optional(),
  sections: z.array(SectionDraftSchema).min(1).max(40),
});
export type DocumentDraftTab = z.infer<typeof DocumentDraftTabSchema>;

export const ChunkNotesSchema = z.object({
  notes: z.string(),
  keyFacts: z.array(z.string()),
  tables: z.array(z.object({ caption: z.string(), header: z.array(z.string()), rows: z.array(z.array(z.string())) })),
  chartCandidates: z.array(ChartSpecSchema),
  jargon: z.array(z.string()),
  sourceRefs: z.array(z.string()),
});
export type ChunkNotes = z.infer<typeof ChunkNotesSchema>;

export const GlossaryDraftSchema = z.object({
  entries: z
    .array(
      z.object({
        term: z.string(),
        expansion: z.string().optional(),
        explanation: z.string(),
        anchorSectionIndex: z.number().int().min(0),
        anchorText: z.string(),
      }),
    )
    .max(40),
});
export type GlossaryDraft = z.infer<typeof GlossaryDraftSchema>;

export const SummaryDraftSchema = z.object({
  title: z.string(),
  topicSlugHint: z.string(),
  summary: z.string().max(300), // 1-2 sentences
});
export type SummaryDraft = z.infer<typeof SummaryDraftSchema>;

export const MergeMatchDraftSchema = z.object({
  matches: z.array(z.object({ catalogId: z.string(), score: z.number().min(0).max(1), reason: z.string() })),
});
export type MergeMatchDraft = z.infer<typeof MergeMatchDraftSchema>;

/** The stock-photo choice for each photo slot (07 §7.4): `candidate` 0 = none fits, else 1..n. */
export const PhotoPickDraftSchema = z.object({
  picks: z.array(z.object({ slot: z.string(), candidate: z.number().int().min(0), reason: z.string() })),
});
export type PhotoPickDraft = z.infer<typeof PhotoPickDraftSchema>;
/**
 * Merge edit plan (02 §10, 09 §10.3): how to weave another document into this one. Sections are
 * named by the aliases the prompt gives them (I1…, E1… for this document; X1…, Y1… for the
 * incoming one). A `keep` block reuses block N of the section being revised unchanged; an
 * `incoming` block copies a block of the incoming document (visuals are never re-typed).
 */
const MergeKeepBlockSchema = z.object({ type: z.literal('keep'), block: z.number().int().min(0) });
const MergeIncomingBlockSchema = z.object({
  type: z.literal('incoming'),
  section: z.string(),
  block: z.number().int().min(0),
});
export const MergePlanBlockSchema = z.discriminatedUnion('type', [
  ...DraftBlockSchema.options,
  MergeKeepBlockSchema,
  MergeIncomingBlockSchema,
]);
export type MergePlanBlock = z.infer<typeof MergePlanBlockSchema>;
const MergePlanSectionShape = { heading: z.string(), blocks: z.array(MergePlanBlockSchema).min(1).max(60) };
export const MergeTabPlanSchema = z.object({
  /** Existing sections rewritten in place (same section, same ID). */
  revise: z.array(z.object({ section: z.string(), ...MergePlanSectionShape })).max(40),
  /** New sections; `after` is the alias of the section they follow, or "START". */
  insert: z.array(z.object({ after: z.string(), ...MergePlanSectionShape })).max(20),
});
export type MergeTabPlan = z.infer<typeof MergeTabPlanSchema>;
export const MergePlanDraftSchema = z.object({
  indepth: MergeTabPlanSchema,
  eli5: MergeTabPlanSchema,
  glossary: z
    .array(
      z.object({ term: z.string(), expansion: z.string().optional(), explanation: z.string(), anchorText: z.string() }),
    )
    .max(20),
});
export type MergePlanDraft = z.infer<typeof MergePlanDraftSchema>;

/** Schema names usable in prompt front matter `output:` (02 §9, §16 prompt lint). */
export const DRAFT_SCHEMAS = {
  DocumentDraftTab: DocumentDraftTabSchema,
  SectionDraft: SectionDraftSchema,
  ChunkNotes: ChunkNotesSchema,
  GlossaryDraft: GlossaryDraftSchema,
  SummaryDraft: SummaryDraftSchema,
  MergeMatchDraft: MergeMatchDraftSchema,
  PhotoPickDraft: PhotoPickDraftSchema,
  MergePlanDraft: MergePlanDraftSchema,
} as const;
export type DraftSchemaName = keyof typeof DRAFT_SCHEMAS;

// ---------------------------------------------------------------------------------------------
// JSON Schema export for provider-native structured output (02 §5, §6, §10)
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** Keywords that strict structured-output modes reject; zod re-checks them after the call. */
const UNSUPPORTED = [
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'default',
];

function nullable(s: Json): Json {
  // The API rejects an enum under a type array (even with null listed), so nullable enums are unions.
  if (Array.isArray(s.enum)) return { anyOf: [s, { type: 'null' }] };
  const t = s.type;
  if (typeof t === 'string') return { ...s, type: [t, 'null'] };
  if (Array.isArray(t)) return t.includes('null') ? s : { ...s, type: [...(t as string[]), 'null'] };
  return { anyOf: [s, { type: 'null' }] };
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (typeof node !== 'object' || node === null) return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) {
    if (UNSUPPORTED.includes(k)) continue;
    if (k === 'oneOf') out.anyOf = strictify(v);
    else if (k === 'const') out.enum = [v];
    else out[k] = strictify(v);
  }
  if (out.type === 'object' && typeof out.properties === 'object' && out.properties !== null) {
    const props = out.properties as Json;
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    for (const key of Object.keys(props)) {
      if (!required.has(key)) props[key] = nullable(props[key] as Json);
    }
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

/**
 * Strict JSON Schema (draft 2020-12) for a zod schema: every property required, optional fields
 * nullable, `additionalProperties: false`, unions as anyOf, numeric/length bounds removed. This is
 * the form OpenAI strict mode requires and Claude's output_config accepts (02 §6).
 */
export function toStrictJsonSchema(schema: z.ZodType): Json {
  return strictify(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' })) as Json;
}

/**
 * Drafts sent as prompted JSON instead of native structured output (02 §10). The API compiles
 * output_config schemas into a grammar with a size cap and at most 16 union-typed parameters; the
 * ten-shape block union nested in sections and tabs exceeds both. Their replies are parsed and
 * validated with the same zod schemas and single repair.
 */
const PROMPTED_JSON: ReadonlySet<DraftSchemaName> = new Set(['DocumentDraftTab', 'SectionDraft', 'MergePlanDraft']);

export function usesPromptedJson(name: DraftSchemaName): boolean {
  return PROMPTED_JSON.has(name);
}

/** Compact JSON Schema text for the system-prompt output contract of a prompted draft. */
export function draftPromptSchema(name: DraftSchemaName): string {
  const { $schema: _drop, ...schema } = z.toJSONSchema(DRAFT_SCHEMAS[name], { target: 'draft-2020-12', io: 'output' });
  return JSON.stringify(schema);
}

const jsonSchemaCache = new Map<DraftSchemaName, Json>();

export function draftJsonSchema(name: DraftSchemaName): Json {
  let s = jsonSchemaCache.get(name);
  if (!s) {
    s = toStrictJsonSchema(DRAFT_SCHEMAS[name]);
    jsonSchemaCache.set(name, s);
  }
  return s;
}

/** Strict mode sends `null` for absent optional fields; drop those keys before zod validation. */
export function stripNullProperties(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNullProperties);
  if (typeof v !== 'object' || v === null) return v;
  const out: Json = {};
  for (const [k, x] of Object.entries(v as Json)) {
    if (x !== null) out[k] = stripNullProperties(x);
  }
  return out;
}
