// zod schema for the embedded `#eli5-model` (07 §3, §8: parseDocument validates it).
import { z } from 'zod';
import { ChartSpecSchema } from '../llm';
import { SECTION_ID_RE } from './section-id';
import type { DocBlock, DocumentModel, SectionId } from './types';

const SectionIdSchema = z
  .string()
  .regex(SECTION_ID_RE)
  .transform((s) => s as SectionId);

/** Asset ids are content-addressed (07 §5.6, images.ts assetIdFor). */
const AssetIdSchema = z.string().regex(/^img-[0-9a-f]{12}$/);

const TableShape = { caption: z.string().optional(), header: z.array(z.string()), rows: z.array(z.array(z.string())) };

// DraftBlock (02 §10) with `figure` resolved to an asset (07 §3).
export const DocBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), md: z.string() }),
  z.object({ type: z.literal('list'), ordered: z.boolean(), items: z.array(z.string()) }),
  z.object({ type: z.literal('pullquote'), text: z.string(), attribution: z.string().optional() }),
  z.object({ type: z.literal('callout'), tone: z.enum(['note', 'warning', 'keypoint']), md: z.string() }),
  z.object({ type: z.literal('table'), ...TableShape }),
  z.object({ type: z.literal('chart'), chart: ChartSpecSchema }),
  z.object({ type: z.literal('diagram'), title: z.string(), svg: z.string(), alt: z.string() }),
  z.object({
    type: z.literal('figure'),
    assetId: AssetIdSchema,
    caption: z.string(),
    alt: z.string(),
    annotations: z.array(z.object({ x: z.number(), y: z.number(), text: z.string() })).optional(),
  }),
  z.object({
    type: z.literal('stepper'),
    title: z.string(),
    steps: z.array(z.object({ label: z.string(), md: z.string() })),
  }),
  z.object({ type: z.literal('analogy'), md: z.string() }),
]);

const EnhRangeSchema = z.object({ merge: z.string(), start: z.number().int().min(0), end: z.number().int().min(0) });
const BlockEnhancementSchema = z.discriminatedUnion('kind', [
  z.object({ block: z.number().int().min(0), kind: z.enum(['new', 'updated']), merge: z.string() }),
  z.object({ block: z.number().int().min(0), kind: z.literal('text'), parts: z.array(z.array(EnhRangeSchema)) }),
]);

const SectionSchema = z.object({
  id: SectionIdSchema,
  kind: z.enum(['content', 'references']),
  heading: z.string(),
  blocks: z.array(DocBlockSchema),
  origin: z.enum(['generated', 'regenerated', 'merged', 'merge-marker', 'placeholder']),
  updatedAt: z.string(),
  lastAction: z.enum(['expand', 'reexplain', 'analogy', 'deeper']).optional(),
  merge: z.object({ fromDocId: z.string(), fromTitle: z.string(), mergedAt: z.string() }).optional(),
  enh: z.object({ added: z.string().optional(), blocks: z.array(BlockEnhancementSchema) }).optional(),
  mergeMarker: z
    .object({
      suggestionId: z.string(),
      fromDocId: z.string(),
      fromTitle: z.string(),
      mergedAt: z.string(),
      sourceRefs: z.array(z.string()),
    })
    .optional(),
});

const TabSchema = z.object({
  key: z.string().regex(/^(?:indepth|eli5|sx[0-9a-f]{6})$/),
  kind: z.enum(['indepth', 'eli5', 'section-eli5']),
  label: z.string(),
  createdAt: z.string(),
  origin: z
    .object({
      sectionId: SectionIdSchema,
      selection: z.string(),
      scope: z.literal('selection').optional(),
      sectionIds: z.array(SectionIdSchema).optional(),
    })
    .optional(),
  placeholder: z.literal(true).optional(),
  sections: z.array(SectionSchema),
});

export const DocumentModelSchema = z.object({
  formatVersion: z.literal(1),
  docId: z.string(),
  slug: z.string(),
  title: z.string(),
  dek: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  generator: z.object({
    app: z.string(),
    version: z.string(),
    edition: z.enum(['public', 'enterprise']),
    runtimeVersion: z.string(),
  }),
  tabs: z.array(TabSchema).min(2),
  glossary: z.array(
    z.object({
      id: z.string().regex(/^g-[0-9a-f]{6}$/),
      term: z.string(),
      expansion: z.string().optional(),
      explanation: z.string(),
      sectionId: SectionIdSchema,
      blockIndex: z.number().int().min(0),
      anchorText: z.string(),
    }),
  ),
  references: z.array(
    z.object({
      status: z.enum(['used', 'skipped']),
      kind: z.enum(['file', 'url', 'clipboard-text', 'clipboard-image', 'org']),
      orgKind: z.string().optional(),
      label: z.string(),
      href: z.string().optional(),
      detail: z.string().optional(),
      reason: z.string().optional(),
      addedBy: z
        .object({ mergeFromTitle: z.string(), mergedAt: z.string(), mergeId: z.string().optional() })
        .optional(),
    }),
  ),
  assets: z.array(
    z.object({
      id: AssetIdSchema,
      mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
      width: z.number(),
      height: z.number(),
      sha256: z.string(),
      label: z.string(),
      credit: z
        .object({
          kind: z.literal('stock-photo'),
          title: z.string(),
          creator: z.string().optional(),
          license: z.enum(['cc0', 'pdm', 'by', 'by-sa']),
          licenseVersion: z.string().optional(),
          licenseUrl: z.string().optional(),
          sourceUrl: z.string().optional(),
          sourceName: z.string(),
          via: z.string().optional(),
        })
        .optional(),
    }),
  ),
  theme: z.object({ id: z.string(), version: z.string(), source: z.enum(['default', 'skill', 'overlay']) }),
  merges: z.array(z.object({ id: z.string(), fromTitle: z.string(), mergedAt: z.string() })).optional(),
});

// Compile-time checks that the schema and the 07 §3 types agree.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type _SchemaChecks = [
  Assert<Same<z.infer<typeof DocBlockSchema>, DocBlock>>,
  Assert<z.infer<typeof DocumentModelSchema> extends DocumentModel ? true : false>,
];
