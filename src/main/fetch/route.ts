import { LIMITS, type Limits } from './constants';

/** Content-type sniffing, routing table, filenames and charset decoding (05 §4.6, §4.7). */

export const MIME = {
  html: 'text/html',
  xhtml: 'application/xhtml+xml',
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

const OOXML_BY_EXT: Record<string, string> = { pptx: MIME.pptx, docx: MIME.docx, xlsx: MIME.xlsx };
const EXT_BY_MIME: Record<string, string> = {
  [MIME.html]: 'html',
  [MIME.pdf]: 'pdf',
  [MIME.png]: 'png',
  [MIME.jpeg]: 'jpg',
  [MIME.gif]: 'gif',
  [MIME.webp]: 'webp',
  [MIME.svg]: 'svg',
  [MIME.pptx]: 'pptx',
  [MIME.docx]: 'docx',
  [MIME.xlsx]: 'xlsx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'application/json': 'json',
  'text/csv': 'csv',
};

/** `Content-Type` without parameters, lowercased; '' when absent. */
export function headerMime(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

function startsWith(b: Uint8Array, sig: number[], at = 0): boolean {
  if (b.length < at + sig.length) return false;
  return sig.every((x, i) => b[at + i] === x);
}
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** Magic-byte sniffing (§4.6 table). `nameHint` is the URL path or filename, for OOXML. */
export function sniffBytes(b: Uint8Array, nameHint: string): string | null {
  if (startsWith(b, ascii('%PDF-'))) return MIME.pdf;
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return MIME.png;
  if (startsWith(b, [0xff, 0xd8, 0xff])) return MIME.jpeg;
  if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))) return MIME.gif;
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8)) return MIME.webp;
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) {
    const ext = /\.([a-z0-9]+)$/i.exec(nameHint)?.[1]?.toLowerCase();
    return (ext && OOXML_BY_EXT[ext]) ?? null;
  }
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return MIME.html;
  return null;
}

const SNIFF_WHEN = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const MAGIC_TYPES = new Set<string>([MIME.pdf, MIME.png, MIME.jpeg, MIME.gif, MIME.webp]);

/**
 * The effective MIME type: the header, unless it is missing/octet-stream or contradicts a PDF or
 * image magic number (§4.6: servers mislabel often).
 */
export function effectiveMime(declared: string, head: Uint8Array, nameHint: string): string {
  const sniffed = sniffBytes(head, nameHint);
  if (SNIFF_WHEN.has(declared)) return sniffed ?? declared;
  if (sniffed && MAGIC_TYPES.has(sniffed) && sniffed !== declared) return sniffed;
  // A zip body served under a generic type still becomes OOXML by extension (e.g. application/zip).
  if (sniffed && (declared === 'application/zip' || declared === 'application/x-zip-compressed')) return sniffed;
  return declared;
}

export type Route =
  | { lane: 'html' }
  | { lane: 'binary'; mime: string; capBytes: number }
  | { lane: 'svg'; capBytes: number } // delivered as text/plain of the SVG source (§4.6)
  | { lane: 'unsupported'; mime: string };

/** §4.6 routing table and §4.5 caps. */
export function routeMime(mime: string, limits: Limits = LIMITS): Route {
  switch (mime) {
    case MIME.html:
    case MIME.xhtml:
      return { lane: 'html' };
    case MIME.pdf:
    case MIME.pptx:
    case MIME.docx:
    case MIME.xlsx:
      return { lane: 'binary', mime, capBytes: limits.MAX_DOCUMENT_BYTES };
    case MIME.png:
    case MIME.jpeg:
    case MIME.gif:
    case MIME.webp:
      return { lane: 'binary', mime, capBytes: limits.MAX_IMAGE_BYTES };
    case MIME.svg:
      return { lane: 'svg', capBytes: limits.MAX_SVG_BYTES };
    case 'text/plain':
    case 'text/markdown':
    case 'text/x-markdown':
    case 'application/json':
    case 'text/csv':
      return { lane: 'binary', mime, capBytes: limits.MAX_TEXT_BYTES };
    default:
      return { lane: 'unsupported', mime: mime || 'unknown' };
  }
}

