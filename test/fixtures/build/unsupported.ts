/**
 * Unsupported-signature fixtures under sources/unsupported/ (13 §5.1, 03 §15): a legacy OLE Office
 * file, encrypted OOXML (an OLE container with an EncryptedPackage stream), an AVIF image and a
 * generic ZIP archive (`.bin`, because the repo ignores `*.zip`). Deterministic: rebuilding gives the
 * committed bytes. memo.rtf and empty.txt are hand-written.
 */
import JSZip from 'jszip';

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

/** `.doc`: OLE container without EncryptedPackage -> legacy-office-format. */
export function legacyDoc(): Buffer {
  return ole(['WordDocument', '\u0001CompObj']);
}

/** `.docx` that is really an OLE container holding EncryptedPackage -> encrypted. */
export function encryptedDocx(): Buffer {
  return ole(['EncryptionInfo', 'EncryptedPackage']);
}

/** AVIF `ftyp` head -> unsupported-type ("AVIF image; export as PNG or JPEG"). */
export function avifImage(): Buffer {
  return ftyp('avif', ['mif1', 'miaf', 'avif']);
}

/** ZIP magic bytes with no [Content_Types].xml -> unsupported-type ("ZIP archive"). */
export function genericArchive(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('readme.txt', 'Example Widgets Inc. archive\n', { date: new Date(Date.UTC(2026, 0, 1)) });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' });
}

/** File name -> builder and the skip code the file resolver must produce. */
export const UNSUPPORTED_FIXTURES = [
  { name: 'legacy.doc', build: legacyDoc, code: 'legacy-office-format' },
  { name: 'encrypted.docx', build: encryptedDocx, code: 'encrypted' },
  { name: 'photo.avif', build: avifImage, code: 'unsupported-type' },
  { name: 'generic-archive.bin', build: genericArchive, code: 'unsupported-type' },
] as const;
