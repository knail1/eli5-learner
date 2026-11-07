/**
 * zod schemas for on-disk library JSON (09 §5). Each schema is checked at compile time against the
 * matching TS type in ./types, so the runtime check and the type cannot drift (09 §5 intro).
 */
import { z } from 'zod';
import type { SkippedSource } from '../sources';
import type { JobWarning } from '../pipeline';
import type {
  ActionRecord,
  AskRecord,
  CatalogEntry,
  CatalogFile,
  DocumentMeta,
  MergeRecord,
  MergeSuggestion,
  SectionId,
  SourceRecord,
  SuggestionsFile,
  TabRecord,
  VersionNodeFile,
  VersionNodeRecord,
  VersionTreeFile,
} from './types';
import { SLUG_PATTERN } from './slug';

export const CATALOG_SCHEMA_VERSION = 1;
export const META_SCHEMA_VERSION = 1;
export const SUGGESTIONS_SCHEMA_VERSION = 1;
/** `.versions/tree.json` and `.versions/nodes/<id>.json` (09 §4.1). */
export const TREE_SCHEMA_VERSION = 1;
/** A version node id: 'v-' + 12 hex. */
export const VERSION_ID_RE = /^v-[0-9a-f]{12}$/;
/** An answer box id: 'q-' + 8 hex (07 §4). */
export const QA_ID_RE = /^q-[0-9a-f]{8}$/;

/** 07 §4 (mirrored in the preload contract). */
export const SECTION_ID_PATTERN = /^sec-[a-z][a-z0-9]{1,15}-[0-9a-f]{8}$/;
/** 'indepth', 'eli5', or 'sx' + 6 hex (07 §4.1). */
export const TAB_KEY_PATTERN = /^(indepth|eli5|sx[0-9a-f]{6})$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** ISO 8601 UTC timestamp (09 §5). */
const Timestamp = z.iso.datetime();
const Slug = z.string().regex(SLUG_PATTERN);
const SchemaVersion = z.number().int().min(1);
const SummarySource = z.enum(['llm', 'fallback']);

export const SectionIdSchema = z.custom<SectionId>((v) => typeof v === 'string' && SECTION_ID_PATTERN.test(v), {
  message: 'Invalid SectionId',
});

/** Shape owned by 03 (SkippedSource); SkipCode membership is 03's concern. */
const SkippedSourceSchema = z.custom<SkippedSource>(
  (v) => isRecord(v) && typeof v.ref === 'string' && typeof v.reason === 'string' && typeof v.code === 'string',
  { message: 'Invalid SkippedSource' },
);

/** Shape owned by 06 (JobWarning). */
const JobWarningSchema = z.custom<JobWarning>(
  (v) => isRecord(v) && typeof v.kind === 'string' && typeof v.message === 'string',
  { message: 'Invalid JobWarning' },
);

// ---- catalog.json (09 §5.1) ----

export const CatalogEntrySchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(200),
  topicSlug: Slug,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  summary: z.string().max(300),
  summarySource: SummarySource,
  tabCount: z.number().int().min(0),
  mergedFromCount: z.number().int().min(0),
});

export const CatalogFileSchema = z.object({
  schemaVersion: SchemaVersion,
  appVersion: z.string(),
  updatedAt: Timestamp,
  entries: z.array(CatalogEntrySchema),
});

// ---- meta.json (09 §5.2) ----

export const SourceRecordSchema = z.object({
  ref: z.string().min(1),
  kind: z.enum(['file', 'clipboard', 'url', 'mcp']),
  mimeType: z.string().optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  origin: z.string().optional(),
});

export const TabRecordSchema = z.object({
  key: z.string().regex(TAB_KEY_PATTERN),
  kind: z.enum(['indepth', 'eli5', 'section-eli5']),
  label: z.string(),
  sectionCount: z.number().int().min(0),
  sourceSectionId: SectionIdSchema.optional(),
  createdAt: Timestamp,
});

export const MergeRecordSchema = z.object({
  suggestionId: z.string(),
  sourceDocId: z.string(),
  sourceTitle: z.string(),
  sourceSlug: z.string(),
  sourceSummary: z.string(),
  mergedAt: Timestamp,
  anchorSectionIds: z.array(SectionIdSchema),
});

/** 08 §6.6. */
export const ActionRecordSchema = z.object({
  at: Timestamp,
  action: z.enum(['expand', 'reexplain', 'analogy', 'deeper', 'revise', 'eli5-tab', 'eli5-selection']),
  sectionId: SectionIdSchema,
  sectionIds: z.array(SectionIdSchema).optional(),
  tabKey: z.string(),
  note: z.string().optional(),
  jobId: z.string(),
  resultTabKey: z.string().optional(),
});

/** 08 §6.8. */
export const AskRecordSchema = z.object({
  at: Timestamp,
  sectionId: SectionIdSchema,
  tabKey: z.string(),
  question: z.string().min(1).max(500),
  qaId: z.string().regex(QA_ID_RE),
  jobId: z.string(),
});

/** 10 §3.2. */
export const PublicationRecordSchema = z.object({
  targetId: z.string(),
  kind: z.enum(['local', 'drive', 'git']),
  publishedAt: Timestamp,
  primaryUrl: z.string(),
  contentSha256: z.string(),
});

