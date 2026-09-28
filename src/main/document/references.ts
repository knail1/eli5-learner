// Public reference formatter (07 §10; HOOK-DOC-02 public behavior: never kind 'org').
import type { ResolvedSource, SkippedSource } from '../sources';
import type { ReferenceEntry, ReferenceFormatter, ReferenceKind } from './types';

/** Rendered when a skipped source has no reason text (07 §10). */
export const SKIPPED_REASON_FALLBACK = 'could not be read';

const FORMAT_NAMES: Record<string, string> = {
  pptx: 'PowerPoint',
  docx: 'Word',
  xlsx: 'Excel',
  pdf: 'PDF',
  markdown: 'Markdown',
  text: 'Text',
  csv: 'CSV',
  html: 'HTML',
  png: 'PNG image',
  jpeg: 'JPEG image',
  gif: 'GIF image',
  webp: 'WebP image',
  heic: 'HEIC image',
  tiff: 'TIFF image',
  bmp: 'BMP image',
};
const IMAGE_FORMATS = new Set(['png', 'jpeg', 'gif', 'webp', 'heic', 'tiff', 'bmp']);

function httpUrl(s: string): URL | undefined {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : undefined;
  } catch {
    return undefined;
  }
}

/** File name only; documents may be shared, so never a full path (07 §10). */
function baseName(s: string): string {
  const parts = s.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? s;
}

function hostAndPath(u: URL): string {
  const path = u.pathname === '/' ? '' : u.pathname;
  return u.host + path;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function wordCount(src: ResolvedSource): number | undefined {
  const p = src.payload;
  const text = p.kind === 'text' ? p.text : p.kind === 'html' ? p.html.replace(/<[^>]*>/g, ' ') : undefined;
  if (text === undefined) return undefined;
  const t = text.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

function fileEntry(src: ResolvedSource): ReferenceEntry {
  const name = FORMAT_NAMES[src.format] ?? src.format.toUpperCase();
  return {
    status: 'used',
    kind: 'file',
    label: baseName(src.ref),
    detail: `${name}, ${humanSize(src.sizeBytes)}`,
  };
}

function usedEntry(src: ResolvedSource): ReferenceEntry {
  if (src.location === 'clipboard' || src.resolverId === 'clipboard') {
    if (IMAGE_FORMATS.has(src.format)) {
      return { status: 'used', kind: 'clipboard-image', label: 'Pasted image' };
    }
    const words = wordCount(src);
    return {
      status: 'used',
      kind: 'clipboard-text',
      label: 'Pasted text',
      ...(words !== undefined ? { detail: `${words} words` } : {}),
    };
  }
  // URL lane, plus any other resolver (e.g. an overlay's) whose location is http(s): public
  // formatting only; organization labelling belongs to HOOK-DOC-02.
  const u = httpUrl(src.location);
  if (u) {
    return {
      status: 'used',
      kind: 'url',
      label: src.title?.trim() || hostAndPath(u),
      href: u.href,
      detail: 'Fetched page',
    };
  }
  return fileEntry(src);
}

function skippedKind(ref: string): ReferenceKind {
  if (/^pasted image/i.test(ref)) return 'clipboard-image';
  if (/^pasted text/i.test(ref)) return 'clipboard-text';
  return httpUrl(ref) ? 'url' : 'file';
}

function skippedEntry(s: SkippedSource): ReferenceEntry {
  const kind = skippedKind(s.ref);
  const u = kind === 'url' ? httpUrl(s.ref) : undefined;
  const label = u ? hostAndPath(u) : kind === 'file' ? baseName(s.ref) : s.ref;
  return {
    status: 'skipped',
    kind,
    label,
    ...(u ? { href: u.href } : {}),
    reason: s.reason.trim() || SKIPPED_REASON_FALLBACK,
  };
}

/** Public HOOK-DOC-02 binding: used sources in input order, then skipped (07 §10). */
export const defaultReferenceFormatter: ReferenceFormatter = ({ resolved, skipped }) => [
  ...resolved.map(usedEntry),
  ...skipped.map(skippedEntry),
];
