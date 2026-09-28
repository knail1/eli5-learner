/**
 * Header-only image inspection (04 §7.1 step 1). image-size is not a dependency (01 §7), so this
 * small reader covers the formats 03 sniffs: PNG, JPEG, GIF, WebP, BMP, TIFF, HEIC, plus EMF/WMF
 * detection for the embedded-image rule in §7.3. No pixel data is decoded.
 */

export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'tiff' | 'heic' | 'emf' | 'wmf';

export interface ImageHeader {
  kind: ImageKind;
  width: number;
  height: number;
  /** EXIF orientation (1-8) for JPEG, when present. Applied by the normalizer, not here. */
  orientation?: number;
}

function ascii(b: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = off; i < off + len && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

export function sniffImage(b: Uint8Array): ImageKind | undefined {
  if (b.length < 12) return undefined;
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(b, 0, 4) === 'GIF8') return 'gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (ascii(b, 0, 2) === 'BM') return 'bmp';
  if (ascii(b, 0, 4) === 'II*\0' || ascii(b, 0, 4) === 'MM\0*') return 'tiff';
  if (ascii(b, 4, 4) === 'ftyp' && /^(heic|heix|mif1|msf1|heim|heis|hevc)$/.test(ascii(b, 8, 4))) return 'heic';
  if (b[0] === 0x01 && b[1] === 0 && b[2] === 0 && b[3] === 0 && ascii(b, 40, 4) === ' EMF') return 'emf';
  if (b[0] === 0xd7 && b[1] === 0xcd && b[2] === 0xc6 && b[3] === 0x9a) return 'wmf';
  if ((b[0] === 0x01 || b[0] === 0x02) && b[1] === 0 && b[2] === 0x09 && b[3] === 0) return 'wmf';
  return undefined;
}

function dv(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function jpegHeader(b: Uint8Array): ImageHeader | undefined {
  const v = dv(b);
  let orientation: number | undefined;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined; // EOI or scan before any SOF
    const len = v.getUint16(i + 2);
    if (len < 2) return undefined;
    if (marker === 0xe1 && ascii(b, i + 4, 6) === 'Exif\0\0') {
      orientation = exifOrientation(b.subarray(i + 10, i + 2 + len)) ?? orientation;
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > b.length) return undefined;
      const height = v.getUint16(i + 5);
      const width = v.getUint16(i + 7);
      return { kind: 'jpeg', width, height, ...(orientation !== undefined ? { orientation } : {}) };
    }
    i += 2 + len;
  }
  return undefined;
}

/** Reads IFD0 of a TIFF structure; returns tag -> first value for the requested tags. */
function tiffTags(t: Uint8Array, wanted: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (t.length < 8) return out;
  const le = ascii(t, 0, 2) === 'II';
  const v = dv(t);
  const ifd = v.getUint32(4, le);
  if (ifd + 2 > t.length) return out;
  const n = v.getUint16(ifd, le);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > t.length) break;
    const tag = v.getUint16(e, le);
    if (!wanted.includes(tag)) continue;
    const type = v.getUint16(e + 2, le);
    out.set(tag, type === 3 ? v.getUint16(e + 8, le) : v.getUint32(e + 8, le));
  }
  return out;
}

function exifOrientation(tiff: Uint8Array): number | undefined {
  const o = tiffTags(tiff, [0x0112]).get(0x0112);
  return o !== undefined && o >= 1 && o <= 8 ? o : undefined;
}

function heicHeader(b: Uint8Array): ImageHeader | undefined {
  // The largest 'ispe' (image spatial extent) property is the primary image.
  const v = dv(b);
  let best: ImageHeader | undefined;
  const end = Math.min(b.length - 20, 1 << 20);
  for (let i = 4; i < end; i++) {
    if (b[i] === 0x69 && ascii(b, i, 4) === 'ispe') {
      const width = v.getUint32(i + 8);
      const height = v.getUint32(i + 12);
      if (!best || width * height > best.width * best.height) best = { kind: 'heic', width, height };
    }
  }
  return best;
}

/** Dimensions from the header, or undefined when unreadable (04 §7.1: unreadable header is corrupt). */
export function readImageHeader(b: Uint8Array): ImageHeader | undefined {
  const kind = sniffImage(b);
  if (!kind) return undefined;
  const v = dv(b);
  try {
    switch (kind) {
      case 'png':
        if (ascii(b, 12, 4) !== 'IHDR') return undefined;
        return { kind, width: v.getUint32(16), height: v.getUint32(20) };
      case 'gif':
        return { kind, width: v.getUint16(6, true), height: v.getUint16(8, true) };
      case 'bmp': {
        const dib = v.getUint32(14, true);
        if (dib === 12) return { kind, width: v.getUint16(18, true), height: v.getUint16(20, true) };
        return { kind, width: Math.abs(v.getInt32(18, true)), height: Math.abs(v.getInt32(22, true)) };
      }
      case 'webp': {
        const chunk = ascii(b, 12, 4);
        if (chunk === 'VP8 ') {
          return { kind, width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
        }
        if (chunk === 'VP8L') {
          const b0 = b[21]!;
          const b1 = b[22]!;
          const b2 = b[23]!;
          const b3 = b[24]!;
          return {
            kind,
            width: 1 + (((b1 & 0x3f) << 8) | b0),
            height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
          };
        }
        if (chunk === 'VP8X') {
          const w = b[24]! | (b[25]! << 8) | (b[26]! << 16);
          const h = b[27]! | (b[28]! << 8) | (b[29]! << 16);
          return { kind, width: w + 1, height: h + 1 };
        }
        return undefined;
      }
      case 'jpeg':
        return jpegHeader(b);
      case 'tiff': {
        const tags = tiffTags(b, [256, 257]);
        const width = tags.get(256);
        const height = tags.get(257);
        return width && height ? { kind, width, height } : undefined;
      }
      case 'heic':
        return heicHeader(b);
      case 'emf':
      case 'wmf':
        return { kind, width: 0, height: 0 };
    }
  } catch {
    return undefined;
  }
}

/** Media type sent to the normalizer (render window decodes these directly, 04 §4). */
export const MEDIA_TYPE: Record<Exclude<ImageKind, 'emf' | 'wmf'>, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  heic: 'image/heic',
};
