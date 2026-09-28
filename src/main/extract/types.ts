/** Extraction data model and extractor contract (04 §2, §3, §6.3, §7, §8.2, §10.1). */
import type { ResolvedSource, SkipCode, SkippedSource, SourceFormat } from '../sources';

// ---- 04 §2 Data model ----

/** The resolver's format, except that a PDF whose every processed page is image-only is
 *  reported as 'pdf-scanned' (§6.2). 'pdf-scanned' exists only here, never in SourceFormat. */
export type ExtractedFormat = SourceFormat | 'pdf-scanned';

export interface ExtractedContent {
  /** ResolvedSource.id, e.g. "src-03". */
  sourceId: string;
  /** ResolvedSource.ref: the human label used in status and references. */
  sourceRef: string;
  /** ResolvedSource.format, or 'pdf-scanned' (§6.2). */
  format: ExtractedFormat;
  /** Best-effort document title (pptx: first slide title; docx: core title or first H1). */
  title?: string;
  blocks: ContentBlock[];
  /** Images referenced by ImageBlock.imageId, already normalized for vision (§7). */
  images: ImageAsset[];
  stats: ExtractStats;
  /** Non-fatal issues. */
  warnings: string[];
  /** True when any cap in §10 cut content. The reason appears in warnings. */
  truncated: boolean;
}

export interface ExtractStats {
  chars: number; // total text characters across blocks
  approxTokens: number; // chars / 4, rounded up
  pages?: number; // pdf
  scannedPages?: number; // pdf: pages classified image-only (§6.2)
  slides?: number; // pptx
  sheets?: number; // xlsx
  imagesKept: number;
  imagesDropped: number;
  elapsedMs: number;
}

export type ContentBlock =
  HeadingBlock | ParagraphBlock | ListBlock | TableBlock | SlideBlock | NotesBlock | ImageBlock | PageBlock;

export interface HeadingBlock {
  kind: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}
export interface ParagraphBlock {
  kind: 'paragraph';
  text: string;
  style?: 'quote' | 'code';
}
export interface ListBlock {
  kind: 'list';
  ordered: boolean;
  items: ListItem[];
}
/** Nesting = bullet hierarchy. */
export interface ListItem {
  text: string;
  children?: ListItem[];
}
export interface TableBlock {
  kind: 'table';
  caption?: string; // xlsx: sheet name; docx: preceding "Caption" paragraph
  header?: string[]; // first row when it is recognizably a header
  rows: string[][]; // merged cells repeat text in the first cell only
  truncated?: { rows?: number; cols?: number }; // how many were dropped
}
export interface SlideBlock {
  kind: 'slide';
  index: number; // 1-based, presentation order
  title?: string;
  hidden?: boolean;
  blocks: ContentBlock[];
  notes?: NotesBlock;
}
/** Speaker notes. */
export interface NotesBlock {
  kind: 'notes';
  text: string;
}
export interface ImageBlock {
  kind: 'image';
  imageId: string; // key into ExtractedContent.images
  alt?: string;
  origin: 'embedded' | 'standalone' | 'page-render';
}
/** number is 1-based. */
export interface PageBlock {
  kind: 'page';
  number: number;
  blocks: ContentBlock[];
}

export interface ImageAsset {
  id: string; // "<sourceHash8>-img-<n>"
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: Uint8Array; // post-normalization bytes (§7)
  width: number;
  height: number;
  byteLength: number;
  distinctColors?: number; // capped count from §7.1 step 5
  origin: ImageBlock['origin'];
  pageOrSlide?: number;
}

// ---- 04 §6.3, §7.1, §7.4 injected services ----

export type PdfPageRenderer = (
  pdf: Uint8Array,
  pages: number[], // 1-based
  opts: { targetLongEdgePx: number; signal: AbortSignal },
) => Promise<Array<{ page: number; png: Uint8Array; width: number; height: number } | { page: number; error: string }>>;

export type ImageNormalizer = (
  bytes: Uint8Array,
  mediaType: string,
  opts: { origin: ImageBlock['origin']; signal: AbortSignal },
) => Promise<{ ok: true; assets: ImageAsset[] } | { ok: false; code: 'image-too-large' | 'corrupt' }>;

export interface ImageBudget {
  readonly maxImages: number; // default 20 per job
  readonly maxTotalBytes: number; // default 20 MB per job, post-normalization
  tryReserve(bytes: number, priority: 'standalone' | 'page-render' | 'embedded'): boolean;
}

// ---- 04 §10.1 limits (constants, not settings; values live in limits.ts, M1) ----

export interface ExtractLimits {
  maxInputBytes: { office: number; pdf: number; text: number; xlsx: number };
  maxCharsPerSource: number;
  pptx: { maxSlides: number; includeHidden: boolean };
  pdf: { maxPages: number; minCharsPerPage: number; maxRenderedPages: number; renderPageTimeoutMs: number };
  xlsx: { maxSheets: number; maxRows: number; maxCols: number };
  embeddedImagesPerSource: number;
  /** §7.1 table. maxAspect is the long:short ratio (8 for 1:8). */
  images: {
    maxInputBytes: number;
    maxInputPixels: number;
    targetLongEdgePx: number;
    minShortEdgePx: number;
    maxOutputBytes: number;
    maxAspect: number;
  };
}

// ---- 04 §3 Extractor interface ----

export interface ExtractContext {
  signal: AbortSignal; // aborted on timeout or job cancel
  limits: ExtractLimits; // §10.1
  imageBudget: ImageBudget; // shared across all sources in one job (§7.4)
  renderPdfPages: PdfPageRenderer; // injected (§6.3)
  normalizeImage: ImageNormalizer; // injected (§7.1)
  log: (msg: string) => void; // debug log only
}

export type ExtractResult = { ok: true; content: ExtractedContent } | { ok: false; skipped: SkippedSource };

export interface Extractor {
  readonly id: string; // 'pptx', 'docx', ...
  readonly formats: readonly SourceFormat[];
  /** Pure, synchronous check on ResolvedSource.format; no parsing. */
  canHandle(source: ResolvedSource): boolean;
  extract(source: ResolvedSource, ctx: ExtractContext): Promise<ExtractResult>;
}

// ---- 04 §8.2 skip codes ----

/** The SkipCode values extraction may emit. A subset of 03's SkipCode, not a new union. */
export type ExtractSkipCode = Extract<
  SkipCode,
  | 'unsupported-type'
  | 'encrypted'
  | 'corrupt'
  | 'empty'
  | 'too-large'
  | 'zip-bomb'
  | 'timeout'
  | 'image-too-large'
  | 'image-budget-exceeded'
  | 'scan-render-failed'
  | 'internal-error'
>;
