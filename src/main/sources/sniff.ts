/**
 * The app's only format classifier (03 §5.2). Magic bytes decide the family; the extension only
 * disambiguates within the text family and is otherwise advisory (a mismatch adds a note).
 */
import path from 'node:path';
import type { SniffResult, SourceFormat } from './types';

export interface SniffOptions {
  /** Response Content-Type; tie-breaker for the text family only (03 §5.2). */
  declaredMediaType?: string;
  /** Reads one ZIP entry by name (for [Content_Types].xml); null when absent. */
  readZipEntry?: (name: string) => Promise<Buffer | null>;
  /** Stream names of an OLE compound file. */
  oleStreamNames?: () => Promise<string[]>;
}

/** Bytes read from the start of a file for sniffing (03 §5.1 step 4). */
export const SNIFF_HEAD_BYTES = 8 * 1024;

export const MEDIA_TYPES: Readonly<Record<SourceFormat, string>> = Object.freeze({
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  markdown: 'text/markdown',
  text: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
});

type TextFormat = 'markdown' | 'text' | 'csv' | 'html';
const TEXT_FORMATS: ReadonlySet<SourceFormat> = new Set<SourceFormat>(['markdown', 'text', 'csv', 'html']);

/** Extension -> format for binary families; used only for the mismatch note. */
const BINARY_EXT: Readonly<Record<string, SourceFormat>> = {
  pdf: 'pdf',
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  jpe: 'jpeg',
  gif: 'gif',
  webp: 'webp',
  heic: 'heic',
  heif: 'heic',
  tif: 'tiff',
  tiff: 'tiff',
  bmp: 'bmp',
  pptx: 'pptx',
  pptm: 'pptx',
  docx: 'docx',
  docm: 'docx',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
};

const OOXML_EXT = new Set(['pptx', 'docx', 'xlsx', 'pptm', 'docm', 'xlsm']);

/** Text family by extension (03 §5.2 text table). */
const TEXT_EXT: Readonly<Record<string, TextFormat>> = {
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  csv: 'csv',
  tsv: 'csv',
};
/** Plain-text extensions that map to `text` without the "treated as plain text" note. */
const PLAIN_EXT = new Set(
  (
    'txt text json yaml yml log xml ini toml conf cfg env properties sql graphql gql proto ' +
    'js mjs cjs jsx ts tsx mts cts py rb go rs java kt kts scala swift m mm c h cc cpp cxx hpp hh cs fs ' +
    'php pl pm r lua sh bash zsh fish ps1 bat cmd dart ex exs erl hs clj elm vue svelte css scss sass less ' +
    'tex rst adoc org diff patch gradle cmake make mk dockerfile tf hcl nix vim el'
  ).split(' '),
);

const DECLARED_TEXT: Readonly<Record<string, TextFormat>> = {
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
  'text/csv': 'csv',
  'text/tab-separated-values': 'csv',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'text/plain': 'text',
};

const LABEL: Readonly<Record<SourceFormat, string>> = {
  pptx: 'PowerPoint',
  docx: 'Word',
  xlsx: 'Excel',
  pdf: 'PDF',
  markdown: 'text',
  text: 'text',
  csv: 'text',
  html: 'text',
  png: 'PNG',
  jpeg: 'JPEG',
  gif: 'GIF',
  webp: 'WebP',
  heic: 'HEIC',
  tiff: 'TIFF',
  bmp: 'BMP',
};

const OOXML_MAIN: ReadonlyArray<[SourceFormat, RegExp]> = [
  ['pptx', /presentationml\.presentation\.main\+xml|ms-powerpoint\.presentation\.macroenabled\.main\+xml/i],
  ['docx', /wordprocessingml\.document\.main\+xml|ms-word\.document\.macroenabled\.main\+xml/i],
  ['xlsx', /spreadsheetml\.sheet\.main\+xml|ms-excel\.sheet\.macroenabled\.main\+xml/i],
];

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
const BMP_DIB_SIZES = new Set([12, 16, 40, 52, 56, 64, 108, 124]);

function extOf(fileName: string): string {
  return path.extname(fileName).slice(1).toLowerCase();
}

