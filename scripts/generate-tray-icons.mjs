// Generates the menu bar template images (11 §4.1): a document glyph, plus a busy variant with a
// dot. Template images use only the alpha channel; macOS tints them for light and dark menu bars.
// Run: node scripts/generate-tray-icons.mjs
import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'tray');

// Glyph in an 18×18 point design space.
const DOC = { x0: 4, y0: 2, x1: 14, y1: 16, r: 2, stroke: 1.5 };
const LINES = [6.5, 9.5, 12.5].map((y) => ({ x0: 6.5, x1: 11.5, y, h: 1.25 }));
const DOT = { cx: 14.5, cy: 14.5, r: 3, gap: 1.25 };

function inRoundRect(x, y, { x0, y0, x1, y1, r }) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function covered(x, y, busy) {
  const s = DOC.stroke;
  const outer = inRoundRect(x, y, DOC);
  const inner = inRoundRect(x, y, { x0: DOC.x0 + s, y0: DOC.y0 + s, x1: DOC.x1 - s, y1: DOC.y1 - s, r: DOC.r - s / 2 });
  let on = outer && !inner;
  for (const l of LINES) if (x >= l.x0 && x <= l.x1 && Math.abs(y - l.y) <= l.h / 2) on = true;
  if (busy) {
    const d2 = (x - DOT.cx) ** 2 + (y - DOT.cy) ** 2;
    if (d2 <= (DOT.r + DOT.gap) ** 2) on = false; // knock out a gap around the dot
    if (d2 <= DOT.r ** 2) on = true;
  }
  return on;
}

function render(size, busy) {
  const scale = size / 18;
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxX = 0; pxX < size; pxX++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (pxX + (sx + 0.5) / ss) / scale;
          const y = (py + (sy + 0.5) / ss) / scale;
          if (covered(x, y, busy)) hits++;
        }
      }
      const i = (py * size + pxX) * 4;
      px[i + 3] = Math.round((255 * hits) / (ss * ss)); // RGB stays black
    }
  }
  return png(size, size, px);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [name, busy] of [
  ['trayTemplate', false],
  ['trayBusyTemplate', true],
]) {
  writeFileSync(join(outDir, `${name}.png`), render(18, busy));
  writeFileSync(join(outDir, `${name}@2x.png`), render(36, busy));
}
