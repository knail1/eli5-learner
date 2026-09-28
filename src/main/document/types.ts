// Document model types (07 §3), theme (07 §11.3, HOOK-DOC-01), reference formatter (07 §10,
// HOOK-DOC-02) and the section-job payload 08 §3 places under src/main/document/.
import type { Edition } from '../editions';
import type { DocumentDraftTab, DraftBlock, GlossaryDraft, SectionDraft } from '../llm';
import type { ImageNormalizer } from './images';
import type { IdSource } from './section-id';
import type { ResolvedSource, SkippedSource } from '../sources';
import type {
  CreateSectionEli5Request,
  DocUpdatedEvent,
  MenuAction,
  ScrollToEvent,
  SectionAction,
  SectionActionRequest,
  SectionBusyEvent,
  SectionId,
} from '../../preload/contract';

// Shared with the preload contract; defined there, re-exported here (08 §3).
export type {
  CreateSectionEli5Request,
  DocUpdatedEvent,
  MenuAction,
  ScrollToEvent,
  SectionAction,
  SectionActionRequest,
  SectionBusyEvent,
  SectionId,
};

// ---------------------------------------------------------------------------
// Model (07 §3)
// ---------------------------------------------------------------------------

export type TabKind = 'indepth' | 'eli5' | 'section-eli5';

/** Tab keys (07 §4.1): 'indepth' | 'eli5' | 'sx' + 6 lowercase hex. */
export type FixedTabKey = 'indepth' | 'eli5';
export type TabKey = FixedTabKey | `sx${string}`;

export interface DocumentModel {
  formatVersion: 1;
  docId: string; // CatalogEntry.id (09); UUID v4
  slug: string; // topic slug, folder name under docs/
  title: string; // <= 120 chars
  dek?: string; // <= 300 chars
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // bumped by every mutation
  generator: { app: string; version: string; edition: Edition; runtimeVersion: string };
  tabs: Tab[]; // [indepth, eli5, ...section-eli5 in creation order]
  glossary: GlossaryNote[]; // in-depth tab only
  references: ReferenceEntry[]; // rendered as the last in-depth section
  assets: AssetRef[];
  theme: DocThemeRef;
  /** Merges that enhanced this document, oldest first (07 §8.1): one legend line each. */
  merges?: MergeLegendEntry[];
}

/** One woven-in merge (07 §8.1, §6.4). `id` ('m1', 'm2', …) is the `data-merge` value of its marks. */
export interface MergeLegendEntry {
  id: string;
  fromTitle: string;
  mergedAt: string;
}

/**
 * Text a merge inserted into one inline string of a block (07 §6.4): [start, end) offsets into
 * the string's plain text (`inlineText`), so markup changes never count as enhancements.
 */
export interface EnhRange {
  merge: string;
  start: number;
  end: number;
}

/**
 * Enhancement marks of one block. 'new': the whole block was added; 'updated': a non-text block
 * (chart, table, figure, …) was changed; 'text': inserted runs per inline string of the block
 * (paragraph/callout/analogy: 1, list: one per item, stepper: one per step).
 */
export type BlockEnhancement =
  { block: number; kind: 'new' | 'updated'; merge: string } | { block: number; kind: 'text'; parts: EnhRange[][] };

/** A section's enhancement marks; `added` when a merge inserted the whole section. */
export interface SectionEnhancement {
  added?: string;
  blocks: BlockEnhancement[];
}

/**
 * Where a section ELI5 tab came from. `scope: 'selection'` marks an "ELI5 this selection" tab (08 §7.5):
 * `selection` is the passage it explains (quoted at the top of the tab) and `sectionIds` every covered
 * section, first one = `sectionId`.
 */
export interface TabOrigin {
  sectionId: SectionId;
  selection: string;
  scope?: 'selection';
  sectionIds?: SectionId[];
}

export interface Tab {
  key: string; // TabKey; kept as string per 07 §3
  kind: TabKind;
  label: string; // 'In depth' | 'ELI5' | 'ELI5: <heading>'
  createdAt: string;
  origin?: TabOrigin; // section-eli5 only
  placeholder?: true; // ELI5 placeholder after eli5 step failure (06 §7.1)
  sections: Section[]; // 1..40 content sections (+ references section on indepth)
}

export interface Section {
  id: SectionId;
  kind: 'content' | 'references';
  heading: string; // <= 120 chars
  blocks: DocBlock[]; // references: [] (rendered from DocumentModel.references)
  origin: 'generated' | 'regenerated' | 'merged' | 'merge-marker' | 'placeholder';
  updatedAt: string;
  lastAction?: SectionAction;
  merge?: { fromDocId: string; fromTitle: string; mergedAt: string };
  /** Woven-merge highlights (07 §6.4); dropped when the section is regenerated (08). */
  enh?: SectionEnhancement;
  /** Legacy appended merges only (formats written before woven merges). */
  mergeMarker?: {
    suggestionId: string;
    fromDocId: string;
    fromTitle: string;
    mergedAt: string;
    sourceRefs: string[];
  };
}

