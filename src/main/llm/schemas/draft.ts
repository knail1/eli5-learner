import { z } from 'zod';

/**
 * Structured model output (02 §10). Types are inferred from these schemas.
 * M1: JSON Schema export for provider-native structured output and the semantic checks of 02 §10.1.
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

/** Schema names usable in prompt front matter `output:` (02 §9, §16 prompt lint). */
export const DRAFT_SCHEMAS = {
  DocumentDraftTab: DocumentDraftTabSchema,
  SectionDraft: SectionDraftSchema,
  ChunkNotes: ChunkNotesSchema,
  GlossaryDraft: GlossaryDraftSchema,
  SummaryDraft: SummaryDraftSchema,
  MergeMatchDraft: MergeMatchDraftSchema,
} as const;
export type DraftSchemaName = keyof typeof DRAFT_SCHEMAS;
