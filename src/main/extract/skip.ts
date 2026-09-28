/** Skip codes to human reasons (04 §8.2). Reasons never carry paths, stack traces or library names. */
import type { ResolvedSource, SkippedSource, SourceFormat } from '../sources';
import type { ExtractResult, ExtractSkipCode } from './types';

export interface SkipParams {
  size?: number;
  limit?: number;
  seconds?: number;
  maxImages?: number;
}

/** Thrown inside extractors; extractSource turns it into a SkippedSource. */
export class ExtractError extends Error {
  constructor(
    readonly code: ExtractSkipCode,
    /** Debug-log detail only; never shown to the user. */
    readonly detail = '',
    readonly params: SkipParams = {},
  ) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'ExtractError';
  }
}

const FORMAT_LABEL: Record<SourceFormat, string> = {
  pptx: 'PowerPoint file',
  docx: 'Word document',
  xlsx: 'Excel workbook',
  pdf: 'PDF',
  markdown: 'Markdown file',
  text: 'text file',
  csv: 'CSV file',
  html: 'HTML file',
  png: 'PNG image',
  jpeg: 'JPEG image',
  gif: 'GIF image',
  webp: 'WebP image',
  heic: 'HEIC image',
  tiff: 'TIFF image',
  bmp: 'BMP image',
};

/** "12.5 MB" style sizes (binary units, as 03's caps are). */
export function formatBytes(n: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const s = i === 0 ? String(v) : v.toFixed(1).replace(/\.0$/, '');
  return `${s} ${units[i]}`;
}

function extensionOf(source: Pick<ResolvedSource, 'location' | 'ref'>): string | undefined {
  for (const s of [source.location, source.ref]) {
    const m = /\.([A-Za-z0-9]{1,8})(?:[?#].*)?$/.exec(s);
    if (m?.[1]) return m[1].toLowerCase();
  }
  return undefined;
}

export function skipReason(
  code: ExtractSkipCode,
  source: Pick<ResolvedSource, 'location' | 'ref' | 'format'>,
  p: SkipParams = {},
): string {
  switch (code) {
    case 'unsupported-type': {
      const ext = extensionOf(source);
      return ext ? `Unsupported file type (.${ext})` : 'Unsupported file type';
    }
    case 'encrypted':
      return 'File is password protected';
    case 'corrupt':
      return `File could not be read (damaged or not a valid ${FORMAT_LABEL[source.format]})`;
    case 'empty':
      return 'No readable content found';
    case 'too-large':
      return p.size !== undefined && p.limit !== undefined
        ? `File too large (${formatBytes(p.size)}; limit ${formatBytes(p.limit)})`
        : 'File too large';
    case 'zip-bomb':
      return 'File expands to an unsafe size';
    case 'timeout':
      return p.seconds !== undefined ? `Took too long to read (over ${p.seconds}s)` : 'Took too long to read';
    case 'image-too-large':
      return 'Image too large to send';
    case 'image-budget-exceeded':
      return p.maxImages !== undefined
        ? `Too many images in one job (limit ${p.maxImages})`
        : 'Too many images in one job';
    case 'scan-render-failed':
      return 'Scanned PDF pages could not be rendered';
    case 'internal-error':
      return 'Unexpected error while reading this file';
    case 'cancelled':
      // A job cancel is not a timeout (03 §7.2 maps abort to cancelled; reason per 03 §9).
      return 'Job was cancelled';
  }
}

export function skippedSource(
  source: Pick<ResolvedSource, 'location' | 'ref' | 'format'>,
  code: ExtractSkipCode,
  p?: SkipParams,
): SkippedSource {
  return { ref: source.ref, reason: skipReason(code, source, p), code };
}

export function skip(
  source: Pick<ResolvedSource, 'location' | 'ref' | 'format'>,
  code: ExtractSkipCode,
  p?: SkipParams,
): ExtractResult {
  return { ok: false, skipped: skippedSource(source, code, p) };
}
