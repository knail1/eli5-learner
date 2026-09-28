/**
 * Image services for the headless eval pipeline (04 §6.3, §7). The app renders PDF pages and
 * normalizes images in an Electron window, which a Node run does not have, and the contract fakes
 * return placeholder bytes. An eval run sends images to a real vision model, so these hand over real
 * pixels: eval images are already PNGs within the limits, and the synthetic PDFs (the fixture
 * generator's and buildScannedPdf's) carry each image-only page as one embedded grayscale image.
 */
import { inflateSync } from 'node:zlib';
import {
  DEFAULT_EXTRACT_LIMITS,
  type ImageAsset,
  type ImageNormalizer,
  type PdfPageRenderer,
} from '../../../src/main/extract';
import { encodePng } from '../../fixtures/build/common';

function imageSize(b: Buffer): { w: number; h: number; mediaType: 'image/png' | 'image/jpeg' } | undefined {
  if (b.length >= 24 && b[0] === 0x89 && b.toString('ascii', 12, 16) === 'IHDR')
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), mediaType: 'image/png' };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      const m = b[i + 1] ?? 0;
      if (m >= 0xc0 && m <= 0xc3)
        return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5), mediaType: 'image/jpeg' };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return undefined;
}

/** Passes a PNG or JPEG within the long-edge and aspect limits through unchanged. */
const normalizeImage: ImageNormalizer = async (bytes, _mediaType, o) => {
  const b = Buffer.from(bytes);
  const d = imageSize(b);
  if (!d || d.w === 0 || d.h === 0) return { ok: false, code: 'corrupt' };
  const lim = DEFAULT_EXTRACT_LIMITS.images;
  if (Math.max(d.w, d.h) > lim.targetLongEdgePx || Math.max(d.w, d.h) / Math.min(d.w, d.h) > lim.maxAspect) {
    return { ok: false, code: 'image-too-large' };
  }
  const asset: ImageAsset = {
    id: 'eval-0',
    mediaType: d.mediaType,
    data: new Uint8Array(b),
    width: d.w,
    height: d.h,
    byteLength: b.length,
    origin: o.origin,
  };
  return { ok: true, assets: [asset] };
};

interface PageImage {
  width: number;
  height: number;
  gray: Buffer;
}

/** The embedded full-page image of each page, in page order (undefined for a text-only page). */
function pageImages(pdf: Uint8Array): (PageImage | undefined)[] {
  const buf = Buffer.from(pdf);
  const text = buf.toString('latin1');
  const image = (n: string): PageImage | undefined => {
    const head = new RegExp(`(?:^|\\n)${n} 0 obj\\n<< ([^]*?) >>\\nstream\\n`).exec(text);
    if (!head) return undefined;
    const dict = head[1] ?? '';
    const num = (k: string): number => Number(new RegExp(`/${k} (\\d+)`).exec(dict)?.[1] ?? NaN);
    if (!/\/Subtype \/Image/.test(dict) || !/\/DeviceGray/.test(dict) || !/\/FlateDecode/.test(dict)) return undefined;
    const start = head.index + head[0].length;
    const gray = inflateSync(buf.subarray(start, start + num('Length')));
    const width = num('Width');
    const height = num('Height');
    return gray.length === width * height ? { width, height, gray } : undefined;
  };
  return [...text.matchAll(/<< \/Type \/Page \/Parent [^]*?\/Contents \d+ 0 R >>/g)].map((m) => {
    const ref = /\/XObject << \/Im1 (\d+) 0 R >>/.exec(m[0])?.[1];
    return ref ? image(ref) : undefined;
  });
}

const renderPdfPages: PdfPageRenderer = async (pdf, pages) => {
  const images = pageImages(pdf);
  return pages.map((page) => {
    const img = images[page - 1];
    if (!img) return { page, error: 'no page image in this synthetic PDF' };
    const v = (x: number, y: number): number => img.gray[y * img.width + x] ?? 255;
    const png = encodePng(img.width, img.height, (x, y) => [v(x, y), v(x, y), v(x, y)]);
    return { page, png, width: img.width, height: img.height };
  });
};

export function evalImageServices(): { renderPdfPages: PdfPageRenderer; normalizeImage: ImageNormalizer } {
  return { renderPdfPages, normalizeImage };
}