/**
 * Not strict: `.loose()` (zod 4's passthrough) preserves unknown fields written by siblings or a
 * newer minor build; `retiredIds` and `publications` default to [] (09 §5.2).
 */
export const DocumentMetaSchema = z
  .object({
    schemaVersion: SchemaVersion,
    id: z.uuid(),
    topicSlug: Slug,
    title: z.string().min(1).max(200),
    summary: z.string().max(300),
    summarySource: SummarySource,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    jobId: z.string().min(1),
    edition: z.enum(['public', 'enterprise']),
    clarifyingInput: z.string(),
    glossaryEnabled: z.boolean(),
    sourcesUsed: z.array(SourceRecordSchema),
    sourcesSkipped: z.array(SkippedSourceSchema),
    tabs: z.array(TabRecordSchema),
    retiredIds: z.array(SectionIdSchema).default([]),
    generation: z.object({
      provider: z.string(),
      model: z.string(),
      prompts: z.array(z.string()),
    }),
    warnings: z.array(JobWarningSchema),
    merges: z.array(MergeRecordSchema),
    actions: z.array(ActionRecordSchema).optional(),
    asks: z.array(AskRecordSchema).optional(),
    publications: z.array(PublicationRecordSchema).default([]),
    versionId: z.string().regex(VERSION_ID_RE).optional(),
  })
  .loose();

// ---- .versions/ (09 §4.1) ----

const VersionId = z.string().regex(VERSION_ID_RE);

export const VersionNodeRecordSchema = z.object({
  id: VersionId,
  parentId: VersionId.nullable(),
  createdAt: Timestamp,
  kind: z.enum([
    'expand',
    'reexplain',
    'analogy',
    'deeper',
    'revise',
    'eli5-tab',
    'eli5-selection',
    'ask',
    'close-tab',
    'merge',
    'outside',
    'initial',
  ]),
  label: z.string().min(1).max(200),
  topic: z.string().min(1).max(48),
  heading: z.string().max(80).optional(),
  question: z.string().max(500).optional(),
  target: z
    .object({ tabKey: z.string().optional(), sectionId: SectionIdSchema.optional(), anchorId: z.string().optional() })
    .optional(),
  undoTarget: z.object({ tabKey: z.string().optional(), sectionId: SectionIdSchema.optional() }).optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  bytes: z.number().int().min(0),
  forwardId: VersionId.optional(),
  jobId: z.string().optional(),
});

export const VersionTreeFileSchema = z.object({
  schemaVersion: SchemaVersion,
  rootId: VersionId,
  currentId: VersionId,
  nodes: z.array(VersionNodeRecordSchema).min(1),
});

export const VersionNodeFileSchema = z.object({
  schemaVersion: SchemaVersion,
  node: VersionNodeRecordSchema,
  meta: DocumentMetaSchema,
});

// ---- .eli5/suggestions.json (09 §10.4, §10.5) ----

const DocRef = z.object({ id: z.string(), slug: z.string(), title: z.string() });

export const MergeSuggestionSchema = z.object({
  id: z.uuid(),
  createdAt: Timestamp,
  status: z.enum(['pending', 'accepting', 'accepted', 'dismissed', 'stale']),
  source: DocRef,
  target: DocRef,
  score: z.number().min(0).max(1),
  reason: z.string().max(200),
  scorer: z.enum(['lexical+llm', 'embedding+llm']),
  resolvedAt: Timestamp.optional(),
  lastError: z.string().optional(),
});

export const SuggestionsFileSchema = z.object({
  schemaVersion: z.literal(1),
  suggestions: z.array(MergeSuggestionSchema),
  dismissedPairs: z.array(z.object({ a: z.string(), b: z.string(), at: Timestamp })),
});

// ---- compile-time drift checks (both directions) ----

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type Out<S extends z.ZodType> = z.output<S>;
type _SchemaDriftChecks = [
  Assert<Same<Out<typeof CatalogEntrySchema>, CatalogEntry>>,
  Assert<Same<Out<typeof CatalogFileSchema>, CatalogFile>>,
  Assert<Same<Out<typeof SourceRecordSchema>, SourceRecord>>,
  Assert<Same<Out<typeof TabRecordSchema>, TabRecord>>,
  Assert<Same<Out<typeof MergeRecordSchema>, MergeRecord>>,
  Assert<Same<Out<typeof ActionRecordSchema>, ActionRecord>>,
  Assert<Same<Out<typeof AskRecordSchema>, AskRecord>>,
  Assert<Same<Out<typeof VersionNodeRecordSchema>, VersionNodeRecord>>,
  Assert<Same<Out<typeof VersionTreeFileSchema>, VersionTreeFile>>,
  Assert<Out<typeof VersionNodeFileSchema> extends VersionNodeFile ? true : false>,
  Assert<Same<Out<typeof MergeSuggestionSchema>, MergeSuggestion>>,
  Assert<Same<Out<typeof SuggestionsFileSchema>, SuggestionsFile>>,
  // loose() adds an index signature, so the parsed meta is a DocumentMeta plus unknown extras.
  Assert<Out<typeof DocumentMetaSchema> extends DocumentMeta ? true : false>,
  Assert<{ [K in keyof DocumentMeta]: DocumentMeta[K] } extends z.input<typeof DocumentMetaSchema> ? true : false>,
];