/** Cap used for the Content-Length pre-check before sniffing (§4.5 step 1). HTML is never pre-checked (§4.5 step 3). */
export function declaredCap(declared: string, limits: Limits = LIMITS): number | null {
  if (SNIFF_WHEN.has(declared)) return limits.MAX_DOCUMENT_BYTES;
  const r = routeMime(declared, limits);
  return r.lane === 'binary' || r.lane === 'svg' ? r.capBytes : null;
}

/** Removes path separators and control characters; at most 120 chars (§4.6). */
export function sanitizeFilename(name: string, max: number = LIMITS.FILENAME_MAX): string {
  // eslint-disable-next-line no-control-regex
  let s = name.replace(/[/\\\u0000-\u001f\u007f]/g, '').trim();
  s = s.replace(/^\.+/, '');
  if (s.length > max) {
    const ext = /\.[a-z0-9]{1,8}$/i.exec(s)?.[0] ?? '';
    s = s.slice(0, max - ext.length) + ext;
  }
  return s;
}

function parseContentDisposition(cd: string): string | null {
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd);
  if (star?.[2]) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through to filename= */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(cd);
  const v = plain?.[2] ?? plain?.[1];
  return v ? v.trim() : null;
}

/** Content-Disposition `filename*` or `filename`, else the last URL path segment, else download.<ext>. */
export function filenameFor(contentDisposition: string | undefined, url: string, mime: string): string {
  const ext = EXT_BY_MIME[mime] ?? 'bin';
  const fromCd = contentDisposition ? parseContentDisposition(contentDisposition) : null;
  let name = fromCd ? sanitizeFilename(fromCd) : '';
  if (!name) {
    try {
      const seg = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
      name = sanitizeFilename(decodeURIComponent(seg));
    } catch {
      name = '';
    }
  }
  if (!name) name = `download.${ext}`;
  else if (!/\.[a-z0-9]{1,8}$/i.test(name)) name = sanitizeFilename(`${name}.${ext}`);
  return name;
}

// ---- charset decoding (§4.7) ----

function bomCharset(b: Uint8Array): { label: string; skip: number } | null {
  if (startsWith(b, [0xef, 0xbb, 0xbf])) return { label: 'utf-8', skip: 3 };
  if (startsWith(b, [0xff, 0xfe])) return { label: 'utf-16le', skip: 2 };
  if (startsWith(b, [0xfe, 0xff])) return { label: 'utf-16be', skip: 2 };
  return null;
}

function metaCharset(b: Uint8Array): string | null {
  const head = new TextDecoder('windows-1252').decode(b.subarray(0, 1024));
  const m =
    /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head) ??
    /<meta[^>]+content\s*=\s*["'][^"']*charset=([a-z0-9_:.-]+)/i.exec(head);
  return m?.[1] ?? null;
}

function makeDecoder(label: string): TextDecoder {
  try {
    return new TextDecoder(label, { fatal: false });
  } catch {
    return new TextDecoder('windows-1252', { fatal: false }); // WHATWG fallback for unknown labels
  }
}

/** BOM, then Content-Type charset, then meta charset in the first 1024 bytes, then UTF-8. */
export function decodeBody(bytes: Uint8Array, contentType: string | undefined, isHtml = true): string {
  const bom = bomCharset(bytes);
  if (bom) return makeDecoder(bom.label).decode(bytes.subarray(bom.skip));
  const param = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? '')?.[1];
  if (param) return makeDecoder(param).decode(bytes);
  const meta = isHtml ? metaCharset(bytes) : null;
  return makeDecoder(meta ?? 'utf-8').decode(bytes);
}
