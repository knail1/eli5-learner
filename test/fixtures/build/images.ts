/**
 * Image fixtures (13 §5.1): diagram.png (few flat colors), screenshot-tall.png (1000×9000, taller
 * than 8:1 so it tiles), and photo.jpg (a baseline JPEG with EXIF orientation 6). JPEG has no
 * encoder dependency, so a minimal grayscale baseline encoder lives here: each 8×8 block is flat,
 * so only DC coefficients are coded and the AC table holds just end-of-block.
 */
import { encodePng, pngHeaderOnly } from './common';
import { diagramPng } from './pptx';

export { diagramPng };

export function screenshotTallPng(): Uint8Array {
  return encodePng(1000, 9000, (x, y) => {
    const row = Math.floor(y / 24);
    const inText = y % 24 < 12 && x >= 40 && x < 40 + ((row * 97) % 700) + 150;
    if (y % 600 < 40) return [230, 236, 245]; // message header band
    return inText ? [50, 50, 60] : [255, 255, 255];
  });
}

/** 8000×8000 header (64 MP) with no real pixel data: refused from the header alone. */
export function hugeHeaderPng(): Uint8Array {
  return pngHeaderOnly(8000, 8000);
}

// ---- minimal baseline JPEG (grayscale, DC-only) ----

class BitWriter {
  private bytes: number[] = [];
  private acc = 0;
  private n = 0;
  put(code: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      this.n++;
      if (this.n === 8) {
        this.bytes.push(this.acc);
        if (this.acc === 0xff) this.bytes.push(0);
        this.acc = 0;
        this.n = 0;
      }
    }
  }
  flush(): number[] {
    if (this.n > 0) this.put((1 << (8 - this.n)) - 1, 8 - this.n);
    return this.bytes;
  }
}

const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

function huffCodes(bits: number[], vals: number[]): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]!; i++) out.set(vals[k++]!, [code++, len]);
    code <<= 1;
  }
  return out;
}

function segment(marker: number, payload: number[]): number[] {
  const len = payload.length + 2;
  return [0xff, marker, len >> 8, len & 255, ...payload];
}

function exifOrientation(o: number): number[] {
  // "Exif\0\0" + big-endian TIFF header + IFD0 with one entry: Orientation (0x0112), SHORT, 1.
  return [0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0];
}

export function encodeGrayJpeg(width: number, height: number, lum: (x: number, y: number) => number, orientation?: number): Uint8Array {
  const q = 16; // DC quantizer
  const dc = huffCodes(DC_BITS, DC_VALS);
  const w = new BitWriter();
  let prev = 0;
  for (let by = 0; by < Math.ceil(height / 8); by++) {
    for (let bx = 0; bx < Math.ceil(width / 8); bx++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) sum += lum(Math.min(width - 1, bx * 8 + x), Math.min(height - 1, by * 8 + y)) - 128;
      const coef = Math.round(sum / 8 / q); // DC of the orthonormal 8×8 DCT is sum/8
      const diff = coef - prev;
      prev = coef;
      const mag = Math.abs(diff);
      const cat = mag === 0 ? 0 : Math.floor(Math.log2(mag)) + 1;
      const [c, l] = dc.get(cat)!;
      w.put(c, l);
      if (cat) w.put(diff >= 0 ? diff : diff + (1 << cat) - 1, cat);
      w.put(0, 1); // AC: end of block (the only AC symbol, code "0")
    }
  }
  const dqt = [0, ...Array.from({ length: 64 }, (_, i) => (i === 0 ? q : 99))];
  const sof = [8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0];
  const dhtDc = [0x00, ...DC_BITS, ...DC_VALS];
  const dhtAc = [0x10, 1, ...Array<number>(15).fill(0), 0x00];
  const sos = [1, 1, 0x00, 0, 63, 0];
  return new Uint8Array([
    0xff,
    0xd8,
    ...(orientation ? segment(0xe1, exifOrientation(orientation)) : []),
    ...segment(0xdb, dqt),
    ...segment(0xc0, sof),
    ...segment(0xc4, dhtDc),
    ...segment(0xc4, dhtAc),
    ...segment(0xda, sos),
    ...w.flush(),
    0xff,
    0xd9,
  ]);
}

/** 640×480 "photo" stored sideways with EXIF orientation 6 (rotate 90° clockwise to view). */
export function photoJpg(): Uint8Array {
  return encodeGrayJpeg(640, 480, (x, y) => 60 + Math.round(((x + y) / (640 + 480)) * 150) + (Math.floor(x / 80) % 2) * 20, 6);
}
