import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_EDGE,
  createNativeImageNormalizer,
  passThroughNormalizer,
  sniffImage,
  type NativeImageLike,
} from '../../../../src/main/document';
import { makePng } from '../../../fixtures/documents/drafts';

function jpegHeader(w: number, h: number): Uint8Array {
  // SOI, APP0 (len 16), SOF0 (len 17) with height/width
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0)];
  const sof0 = [
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    h >> 8,
    h & 0xff,
    w >> 8,
    w & 0xff,
    0x03,
    ...new Array<number>(9).fill(0),
  ];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

function webpVp8x(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set(new TextEncoder().encode('RIFF'), 0);
  b.set(new TextEncoder().encode('WEBPVP8X'), 8);
  const wm = w - 1;
  const hm = h - 1;
  b.set([wm & 0xff, (wm >> 8) & 0xff, (wm >> 16) & 0xff, hm & 0xff, (hm >> 8) & 0xff, (hm >> 16) & 0xff], 24);
  return b;
}

/** PNG header only (sniffImage does not check CRCs): IHDR with the given depth/color type, optional tRNS. */
function pngHeader(bitDepth: number, colorType: number, trns: boolean): Uint8Array {
  const chunk = (type: string, len: number): number[] => [
    0,
    0,
    0,
    len,
    ...new TextEncoder().encode(type),
    ...new Array<number>(len + 4).fill(0),
  ];
  const b = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', 13)];
  b[16 + 3] = 8; // width 8
  b[20 + 3] = 4; // height 4
  b[24] = bitDepth;
  b[25] = colorType;
  if (trns) b.push(...chunk('tRNS', 6));
  b.push(...chunk('IDAT', 2), ...chunk('IEND', 0));
  return new Uint8Array(b);
}

describe('sniffImage (07 §5.6)', () => {
  it('keeps PNG for alpha or <= 256 colors: gray, palette, tRNS (07 §5.6)', () => {
    expect(sniffImage(pngHeader(8, 0, false))?.pngKeep).toBe(true); // 8-bit gray
    expect(sniffImage(pngHeader(16, 0, false))?.pngKeep).toBe(false); // 16-bit gray, no alpha
    expect(sniffImage(pngHeader(8, 3, false))?.pngKeep).toBe(true); // palette
    expect(sniffImage(pngHeader(8, 2, true))?.pngKeep).toBe(true); // truecolor + tRNS
    expect(sniffImage(pngHeader(8, 2, false))?.pngKeep).toBe(false); // plain truecolor -> JPEG
    expect(sniffImage(pngHeader(8, 2, false))).toMatchObject({ width: 8, height: 4 });
  });

  it('reads PNG, JPEG and WebP sizes', () => {
    expect(sniffImage(makePng(30, 20))).toEqual({ mime: 'image/png', width: 30, height: 20, pngKeep: false });
    expect(sniffImage(makePng(3, 2, true))?.pngKeep).toBe(true);
    expect(sniffImage(jpegHeader(640, 480))).toEqual({ mime: 'image/jpeg', width: 640, height: 480 });
    expect(sniffImage(webpVp8x(1000, 700))).toEqual({ mime: 'image/webp', width: 1000, height: 700 });
    expect(sniffImage(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});

describe('image normalizers', () => {
  it('pass-through accepts images inside the limits only', () => {
    expect(passThroughNormalizer({ label: 'a', mime: 'image/png', bytes: makePng(10, 10) })).toMatchObject({
      width: 10,
      height: 10,
    });
    expect(passThroughNormalizer({ label: 'a', mime: 'image/png', bytes: makePng(MAX_IMAGE_EDGE + 1, 2) })).toBeNull();
    expect(
      passThroughNormalizer({ label: 'a', mime: 'image/gif', bytes: new Uint8Array([0x47, 0x49, 0x46]) }),
    ).toBeNull();
  });

  it('nativeImage: keeps PNG with alpha as PNG, otherwise JPEG', () => {
    const img = (w: number, h: number): NativeImageLike => ({
      isEmpty: () => false,
      getSize: () => ({ width: w, height: h }),
      resize: (o) => img(o.width ?? w, o.height ?? h),
      toPNG: () => makePng(2, 2, true),
      toJPEG: () => jpegHeader(2, 2),
    });
    const norm = createNativeImageNormalizer({ createFromBuffer: () => img(800, 2400) });
    expect(norm({ label: 'x', mime: 'image/png', bytes: makePng(4, 4, true) })).toMatchObject({
      mime: 'image/png',
      width: 800,
      height: 1600,
    });
    expect(norm({ label: 'x', mime: 'image/png', bytes: makePng(4, 4) })?.mime).toBe('image/jpeg');
    const empty = createNativeImageNormalizer({ createFromBuffer: () => ({ ...img(1, 1), isEmpty: () => true }) });
    expect(empty({ label: 'x', mime: 'image/png', bytes: makePng(1, 1) })).toBeNull();
  });
});
