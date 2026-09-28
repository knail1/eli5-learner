import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

/**
 * Menu bar icons (11 §4.1): "eli5" in a thin font inside a thin oval, as macOS template images
 * (black ink, meaning carried by alpha only, so macOS tints them for light and dark menu bars).
 */
const DIR = resolve(import.meta.dirname, '../../../resources/tray');

interface Img {
  w: number;
  h: number;
  /** RGBA, 4 bytes per pixel. */
  px: Uint8Array;
}

/** Minimal PNG decoder: 8-bit RGBA, non-interlaced, all five scanline filters. */
function decode(file: string): Img {
  const b = readFileSync(resolve(DIR, file));
  let o = 8;
  let w = 0;
  let h = 0;
  const idat: Buffer[] = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    const type = b.toString('ascii', o + 4, o + 8);
    const d = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = d.readUInt32BE(0);
      h = d.readUInt32BE(4);
      expect([d[8], d[9], d[12]]).toEqual([8, 6, 0]); // 8-bit RGBA, not interlaced
    }
    if (type === 'IDAT') idat.push(d);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= 4 ? px[y * stride + x - 4]! : 0;
      const up = y > 0 ? px[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4]! : 0;
      const p = a + up - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      const pred = [0, a, up, (a + up) >> 1, paeth][f]!;
      px[y * stride + x] = (v + pred) & 0xff;
    }
  }
  return { w, h, px };
}

const alpha = (img: Img, x: number, y: number): number => img.px[(y * img.w + x) * 4 + 3]!;
/** Most ink (alpha) in a column band, over all rows. */
const columnInk = (img: Img, x0: number, x1: number): number => {
  let m = 0;
  for (let y = 0; y < img.h; y++) for (let x = x0; x <= x1; x++) m = Math.max(m, alpha(img, x, y));
  return m;
};

describe('menu bar icons', () => {
  const cases = [
    ['trayTemplate.png', 32, 18],
    ['trayTemplate@2x.png', 64, 36],
    ['trayBusyTemplate.png', 32, 18],
    ['trayBusyTemplate@2x.png', 64, 36],
  ] as const;

  it.each(cases)('%s is %i×%i points and a valid template image (black ink, alpha only)', (file, w, h) => {
    const img = decode(file);
    expect([img.w, img.h]).toEqual([w, h]);
    let ink = 0;
    for (let i = 0; i < img.px.length; i += 4) {
      if (img.px[i + 3]! > 0) {
        ink++;
        expect([img.px[i], img.px[i + 1], img.px[i + 2]]).toEqual([0, 0, 0]);
      }
    }
    expect(ink).toBeGreaterThan(0);
  });

  it('draws an oval around the text: ink at both ends, text in the middle, a thin ring', () => {
    const img = decode('trayTemplate@2x.png');
    // The oval's left and right extremes carry ink near the vertical middle.
    expect(columnInk(img, 0, 3)).toBeGreaterThan(100);
    expect(columnInk(img, img.w - 4, img.w - 1)).toBeGreaterThan(100);
    // Text sits inside: the central columns hold ink between the ring's top and bottom.
    let inner = 0;
    for (let y = 8; y < img.h - 8; y++) for (let x = 20; x < img.w - 20; x++) inner = Math.max(inner, alpha(img, x, y));
    expect(inner).toBeGreaterThan(100);
    // Thin ring: at the middle column, a vertical scan meets the top ring within the first 5 px and
    // there is clear space between the ring and the text.
    const mid = Math.floor(img.w / 2);
    const col = Array.from({ length: img.h }, (_, y) => alpha(img, mid, y));
    const first = col.findIndex((a) => a > 100);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(5);
    expect(col.slice(first + 1, first + 8).some((a) => a < 40)).toBe(true);
  });

  it('the busy variant differs from the idle icon', () => {
    const idle = decode('trayTemplate@2x.png');
    const busy = decode('trayBusyTemplate@2x.png');
    let diff = 0;
    for (let i = 3; i < idle.px.length; i += 4) diff += Math.abs(idle.px[i]! - busy.px[i]!);
    expect(diff).toBeGreaterThan(255 * 10);
  });
});
