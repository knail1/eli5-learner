import type { ExtractedContent, ImageAsset } from '../extract';
import type { SkippedSource } from '../sources';
import { imageTokens, MAX_IMAGE_EDGE } from './budget';
import type { ImageInput, ModelLimits } from './types';

/**
 * Image preparation for vision input (02 §8.3): stable labels, re-encoding of oversized images to
 * JPEG q85 at ≤1568 px (Electron nativeImage in the app), and skips with a reason instead of
 * silent drops.
 */

export interface ReencodeInput {
  data: Uint8Array;
  mediaType: string;
  width: number;
  height: number;
}
export interface ReencodeOutput {
  data: Uint8Array;
  mediaType: 'image/jpeg';
  width: number;
  height: number;
}
export type ImageReencoder = (
  img: ReencodeInput,
  opts: { maxLongEdge: number; quality: number },
) => Promise<ReencodeOutput | null>;

/** App encoder: Electron nativeImage, no extra native dependency (02 §8.3 step 2). */
export function createNativeImageReencoder(): ImageReencoder {
  return async (img, opts) => {
    const { nativeImage } = await import('electron');
    let ni = nativeImage.createFromBuffer(Buffer.from(img.data));
    if (ni.isEmpty()) return null;
    const { width, height } = ni.getSize();
    const s = Math.min(1, opts.maxLongEdge / Math.max(width, height));
    if (s < 1) ni = ni.resize({ width: Math.round(width * s), height: Math.round(height * s), quality: 'best' });
    const size = ni.getSize();
    return { data: ni.toJPEG(opts.quality), mediaType: 'image/jpeg', width: size.width, height: size.height };
  };
}

export const SKIP_IMAGE_TOO_LARGE = 'image too large for model';
export const SKIP_NO_VISION = 'selected model does not accept images';

export interface PreparedImage extends ImageInput {
  imageId: string;
  width: number;
  height: number;
  tokens: number;
}

export interface PreparedImages {
  byId: Map<string, PreparedImage>;
  ordered: PreparedImage[];
  skipped: SkippedSource[];
}

/** "<ref> p.4" / "<ref> slide 3" / "<ref> image 2", unique within the job. */
function labelFor(c: ExtractedContent, a: ImageAsset, n: number, taken: Set<string>): string {
  const where =
    a.pageOrSlide !== undefined
      ? c.format === 'pptx'
        ? `slide ${a.pageOrSlide}`
        : `p.${a.pageOrSlide}`
      : `image ${n}`;
  let label = c.images.length === 1 && a.origin === 'standalone' ? c.sourceRef : `${c.sourceRef} ${where}`;
  for (let i = 2; taken.has(label); i++) label = `${c.sourceRef} ${where} (${i})`;
  taken.add(label);
  return label;
}

export async function prepareImages(
  contents: readonly ExtractedContent[],
  limits: ModelLimits,
  reencode?: ImageReencoder,
): Promise<PreparedImages> {
  const byId = new Map<string, PreparedImage>();
  const ordered: PreparedImage[] = [];
  const skipped: SkippedSource[] = [];
  const taken = new Set<string>();
  for (const c of contents) {
    if (!limits.supportsImages) {
      if (c.images.length && c.stats.chars === 0) {
        skipped.push({ ref: c.sourceRef, reason: SKIP_NO_VISION, code: 'unsupported-type' });
      }
      continue;
    }
    for (const [i, a] of c.images.entries()) {
      const label = labelFor(c, a, i + 1, taken);
      let img: ReencodeInput & { mediaType: string } = a;
      const oversize = (x: ReencodeInput): boolean =>
        x.data.byteLength > limits.maxImageBytes || Math.max(x.width, x.height) > MAX_IMAGE_EDGE;
      if (oversize(img)) {
        const out = reencode
          ? await reencode(img, { maxLongEdge: MAX_IMAGE_EDGE, quality: 85 }).catch(() => null)
          : null;
        if (!out || oversize(out)) {
          skipped.push({ ref: label, reason: SKIP_IMAGE_TOO_LARGE, code: 'image-too-large' });
          continue;
        }
        img = out;
      }
      const p: PreparedImage = {
        imageId: a.id,
        mediaType: img.mediaType as ImageInput['mediaType'],
        data: Buffer.from(img.data),
        label,
        sourceRef: c.sourceRef,
        width: img.width,
        height: img.height,
        tokens: imageTokens(img.width, img.height),
      };
      byId.set(a.id, p);
      ordered.push(p);
    }
  }
  return { byId, ordered, skipped };
}

/** Plain ImageInput (drops planner fields) so checkpoints stay small. */
export function toImageInput(p: PreparedImage): ImageInput {
  return { mediaType: p.mediaType, data: p.data, label: p.label, sourceRef: p.sourceRef };
}
