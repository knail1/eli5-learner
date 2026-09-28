/**
 * PDF fixtures (13 §5.1) from a minimal hand-written PDF writer (no PDF library is a dependency):
 * two-column.pdf (two columns, running header/footer, hyphenation, a list), scanned-3p.pdf (three
 * image-only pages), mixed.pdf (two text pages plus one image-only page), and encrypted.pdf (a
 * user password, RC4 40-bit standard security handler). Text uses the standard Helvetica font.
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

type Obj = Buffer;

/** WinAnsi-encoded PDF string literal with ( ) \ escaped; • and – mapped to their WinAnsi codes. */
function pdfString(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (ch === '•') out += '\\225';
    else if (ch === '–') out += '\\226';
    else if (ch === '—') out += '\\227';
    else out += ch;
  }
  return `(${out})`;
}

class PdfWriter {
  private readonly objs: Obj[] = [];

  reserve(): number {
    this.objs.push(Buffer.alloc(0));
    return this.objs.length;
  }
  set(n: number, body: string | Buffer): void {
    this.objs[n - 1] = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
  }
  add(body: string | Buffer): number {
    const n = this.reserve();
    this.set(n, body);
    return n;
  }
  static stream(dict: string, data: Buffer): Buffer {
    return Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);
  }
  finish(root: number, trailerExtra = '', info?: number): Uint8Array {
    const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    const offsets: number[] = [];
    let pos = parts[0]!.length;
    this.objs.forEach((o, i) => {
      offsets.push(pos);
      const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), o, Buffer.from('\nendobj\n', 'latin1')]);
      parts.push(b);
      pos += b.length;
    });
    const xref =
      `xref\n0 ${this.objs.length + 1}\n0000000000 65535 f \n` +
      offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
      `trailer\n<< /Size ${this.objs.length + 1} /Root ${root} 0 R${info ? ` /Info ${info} 0 R` : ''}${trailerExtra} >>\nstartxref\n${pos}\n%%EOF\n`;
    parts.push(Buffer.from(xref, 'latin1'));
    return new Uint8Array(Buffer.concat(parts));
  }
}

interface TextLine {
  text: string;
  x: number;
  y: number;
  size: number;
}

interface PageSpec {
  lines: TextLine[];
  /** Full-page grayscale image drawn under the text. */
  image?: { width: number; height: number; pixels: Buffer };
}

function contentFor(p: PageSpec): Buffer {
  let s = '';
  if (p.image) s += 'q 612 0 0 792 0 0 cm /Im1 Do Q\n';
  for (const l of p.lines) s += `BT /F1 ${l.size} Tf ${l.x} ${l.y} Td ${pdfString(l.text)} Tj ET\n`;
  return Buffer.from(s, 'latin1');
}

