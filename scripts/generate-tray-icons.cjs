// Generates the menu bar template images (11 §4.1): "eli5" in a thin font inside a thin oval, plus
// a busy variant with a dot. Template images carry meaning in alpha only (black ink); macOS tints
// them for light and dark menu bars. Text needs a real font renderer, so this runs in Electron:
//   npx electron scripts/generate-tray-icons.cjs
const { app, BrowserWindow, nativeImage } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { deflateSync } = require('node:zlib');

const OUT = join(__dirname, '..', 'resources', 'tray');
// Design space in points: 32 × 18 (a 22 pt menu bar leaves room above and below).
const W = 32;
const H = 18;
const SS = 4; // supersampling before the downscale

function svg(busy) {
  const dot = busy
    ? `<mask id="m"><rect width="${W}" height="${H}" fill="white"/><circle cx="28.5" cy="4" r="4.3" fill="black"/></mask>
       <circle cx="28.5" cy="4" r="2.8" fill="black"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W * SS}" height="${H * SS}" viewBox="0 0 ${W} ${H}">
    ${dot}
    <g ${busy ? 'mask="url(#m)"' : ''}>
      <ellipse cx="16" cy="9" rx="15.3" ry="8.3" fill="none" stroke="black" stroke-width="1"/>
      <text x="16" y="12.55" text-anchor="middle" font-family="Helvetica Neue, Helvetica, sans-serif"
        font-weight="200" font-size="10.5" letter-spacing="0.2" fill="black">eli5</text>
    </g>
  </svg>`;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** RGBA PNG, black ink with the given alpha per pixel. */
function templatePng(w, h, alpha) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) raw[y * (w * 4 + 1) + 1 + x * 4 + 3] = alpha[y * w + x];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function render(win, busy, scale) {
  const html = `<!doctype html><html><body style="margin:0;background:transparent">${svg(busy)}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 300));
  const shot = await win.webContents.capturePage({ x: 0, y: 0, width: W * SS, height: H * SS });
  const img = nativeImage
    .createFromBuffer(shot.toPNG())
    .resize({ width: W * scale, height: H * scale, quality: 'best' });
  const bmp = img.toBitmap(); // BGRA
  const { width, height } = img.getSize();
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) alpha[i] = bmp[i * 4 + 3];
  return templatePng(width, height, alpha);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: W * SS,
    height: H * SS,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  win.webContents.setZoomFactor(1);
  for (const busy of [false, true]) {
    const base = busy ? 'trayBusyTemplate' : 'trayTemplate';
    writeFileSync(join(OUT, `${base}.png`), await render(win, busy, 1));
    writeFileSync(join(OUT, `${base}@2x.png`), await render(win, busy, 2));
  }
  console.log(`wrote ${OUT}/tray{,Busy}Template{,@2x}.png`);
  app.exit(0);
});