// ---------------------------------------------------------------------------
// Content and visual components (07 §7.1; DraftBlock from 02 §10)
// ---------------------------------------------------------------------------

/** Figure block after its image is resolved to an asset (07 §3, §5.6). */
export interface FigureDocBlock {
  type: 'figure';
  assetId: string;
  caption: string;
  alt: string;
  annotations?: { x: number; y: number; text: string }[];
}

/**
 * DraftBlock with figures resolved to assets; every other variant is identical (07 §3). `photo`
 * slots never reach the model: build turns a resolved one into a figure and drops the rest (07 §7.4).
 */
export type DocBlock = Exclude<DraftBlock, { type: 'figure' } | { type: 'photo' }> | FigureDocBlock;
export type DocBlockType = DocBlock['type'];

export interface AssetRef {
  id: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  sha256: string;
  label: string;
  /** Stock photos only (07 §7.4): the attribution rendered under every figure that shows it. */
  credit?: AssetCredit;
}

/** Licenses a stock photo may carry: reuse and modification allowed, no NC or ND (07 §7.4). */
export type StockLicense = 'cc0' | 'pdm' | 'by' | 'by-sa';

/** Attribution for an open-licensed stock photo (07 §7.4): title, creator, source, license. */
export interface AssetCredit {
  kind: 'stock-photo';
  title: string;
  creator?: string;
  license: StockLicense;
  licenseVersion?: string;
  /** http(s) only; anything else is rendered as plain text. */
  licenseUrl?: string;
  /** The work's page at its source; http(s) only. */
  sourceUrl?: string;
  /** Where the work is hosted, e.g. "Flickr" or "Wikimedia Commons". */
  sourceName: string;
  /** The search service that found it, e.g. "Openverse". */
  via?: string;
}

/**
 * A resolved stock photo slot (07 §7.4), already downscaled and re-encoded by the pipeline. `slot`
 * is photoSlotKey(tab, sectionIndex, blockIndex) of the draft `photo` block it fills.
 */
export interface StockPhotoInput {
  slot: string;
  mime: 'image/jpeg' | 'image/png';
  bytes: Uint8Array;
  width: number;
  height: number;
  alt: string;
  caption: string;
  credit: AssetCredit;
}

// ---------------------------------------------------------------------------
// Glossary and references (07 §9, §10)
// ---------------------------------------------------------------------------

export interface GlossaryNote {
  id: string; // 'g-' + 6 hex
  term: string;
  expansion?: string;
  explanation: string; // <= 400 chars
  sectionId: SectionId; // in-depth section where the term first appears
  blockIndex: number;
  anchorText: string; // verbatim text wrapped in <dfn>
}

export type ReferenceKind = 'file' | 'url' | 'clipboard-text' | 'clipboard-image' | 'org';

export interface ReferenceEntry {
  status: 'used' | 'skipped';
  kind: ReferenceKind; // 'org': HOOK-DOC-02 only
  orgKind?: string; // kind 'org' only; open string defined by the HOOK-DOC-02 binding
  label: string; // file name (never a full path), page title, "Pasted text"
  href?: string; // http(s) only
  detail?: string;
  reason?: string; // skipped only, from SkippedSource.reason
  addedBy?: { mergeFromTitle: string; mergedAt: string; mergeId?: string };
}

/** Input to a ReferenceFormatter: the job's sources in input order (07 §5.1 step 7). */
export interface ReferenceFormatterInput {
  resolved: readonly ResolvedSource[];
  skipped: readonly SkippedSource[];
}

/**
 * HOOK-DOC-02 seam (registerReferenceFormatter). Returns used entries in input order, then
 * skipped entries. The public formatter never produces kind 'org'.
 */
export type ReferenceFormatter = (input: ReferenceFormatterInput) => ReferenceEntry[];

// ---------------------------------------------------------------------------
// Theme (07 §11, HOOK-DOC-01)
// ---------------------------------------------------------------------------

/** Every themeable custom property (07 §11.1). Only these names are accepted (07 §11.3). */
export const TOKEN_NAMES = [
  '--paper',
  '--paper-2',
  '--ink',
  '--ink-2',
  '--muted',
  '--rule',
  '--link',
  '--accent',
  '--accent-ink',
  '--highlight',
  '--viz-1',
  '--viz-2',
  '--viz-3',
  '--viz-4',
  '--viz-5',
  '--viz-6',
  '--viz-7',
  '--viz-8',
  '--viz-muted',
  '--viz-grid',
  '--callout-note',
  '--callout-warning',
  '--callout-key',
  '--gl-bg',
  '--gl-rule',
  '--pull-rule',
  '--font-serif',
  '--font-sans',
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];

