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
import { ftyp, ole } from '../../../fixtures/build/unsupported';

export { ftyp, ole };

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
