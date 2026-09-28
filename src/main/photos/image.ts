// Photo sizing (07 §7.4) with Electron's nativeImage (injected, so tests pass a fake): small JPEG
// thumbnails for the pick call, and embedded photos at most 1200 px on the long edge, JPEG q80,
// lowering quality until the photo fits its byte cap.
import type { NativeImageLike, NativeImageModule } from '../document';
import { PHOTO_LIMITS } from './limits';

export interface PhotoImageOps {
  thumb(bytes: Uint8Array): { mime: 'image/jpeg'; bytes: Uint8Array } | null;
  full(bytes: Uint8Array): { mime: 'image/jpeg'; bytes: Uint8Array; width: number; height: number } | null;
}

function fit(img: NativeImageLike, edge: number): NativeImageLike {
  const { width, height } = img.getSize();
  if (Math.max(width, height) <= edge) return img;
  return width >= height ? img.resize({ width: edge, quality: 'best' }) : img.resize({ height: edge, quality: 'best' });
}

export function createNativePhotoOps(nativeImage: NativeImageModule): PhotoImageOps {
  const decode = (bytes: Uint8Array): NativeImageLike | null => {
    if (bytes.length === 0) return null;
    const img = nativeImage.createFromBuffer(Buffer.from(bytes));
    return img.isEmpty() ? null : img;
  };
  return {
    thumb(bytes) {
      const img = decode(bytes);
      if (!img) return null;
      const jpg = fit(img, PHOTO_LIMITS.THUMB_EDGE).toJPEG(PHOTO_LIMITS.THUMB_QUALITY);
      return jpg.length > 0 ? { mime: 'image/jpeg', bytes: jpg } : null;
    },
    full(bytes) {
      const img = decode(bytes);
      if (!img) return null;
      const out = fit(img, PHOTO_LIMITS.OUTPUT_EDGE);
      const { width, height } = out.getSize();
      for (const q of [PHOTO_LIMITS.OUTPUT_QUALITY, 70, 60]) {
        const jpg = out.toJPEG(q);
        if (jpg.length > 0 && jpg.length <= PHOTO_LIMITS.MAX_PHOTO_BYTES) {
          return { mime: 'image/jpeg', bytes: jpg, width, height };
        }
      }
      return null;
    },
  };
}