function buildPdf(
  pages: PageSpec[],
  opts: { title?: string; encrypt?: (objNum: number, data: Buffer) => Buffer; trailerExtra?: string; encryptObj?: string } = {},
): Uint8Array {
  const w = new PdfWriter();
  const catalog = w.reserve();
  const pagesObj = w.reserve();
  const font = w.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const p of pages) {
    const resources: string[] = [`/Font << /F1 ${font} 0 R >>`];
    if (p.image) {
      const img = w.add(
        PdfWriter.stream(
          `/Type /XObject /Subtype /Image /Width ${p.image.width} /Height ${p.image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,
          deflateSync(p.image.pixels, { level: 9 }),
        ),
      );
      resources.push(`/XObject << /Im1 ${img} 0 R >>`);
    }
    const contentNum = w.reserve();
    const raw = contentFor(p);
    w.set(contentNum, PdfWriter.stream('', opts.encrypt ? opts.encrypt(contentNum, raw) : raw));
    kids.push(
      w.add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << ${resources.join(' ')} >> /Contents ${contentNum} 0 R >>`),
    );
  }
  w.set(pagesObj, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  w.set(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  const info = opts.title && !opts.encrypt ? w.add(`<< /Title ${pdfString(opts.title)} /Producer (fixture generator) >>`) : undefined;
  let trailer = opts.trailerExtra ?? '';
  if (opts.encryptObj) trailer += ` /Encrypt ${w.add(opts.encryptObj)} 0 R`;
  return w.finish(catalog, trailer, info);
}

const HEADER = 'Example Widgets Inc. Operations Review';
function runningLines(n: number, total: number): TextLine[] {
  return [
    { text: HEADER, x: 72, y: 760, size: 9 },
    { text: `Page ${n} of ${total}`, x: 280, y: 36, size: 9 },
  ];
}
function column(x: number, top: number, paras: string[][], size = 10): TextLine[] {
  const out: TextLine[] = [];
  let y = top;
  for (const para of paras) {
    for (const t of para) {
      out.push({ text: t, x, y, size });
      y -= 13;
    }
    y -= 13;
  }
  return out;
}

export function buildTwoColumn(): Uint8Array {
  const p1: PageSpec = {
    lines: [
      ...runningLines(1, 3),
      { text: 'Operations Review 2026', x: 72, y: 700, size: 20 },
      ...column(72, 660, [
        ['Example Widgets Inc. runs two', 'plants that assemble sensors for', 'industrial customers. This review', 'covers the year to date.'],
        ['The north plant expanded its manufac-', 'turing floor by a third and hired', 'forty new technicians.'],
      ]),
      ...column(330, 660, [
        ['The south plant focused on quality.', 'Defect rates fell from 1.2% to', '0.7% after the new inspection line', 'went live in April.'],
        ['Shipping volumes grew in every', 'region except one, where a customs', 'delay held orders for two weeks.'],
      ]),
    ],
  };
  const p2: PageSpec = {
    lines: [
      ...runningLines(2, 3),
      { text: 'Plant metrics', x: 72, y: 700, size: 14 },
      ...column(72, 670, [['• Output: 48,000 units', '• Overtime: down 15%']]),
      { text: '– Weekend shifts cut to two', x: 86, y: 644, size: 10 },
      ...column(72, 618, [['Staffing held steady at 310', 'people across both sites.']]),
      ...column(330, 670, [['Energy use per unit dropped', 'by a tenth after the compressor', 'upgrade in the north plant.'], ['Water use was flat.']]),
    ],
  };
  const p3: PageSpec = {
    lines: [
      ...runningLines(3, 3),
      { text: 'Outlook', x: 72, y: 700, size: 14 },
      ...column(72, 670, [
        ['The second half plan adds a third shift at the south plant and a new supplier for housings.'],
        ['Capital spending stays within the approved budget of 4.2 million dollars for the year.'],
      ]),
    ],
  };
  return buildPdf([p1, p2, p3], { title: 'Operations Review 2026' });
}

/** A grayscale page image with dark bars that look like lines of text. */
function scanImage(seed: number): { width: number; height: number; pixels: Buffer } {
  const width = 612;
  const height = 792;
  const px = Buffer.alloc(width * height, 250);
  for (let row = 0; row < 40; row++) {
    const y0 = 80 + row * 16;
    const len = 300 + ((row * 37 + seed * 11) % 180);
    for (let y = y0; y < y0 + 8; y++) for (let x = 72; x < 72 + len; x++) px[y * width + x] = 40;
  }
  return { width, height, pixels: px };
}

export function buildScanned3p(): Uint8Array {
  return buildPdf([1, 2, 3].map((n) => ({ lines: [], image: scanImage(n) })));
}

export function buildMixed(): Uint8Array {
  return buildPdf(
    [
      {
        lines: [
          { text: 'Supplier agreement summary', x: 72, y: 700, size: 16 },
          ...column(72, 670, [
            ['Example Widgets Inc. will buy housings from a second supplier starting in July.'],
            ['Prices are fixed for twelve months and reviewed each quarter after that.'],
          ]),
        ],
      },
      {
        lines: column(72, 700, [
          ['Delivery terms: goods ship within ten business days of each purchase order.'],
          ['Either party may end the agreement with ninety days written notice.'],
        ]),
      },
      { lines: [{ text: 'Signed:', x: 72, y: 60, size: 10 }], image: scanImage(7) },
    ],
    { title: 'mixed.pdf' },
  );
}

// ---- RC4 40-bit standard security handler (revision 2) ----

const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
    out[k] = data[k]! ^ s[(s[i]! + s[j]!) & 255]!;
  }
  return out;
}
const md5 = (...parts: Buffer[]): Buffer => createHash('md5').update(Buffer.concat(parts)).digest();
const padPw = (pw: string): Buffer => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);

export function buildEncrypted(): Uint8Array {
  const userPw = 'fixture-user';
  const ownerPw = 'fixture-owner';
  const id = md5(Buffer.from('eli5-encrypted-fixture'));
  const P = -44;
  const pBytes = Buffer.alloc(4);
  pBytes.writeInt32LE(P);
  const O = rc4(md5(padPw(ownerPw)).subarray(0, 5), padPw(userPw));
  const key = md5(padPw(userPw), O, pBytes, id).subarray(0, 5);
  const U = rc4(key, PAD);
  const objKey = (n: number): Buffer => {
    const b = Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0]);
    return md5(key, b).subarray(0, 10);
  };
  return buildPdf([{ lines: column(72, 700, [['Quarterly salary bands are confidential.']]) }], {
    encrypt: (n, data) => rc4(objKey(n), data),
    encryptObj: `<< /Filter /Standard /V 1 /R 2 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${P} >>`,
    trailerExtra: ` /ID [<${id.toString('hex')}> <${id.toString('hex')}>]`,
  });
}
