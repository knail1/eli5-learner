import { describe, expect, it } from 'vitest';
import type { NativeImageLike } from '../../../../src/main/document';
import { PHOTO_LIMITS, createNativePhotoOps } from '../../../../src/main/photos';

function fakeNative(w0: number, h0: number, jpegBytes: (q: number) => number = () => 1000) {
  const resizes: { width?: number; height?: number }[] = [];
  const qualities: number[] = [];
  const fake = (w: number, h: number, empty = false): NativeImageLike => ({
    isEmpty: () => empty,
    getSize: () => ({ width: w, height: h }),
    resize: (o) => {
      resizes.push({ ...(o.width ? { width: o.width } : {}), ...(o.height ? { height: o.height } : {}) });
      const nw = o.width ?? Math.round((w * (o.height ?? h)) / h);
      const nh = o.height ?? Math.round((h * (o.width ?? w)) / w);
      return fake(nw, nh);
    },
    toPNG: () => new Uint8Array(4),
    toJPEG: (q) => {
      qualities.push(q);
      return new Uint8Array(jpegBytes(q));
    },
  });
  return {
    resizes,
    qualities,
    mod: { createFromBuffer: (b: Buffer) => (b.length === 0 ? fake(0, 0, true) : fake(w0, h0)) },
  };
}

describe('createNativePhotoOps (07 §7.4 sizes)', () => {
  it('makes small JPEG thumbnails for the pick call', () => {
    const n = fakeNative(2000, 1000);
    const t = createNativePhotoOps(n.mod).thumb(new Uint8Array([1]));
    expect(t?.mime).toBe('image/jpeg');
    expect(n.resizes).toEqual([{ width: PHOTO_LIMITS.THUMB_EDGE }]);
  });

  it('downscales embedded photos to 1200 px on the long edge at q80', () => {
    const n = fakeNative(4000, 3000);
    const f = createNativePhotoOps(n.mod).full(new Uint8Array([1]));
    expect(n.resizes).toEqual([{ width: 1200 }]);
    expect(n.qualities).toEqual([80]);
    expect(f).toMatchObject({ mime: 'image/jpeg', width: 1200, height: 900 });
    const tall = fakeNative(1000, 3000);
    expect(createNativePhotoOps(tall.mod).full(new Uint8Array([1]))).toMatchObject({ width: 400, height: 1200 });
  });

  it('keeps small photos at their size and lowers quality until under the per-photo cap', () => {
    const n = fakeNative(800, 600, (q) => (q > 60 ? PHOTO_LIMITS.MAX_PHOTO_BYTES + 1 : 1000));
    const f = createNativePhotoOps(n.mod).full(new Uint8Array([1]));
    expect(n.resizes).toEqual([]);
    expect(n.qualities).toEqual([80, 70, 60]);
    expect(f).toMatchObject({ width: 800, height: 600 });
    const never = fakeNative(800, 600, () => PHOTO_LIMITS.MAX_PHOTO_BYTES + 1);
    expect(createNativePhotoOps(never.mod).full(new Uint8Array([1]))).toBeNull();
  });

  it('returns null for undecodable bytes', () => {
    const n = fakeNative(10, 10);
    const ops = createNativePhotoOps(n.mod);
    expect(ops.thumb(new Uint8Array())).toBeNull();
    expect(ops.full(new Uint8Array())).toBeNull();
  });
});
