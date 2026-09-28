/* global Blob, createImageBitmap, OffscreenCanvas */
// Image normalization for vision (04 §7.1 steps 2-7, §7.2 tiling), run in the pdf-render window.
// Decoding uses Chromium (createImageBitmap with EXIF orientation applied); nothing touches main.
// Tiling mirrors planTiles() in src/main/extract/images.ts.

function planTiles(width, height, maxAspect, maxTiles) {
  if (width <= 0 || height / width <= maxAspect) return null;
  const tileH = Math.round(1.4 * width);
  const step = Math.max(1, Math.round(tileH * 0.95));
  const tiles = [];
  for (let y = 0; y < height; y += step) {
    tiles.push({ y, height: Math.min(tileH, height - y) });
    if (y + tileH >= height) break;
  }
  return tiles.slice(0, maxTiles);
}

function countColors(ctx, w, h) {
  // Sample up to 65,536 pixels; stop at 4,097 distinct colors (04 §7.1 step 5).
  const data = ctx.getImageData(0, 0, w, h).data;
  const total = w * h;
  const stride = Math.max(1, Math.floor(total / 65536));
  const seen = new Set();
  let alpha = false;
  for (let p = 0; p < total && seen.size < 4097; p += stride) {
    const i = p * 4;
    if (data[i + 3] < 255) alpha = true;
    seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
  }
  return { colors: seen.size, alpha };
}

async function encodeOne(source, sx, sy, sw, sh, opts) {
  let scale = Math.min(1, opts.targetLongEdgePx / Math.max(sw, sh));
  let kind = null;
  let colors = 0;
  const qualities = [0.85, 0.75, 0.6];
  for (let attempt = 0; attempt < 4; attempt++) {
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const bmp = await createImageBitmap(source, sx, sy, sw, sh, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: 'high',
    });
    try {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (kind === null) {
        ctx.drawImage(bmp, 0, 0);
        const c = countColors(ctx, w, h);
        colors = c.colors;
        kind = c.alpha || c.colors <= 4096 ? 'image/png' : 'image/jpeg';
      }
      const type = attempt === 0 ? kind : 'image/jpeg';
      ctx.clearRect(0, 0, w, h);
      if (type === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
      }
      ctx.drawImage(bmp, 0, 0);
      const quality = type === 'image/jpeg' ? qualities[Math.min(attempt, qualities.length - 1)] : undefined;
      const blob = await canvas.convertToBlob(quality === undefined ? { type } : { type, quality });
      if (blob.size <= opts.maxOutputBytes) {
        return {
          mediaType: type,
          data: new Uint8Array(await blob.arrayBuffer()),
          width: w,
          height: h,
          distinctColors: colors,
        };
      }
      if (attempt >= 2) scale *= 0.8;
    } finally {
      bmp.close();
    }
  }
  return null;
}

export async function normalizeImage(bytes, mediaType, opts) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: mediaType }), { imageOrientation: 'from-image' });
  } catch {
    return { ok: false, code: 'corrupt' };
  }
  try {
    const W = bitmap.width;
    const H = bitmap.height;
    const tiles = planTiles(W, H, opts.maxAspect, opts.maxTiles) || [{ y: 0, height: H }];
    const assets = [];
    for (const t of tiles) {
      const a = await encodeOne(bitmap, 0, t.y, W, t.height, opts);
      if (!a) return { ok: false, code: 'image-too-large' };
      assets.push(a);
    }
    return { ok: true, assets };
  } finally {
    bitmap.close();
  }
}