function startsWith(head: Buffer, bytes: number[], offset = 0): boolean {
  if (head.length < offset + bytes.length) return false;
  return bytes.every((b, i) => head[offset + i] === b);
}

function ok(format: SourceFormat, notes: string[]): SniffResult {
  return { ok: true, format, mediaType: MEDIA_TYPES[format], notes };
}

function fail(code: 'unsupported-type' | 'legacy-office-format' | 'encrypted', detail: string): SniffResult {
  return { ok: false, code, detail };
}

/** Binary family from magic bytes, or null when no signature matches. */
async function magic(head: Buffer, ext: string, opts: SniffOptions): Promise<SniffResult | null> {
  if (startsWith(head, PDF_MAGIC)) return ok('pdf', []);
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return ok('png', []);
  if (startsWith(head, [0xff, 0xd8, 0xff])) return ok('jpeg', []);
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) {
    return ok('gif', []);
  }
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) {
    return ok('webp', []);
  }
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) return ok('tiff', []);
  if (startsWith(head, [0x42, 0x4d]) && head.length >= 18 && BMP_DIB_SIZES.has(head.readUInt32LE(14))) {
    return ok('bmp', []);
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    const ct = opts.readZipEntry ? await opts.readZipEntry('[Content_Types].xml').catch(() => null) : null;
    const xml = ct?.toString('utf8') ?? '';
    for (const [format, re] of OOXML_MAIN) if (re.test(xml)) return ok(format, []);
    return fail('unsupported-type', 'ZIP archive');
  }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    const names = opts.oleStreamNames ? await opts.oleStreamNames().catch(() => []) : [];
    if (names.includes('EncryptedPackage') || OOXML_EXT.has(ext))
      return fail('encrypted', 'File is password protected');
    return fail('legacy-office-format', 'Older Office format; re-save as .pptx, .docx, or .xlsx');
  }
  if (startsWith(head, [0x66, 0x74, 0x79, 0x70], 4)) {
    const boxEnd = Math.min(head.length, head.length >= 4 ? head.readUInt32BE(0) : 0);
    const brands = [head.toString('latin1', 8, 12)];
    for (let o = 16; o + 4 <= boxEnd; o += 4) brands.push(head.toString('latin1', o, o + 4));
    const major = brands[0] ?? '';
    const avif = brands.some((b) => AVIF_BRANDS.has(b));
    const heicProper = brands.some((b) => HEIC_BRANDS.has(b) && b !== 'mif1' && b !== 'msf1');
    // mif1/msf1 are generic HEIF brands; an AVIF compatible brand without a HEVC brand means AVIF.
    if (AVIF_BRANDS.has(major) || (avif && !heicProper))
      return fail('unsupported-type', 'AVIF image; export as PNG or JPEG');
    if (HEIC_BRANDS.has(major)) return ok('heic', []);
  }
  if (startsWith(head, [0x7b, 0x5c, 0x72, 0x74, 0x66]))
    return fail('unsupported-type', 'RTF; save as .docx or plain text');
  return lenientPdf(head) ? ok('pdf', []) : null;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/**
 * 03 §5.2 first row: `%PDF-` within the first 1024 bytes. Checked after every offset-0 signature,
 * and at a non-zero offset only when the preamble is blank or binary junk (as PDF readers tolerate):
 * a text file that merely mentions `%PDF-` near its top stays text.
 */
function lenientPdf(head: Buffer): boolean {
  const at = head.subarray(0, 1024).indexOf('%PDF-', 0, 'latin1');
  if (at <= 0) return at === 0;
  const preamble = head.subarray(0, at);
  return /^\s*$/.test(preamble.toString('latin1')) || !textProbe(preamble).ok;
}

interface TextProbe {
  ok: boolean;
  /** Decoded head (BOM stripped). */
  text: string;
  invalidUtf8: boolean;
}

