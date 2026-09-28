/** Extraction limits and timeouts (04 §10.1, §10.2, §10.3). Constants, never settings. */
import type { SourceFormat } from '../sources';
import type { ExtractLimits } from './types';

const MiB = 1024 * 1024;

/** 04 §10.1. Tests may pass smaller values through ExtractContext.limits. */
export const DEFAULT_EXTRACT_LIMITS: Readonly<ExtractLimits> = Object.freeze({
  maxInputBytes: Object.freeze({ office: 100 * MiB, pdf: 100 * MiB, text: 10 * MiB, xlsx: 50 * MiB }),
  maxCharsPerSource: 400_000,
  pptx: Object.freeze({ maxSlides: 300, includeHidden: false }),
  pdf: Object.freeze({ maxPages: 500, minCharsPerPage: 40, maxRenderedPages: 30, renderPageTimeoutMs: 15_000 }),
  xlsx: Object.freeze({ maxSheets: 10, maxRows: 200, maxCols: 30 }),
  embeddedImagesPerSource: 8,
  images: Object.freeze({
    maxInputBytes: 20 * MiB,
    maxInputPixels: 50_000_000,
    targetLongEdgePx: 1568,
    minShortEdgePx: 200,
    maxOutputBytes: 3_750_000,
    maxAspect: 8,
  }),
});

/** 04 §7.4 job-wide image budget defaults. */
export const DEFAULT_IMAGE_BUDGET = Object.freeze({ maxImages: 20, maxTotalBytes: 20_000_000 });

/** 04 §10.3 archive limits. */
export const ZIP_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxTotalUncompressed: 1024 * MiB,
  maxXmlPartBytes: 100 * MiB,
});

/** 04 §10.2 per-format timeouts (ms). */
export const EXTRACT_TIMEOUTS_MS = Object.freeze({
  text: 10_000,
  officeDoc: 30_000,
  pptx: 45_000,
  pdfText: 60_000,
  pdfScannedBase: 120_000,
  pdfPerRenderedPage: 15_000,
  image: 15_000,
  sips: 15_000,
});

const IMAGE_FORMATS: ReadonlySet<SourceFormat> = new Set(['png', 'jpeg', 'gif', 'webp', 'heic', 'tiff', 'bmp']);

export function isImageFormat(format: SourceFormat): boolean {
  return IMAGE_FORMATS.has(format);
}

/**
 * Overall budget for one source. A PDF may need rendering, which is only known after the text
 * pass, so it gets the scanned budget; the text pass itself is bounded at pdfText inside pdf.ts.
 */
export function timeoutFor(format: SourceFormat, limits: ExtractLimits): number {
  switch (format) {
    case 'pptx':
      return EXTRACT_TIMEOUTS_MS.pptx;
    case 'docx':
    case 'xlsx':
      return EXTRACT_TIMEOUTS_MS.officeDoc;
    case 'pdf':
      return EXTRACT_TIMEOUTS_MS.pdfScannedBase + EXTRACT_TIMEOUTS_MS.pdfPerRenderedPage * limits.pdf.maxRenderedPages;
    case 'markdown':
    case 'text':
    case 'csv':
    case 'html':
      return EXTRACT_TIMEOUTS_MS.text;
    default:
      // Images: header check, optional sips, then normalization (each bounded at 15 s).
      return EXTRACT_TIMEOUTS_MS.image + EXTRACT_TIMEOUTS_MS.sips;
  }
}

/** Per-format input cap (04 §10.1), applied in extractSource step 2. */
export function inputCapFor(format: SourceFormat, limits: ExtractLimits): number {
  switch (format) {
    case 'pptx':
    case 'docx':
      return limits.maxInputBytes.office;
    case 'pdf':
      return limits.maxInputBytes.pdf;
    case 'xlsx':
      return limits.maxInputBytes.xlsx;
    case 'markdown':
    case 'text':
    case 'csv':
    case 'html':
      return limits.maxInputBytes.text;
    default:
      return limits.images.maxInputBytes;
  }
}
