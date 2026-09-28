// Figure images (07 §5.6): normalization seam, header sniffing, and the Electron nativeImage
// normalizer. image-size is not a dependency, so PNG/JPEG/WebP headers are read here.
import { createHash } from 'node:crypto';
import type { AssetRef } from './types';

export type AssetMime = AssetRef['mime'];

export const MAX_IMAGE_EDGE = 1600;
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;

export interface ImageInfo {
  mime: AssetMime;
  width: number;
  height: number;
  /** PNG only: has alpha (channel or tRNS) or <= 256 colors (palette, <= 8-bit gray); 07 §5.6 keeps these as PNG. */
  pngKeep?: boolean;
}

export interface NormalizedImage {
  mime: AssetMime;
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** Turns an input image into an embeddable asset, or null when it cannot be used (07 §5.6). */
export type ImageNormalizer = (img: { label: string; mime: string; bytes: Uint8Array }) => NormalizedImage | null;

const u32 = (b: Uint8Array, o: number): number =>
  (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0;
const u16be = (b: Uint8Array, o: number): number => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const u16le = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
const ascii = (b: Uint8Array, o: number, n: number): string => String.fromCharCode(...b.subarray(o, o + n));

/** True when a tRNS chunk (transparency) appears before the first IDAT. */
function pngHasTrns(b: Uint8Array): boolean {
  let o = 8;
  while (o + 8 <= b.length) {
    const len = u32(b, o);
    const type = ascii(b, o + 4, 4);
    if (type === 'tRNS') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    o += 12 + len;
  }
  return false;
}

/** 07 §5.6 "PNG with alpha or <= 256 colors". Counting truecolor pixels would need a decoder, so
 * truecolor without transparency goes to JPEG. */
function pngKeep(b: Uint8Array): boolean {
  const bitDepth = b[24] ?? 0;
  const colorType = b[25] ?? 0;
  if (colorType === 3 || colorType === 4 || colorType === 6) return true;
  if (colorType === 0 && bitDepth <= 8) return true;
  return (colorType === 0 || colorType === 2) && pngHasTrns(b);
}

/** Reads type and pixel size from PNG, JPEG or WebP bytes. */
export function sniffImage(b: Uint8Array): ImageInfo | undefined {
  if (b.length >= 26 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && ascii(b, 12, 4) === 'IHDR') {
    return { mime: 'image/png', width: u32(b, 16), height: u32(b, 20), pngKeep: pngKeep(b) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) return undefined;
      const marker = b[o + 1] ?? 0;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        o += 2;
        continue;
      }
      const len = u16be(b, o + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', height: u16be(b, o + 5), width: u16be(b, o + 7) };
      }
      o += 2 + len;
    }
    return undefined;
  }
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8X') return { mime: 'image/webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    if (chunk === 'VP8 ') return { mime: 'image/webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = u32(new Uint8Array([b[24] ?? 0, b[23] ?? 0, b[22] ?? 0, b[21] ?? 0]), 0);
      return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return undefined;
}

/**
 * Default normalizer (no Electron): passes through PNG/JPEG/WebP that already meet the 07 §5.4
 * limits (long edge <= 1600 px, <= 1.5 MB); anything else is refused so the figure is dropped.
 */
export const passThroughNormalizer: ImageNormalizer = ({ bytes }) => {
  const info = sniffImage(bytes);
  if (!info || info.width <= 0 || info.height <= 0) return null;
  if (Math.max(info.width, info.height) > MAX_IMAGE_EDGE || bytes.length > MAX_IMAGE_BYTES) return null;
  return { mime: info.mime, bytes, width: info.width, height: info.height };
};

/** The subset of Electron's `nativeImage` used here, so tests can pass a fake. */
export interface NativeImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(opts: { width?: number; height?: number; quality?: 'good' | 'better' | 'best' }): NativeImageLike;
  toPNG(): Uint8Array;
  toJPEG(quality: number): Uint8Array;
}
export interface NativeImageModule {
  createFromBuffer(buf: Buffer): NativeImageLike;
}

/**
 * 07 §5.6 with Electron's nativeImage (injected by the caller in main): resize to <= 1600 px on the
 * long edge; PNG when the source is PNG with alpha or <= 256 colors, otherwise JPEG q=82 (then lower
 * quality until <= 1.5 MB).
 */
export function createNativeImageNormalizer(nativeImage: NativeImageModule): ImageNormalizer {
  return ({ bytes }) => {
    const info = sniffImage(bytes);
    let img = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (img.isEmpty()) return null;
    let { width, height } = img.getSize();
    if (Math.max(width, height) > MAX_IMAGE_EDGE) {
      img =
        width >= height
          ? img.resize({ width: MAX_IMAGE_EDGE, quality: 'best' })
          : img.resize({ height: MAX_IMAGE_EDGE, quality: 'best' });
      ({ width, height } = img.getSize());
    }
    if (info?.mime === 'image/png' && info.pngKeep) {
      const png = img.toPNG();
      if (png.length <= MAX_IMAGE_BYTES) return { mime: 'image/png', bytes: png, width, height };
    }
    for (const q of [82, 70, 55]) {
      const jpg = img.toJPEG(q);
      if (jpg.length <= MAX_IMAGE_BYTES) return { mime: 'image/jpeg', bytes: jpg, width, height };
    }
    return null;
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Asset IDs are content-derived so the same image is stored once (07 §5.1 step 5). */
export function assetIdFor(sha256: string): string {
  return `img-${sha256.slice(0, 12)}`;
}

export function toDataUri(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

export function fromDataUri(uri: string): { mime: string; bytes: Uint8Array } | undefined {
  const m = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=]*)$/.exec(uri);
  if (!m) return undefined;
  return { mime: m[1] ?? '', bytes: new Uint8Array(Buffer.from(m[2] ?? '', 'base64')) };
}
