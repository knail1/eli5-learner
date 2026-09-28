/**
 * Synthetic source fixtures built at test time (13 §5.3 rule 4): minimal heads for every sniff()
 * signature row, OOXML/ZIP containers via jszip, and a minimal OLE compound file. Nothing here is
 * real content; everything is a few hundred bytes to a few KiB.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach } from 'vitest';

/** Shape Finder writes for NSFilenamesPboardType on a multi-file copy. */
export const FINDER_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
\t<string>/Users/example/Documents/Q3 Review.pptx</string>
\t<string>/Users/example/Documents/Notes &amp; Actions.md</string>
\t<string>/Users/example/Desktop/caf&#xE9;.png</string>
</array>
</plist>
`;

export const TEXT_BODY = 'Example Widgets Inc. quarterly notes.\nRevenue grew in every region.\n';

export function pdf(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< >>\n%%EOF\n', 'latin1');
}

export function png(): Buffer {
  // Signature + a plausible IHDR chunk; sniff() only needs the signature.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('0000000d49484452000000010000000108060000001f15c489', 'hex'),
  ]);
}

export const jpeg = (): Buffer => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
export const gif87 = (): Buffer => Buffer.from('GIF87a\x01\x00\x01\x00\x00\x00\x00', 'latin1');
export const gif89 = (): Buffer => Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00', 'latin1');
export const webp = (): Buffer => Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1');
export const tiffLE = (): Buffer => Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
export const tiffBE = (): Buffer => Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]);
export const rtf = (): Buffer => Buffer.from('{\\rtf1\\ansi Example Widgets Inc. memo}', 'latin1');

export function bmp(dibHeaderSize = 40): Buffer {
  const b = Buffer.alloc(54);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(54, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(dibHeaderSize, 14);
  return b;
}

/** ISO-BMFF `ftyp` box with a major brand and compatible brands. */
export function ftyp(major: string, compat: string[]): Buffer {
  const size = 16 + compat.length * 4;
  const b = Buffer.alloc(size + 8);
  b.writeUInt32BE(size, 0);
  b.write('ftyp', 4, 'latin1');
  b.write(major, 8, 'latin1');
  b.writeUInt32BE(0, 12);
  compat.forEach((c, i) => b.write(c, 16 + i * 4, 'latin1'));
  return b;
}

const CT = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  docm: 'application/vnd.ms-word.document.macroEnabled.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
} as const;
const PART = { pptx: '/ppt/presentation.xml', docx: '/word/document.xml', xlsx: '/xl/workbook.xml' } as const;

/** A minimal OOXML package: [Content_Types].xml naming the main part, plus that part. */
export async function ooxml(kind: keyof typeof CT, compression: 'DEFLATE' | 'STORE' = 'DEFLATE'): Promise<Buffer> {
  const base = kind.startsWith('ppt') ? 'pptx' : kind.startsWith('doc') ? 'docx' : 'xlsx';
  const part = PART[base];
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="${part}" ContentType="${CT[kind]}"/></Types>`,
  );
  zip.file(part.slice(1), '<root>Example Widgets Inc.</root>');
  return zip.generateAsync({ type: 'nodebuffer', compression });
}

/** A ZIP archive that is not an OOXML package. */
export async function genericZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('readme.txt', 'Example Widgets Inc. archive');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Minimal OLE compound file (MS-CFB v3, 512-byte sectors): header, one FAT sector (sector 0), one
 * directory sector (sector 1) holding a root entry plus the named streams.
 */
export function ole(streams: string[]): Buffer {
  const SS = 512;
  const FREE = 0xffffffff;
  const END = 0xfffffffe;
  const FATSECT = 0xfffffffd;
  const header = Buffer.alloc(SS);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x003e, 24);
  header.writeUInt16LE(0x0003, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(1, 44); // one FAT sector
  header.writeUInt32LE(1, 48); // directory starts at sector 1
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(END, 60);
  header.writeUInt32LE(0, 64);
  header.writeUInt32LE(END, 68);
  header.writeUInt32LE(0, 72);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i === 0 ? 0 : FREE, 76 + i * 4);

  const fat = Buffer.alloc(SS, 0xff);
  fat.writeUInt32LE(FATSECT, 0);
  fat.writeUInt32LE(END, 4);

  const dir = Buffer.alloc(SS);
  const names = ['Root Entry', ...streams].slice(0, 4);
  names.forEach((name, i) => {
    const o = i * 128;
    const encoded = Buffer.from(`${name}\0`, 'utf16le');
    encoded.copy(dir, o);
    dir.writeUInt16LE(encoded.length, o + 64);
    dir[o + 66] = i === 0 ? 5 : 2;
  });
  return Buffer.concat([header, fat, dir]);
}

/** Fresh temp dir removed after each test. */
export async function tmpDir(prefix = 'eli5-sources-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

export async function put(dir: string, rel: string, data: Buffer | string): Promise<string> {
  const full = path.join(dir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, data);
  return full;
}