/**
 * 07 §11.3. `tokens` are overrides written into `#eli5-theme` on top of DOC_RUNTIME_CSS, so a
 * theme may set any subset (the neutral default sets none and keeps the runtime's light/dark pairs).
 */
export interface DocTheme {
  id: string;
  version: string;
  tokens: Partial<Record<TokenName, string>>;
  footer?: string;
  logoSvg?: string; // sanitized per 07 §7.3
}

export interface DocThemeRef {
  id: string;
  version: string;
  source: 'default' | 'skill' | 'overlay';
}

// ---------------------------------------------------------------------------
// Section jobs (08 §3; lives in src/main/document/interactive/ per 08)
// ---------------------------------------------------------------------------

/** Channel eli5:doc:close-tab. */
export interface CloseTabRequest {
  slug: string;
  tabKey: string;
}

/** Stored on the Job record for kind === 'section' (06 §8.2). */
export interface SectionJobPayload {
  slug: string;
  tabKey: string;
  sectionId: SectionId;
  action: MenuAction;
  selectionText: string;
  note?: string;
  /** 'eli5-selection' only: every section the selection covers, first = sectionId (08 §7.5). */
  sectionIds?: SectionId[];
  heading: string; // source section heading at request time
  baseHash: string; // sectionHash(section) at request time (08 §6.3)
}

// ---------------------------------------------------------------------------
// Build, render and parse (07 §5, §8)
// ---------------------------------------------------------------------------

/** 07 §5 BuildInput, plus injectable seams (13 §3.2) and generator info. */
export interface BuildInput {
  docId: string;
  slug: string;
  now: string;
  indepth: DocumentDraftTab; // required
  eli5: DocumentDraftTab | null; // null -> placeholder tab (06 §7.1)
  glossary: GlossaryDraft | null; // null when the glossary toggle is off
  images: { label: string; mime: string; bytes: Uint8Array }[]; // ImageInput labels (02)
  /** Resolved stock photo slots (07 §7.4); unresolved `photo` blocks are dropped. */
  photos?: readonly StockPhotoInput[];
  resolved: ResolvedSource[];
  skipped: SkippedSource[];
  theme: DocTheme; // already resolved (theme.ts resolveDocTheme)
  themeSource?: DocThemeRef['source']; // default 'default'
  /** Default: crypto (07 §4.2); SeededIdSource in tests. */
  idSource?: IdSource;
  /** HOOK-DOC-02 formatter (registry referenceFormatter); default: the public formatter. */
  referenceFormatter?: ReferenceFormatter;
  /**
   * 07 §5.6 image normalization. Required so the app always injects createNativeImageNormalizer
   * (downscale, re-encode); passThroughNormalizer is for tests and refuses oversized images.
   */
  normalizeImage: ImageNormalizer;
  generator?: Partial<DocumentModel['generator']>;
}

export interface BuildResult {
  model: DocumentModel;
  warnings: string[];
  /** Asset bytes by AssetRef.id, for renderDocument (07 §5.6). */
  assets: Map<string, Uint8Array>;
}

/** The inlined runtime (07 §2: DOC_RUNTIME_JS / DOC_RUNTIME_CSS). */
export interface DocRuntime {
  js: string;
  css: string;
}

export interface RenderOptions {
  /** Default: the bundled build/doc-runtime output (runtime-assets.ts). */
  runtime?: DocRuntime;
  /** Default: defaultDocTheme. parseDocument returns the theme a file was rendered with. */
  theme?: DocTheme;
}

export interface ParsedDocument {
  model: DocumentModel;
  assets: Map<string, Uint8Array>;
  /** Theme recovered from `#eli5-theme`, the footer and the logo, so a re-render is byte-identical. */
  theme: DocTheme;
  /** Runtime blocks found in the file. */
  runtime: DocRuntime;
}

/** getSectionContext result (07 §8). */
export interface SectionContext {
  tab: Tab;
  section: Section;
  draft: SectionDraft;
  prev?: SectionDraft;
  next?: SectionDraft;
  outline: string[];
}

export interface MutationOptions {
  /** Default: crypto (07 §4.2). */
  idSource?: IdSource;
  /** Retired SectionIds from meta.json (07 §4.3): never reused. */
  retiredIds?: readonly string[];
  /**
   * Asset bytes recovered by parseDocument. When given, regenerated figures may only reference
   * images whose bytes are present (otherwise the block is dropped with 'figure-image-missing').
   */
  assets?: ReadonlyMap<string, Uint8Array>;
  /**
   * addSectionEli5Tab only: the sections an "ELI5 this selection" covers (08 §7.5). The tab is
   * labelled by the draft's topic and its origin records the selection scope.
   */
  selectionOf?: readonly SectionId[];
}