/** 03 §5.2 text probe: BOM handling, NUL check, at most 2% invalid UTF-8 sequences. */
export function textProbe(head: Buffer): TextProbe {
  if (startsWith(head, [0xff, 0xfe]))
    return { ok: true, text: head.subarray(2).toString('utf16le'), invalidUtf8: false };
  if (startsWith(head, [0xfe, 0xff])) {
    const body = Buffer.from(head.subarray(2, 2 + ((head.length - 2) & ~1)));
    return { ok: true, text: body.swap16().toString('utf16le'), invalidUtf8: false };
  }
  const body = startsWith(head, [0xef, 0xbb, 0xbf]) ? head.subarray(3) : head;
  if (body.includes(0)) return { ok: false, text: '', invalidUtf8: false };
  const invalid = countInvalidUtf8(body);
  const ok = body.length === 0 || invalid / body.length <= 0.02;
  return { ok, text: ok ? body.toString('utf8') : '', invalidUtf8: invalid > 0 };
}

/** Invalid UTF-8 sequences in buf; a sequence cut off by the end of the buffer is not counted. */
export function countInvalidUtf8(buf: Buffer): number {
  let bad = 0;
  let i = 0;
  while (i < buf.length) {
    const b = buf[i]!;
    let need = 0;
    let min = 0;
    if (b < 0x80) {
      i++;
      continue;
    } else if (b >= 0xc2 && b <= 0xdf) {
      need = 1;
      min = 0x80;
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      min = 0x800;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      min = 0x10000;
    } else {
      bad++;
      i++;
      continue;
    }
    if (i + need >= buf.length) break; // sequence truncated by the end of the head
    let cp = b & (0x3f >> need);
    let valid = true;
    for (let k = 1; k <= need; k++) {
      const c = buf[i + k]!;
      if ((c & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
      cp = (cp << 6) | (c & 0x3f);
    }
    if (!valid || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      bad++;
      i++;
      continue;
    }
    i += need + 1;
  }
  return bad;
}

function textFormat(ext: string, declared: string | undefined, probe: TextProbe): SniffResult {
  const notes: string[] = [];
  let format: TextFormat;
  const byExt = TEXT_EXT[ext];
  if (byExt) format = byExt;
  else if (ext === '' || PLAIN_EXT.has(ext) || BINARY_EXT[ext]) {
    const decl = declared?.split(';')[0]?.trim().toLowerCase();
    format = (ext === '' && decl && DECLARED_TEXT[decl]) || 'text';
  } else {
    const decl = declared?.split(';')[0]?.trim().toLowerCase();
    const byDecl = decl ? DECLARED_TEXT[decl] : undefined;
    format = byDecl ?? 'text';
    if (!byDecl) notes.push(`extension .${ext} treated as plain text`);
  }
  if (format === 'text' && /^\s*<(!doctype\s+html|html[\s>])/i.test(probe.text)) format = 'html';
  const binaryExt = BINARY_EXT[ext];
  if (binaryExt) notes.push(`extension .${ext} but content is text`);
  if (probe.invalidUtf8) notes.push('contains invalid UTF-8; decoded with replacement characters');
  return ok(format, notes);
}

/**
 * Classify a file head (03 §5.2). Never throws; container readers are optional and consulted only
 * for ZIP (OOXML) and OLE heads.
 */
export async function sniff(head: Buffer, fileName: string, opts: SniffOptions = {}): Promise<SniffResult> {
  const ext = extOf(fileName);
  const byMagic = await magic(head, ext, opts);
  if (byMagic) {
    if (byMagic.ok) {
      const expected = BINARY_EXT[ext] ?? (TEXT_EXT[ext] || PLAIN_EXT.has(ext) ? 'text' : undefined);
      if (
        expected &&
        expected !== byMagic.format &&
        !(TEXT_FORMATS.has(expected) && TEXT_FORMATS.has(byMagic.format))
      ) {
        byMagic.notes.push(`extension .${ext} but content is ${LABEL[byMagic.format]}`);
      }
    }
    return byMagic;
  }
  const probe = textProbe(head);
  if (probe.ok) return textFormat(ext, opts.declaredMediaType, probe);
  return fail('unsupported-type', 'Unrecognized binary file');
}

export function isImageFormat(f: SourceFormat): boolean {
  return f === 'png' || f === 'jpeg' || f === 'gif' || f === 'webp' || f === 'heic' || f === 'tiff' || f === 'bmp';
}
