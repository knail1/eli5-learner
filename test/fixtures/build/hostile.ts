/**
 * Hostile fixtures (13 §5.1, 04 §10.3): archives that must be refused fast. jszip cannot write
 * lying sizes, so a raw ZIP writer builds the archives entry by entry.
 */
import { crc32, deflateRawSync } from 'node:zlib';
import JSZip from 'jszip';
import { FIXED_DATE } from './common';
import { buildXmlEntityDeck } from './pptx';
import { buildBudget } from './xlsx';

export { buildXmlEntityDeck };

export interface RawEntry {
  name: string;
  data: Uint8Array;
  method: 0 | 8;
  /** Size written to the headers; defaults to the true inflated size. */
  declaredSize?: number;
  inflatedSize?: number;
}

export function rawZip(entries: RawEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const size = e.declaredSize ?? e.inflatedSize ?? e.data.length;
    const crc = crc32(e.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(e.method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x5c21, 12); // 2026-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(size >>> 0, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, Buffer.from(e.data));
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(e.method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x5c21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(size >>> 0, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Math.min(entries.length, 0xffff), 8);
  eocd.writeUInt16LE(Math.min(entries.length, 0xffff), 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

const CONTENT_TYPES = (main: string): Uint8Array =>
  Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      `<Override PartName="${main}" ContentType="application/xml"/></Types>`,
  );

/** 10,001 empty entries: refused on the entry count alone. */
export function zipBombEntries(): Uint8Array {
  const entries: RawEntry[] = [{ name: '[Content_Types].xml', data: CONTENT_TYPES('/ppt/presentation.xml'), method: 0 }];
  for (let i = 0; i < 10_000; i++) entries.push({ name: `x/${String(i).padStart(5, '0')}`, data: new Uint8Array(0), method: 0 });
  return rawZip(entries);
}

/** An XML part declaring 200 MiB (over the 100 MiB part cap); nothing is inflated. */
export function zipBombDeclaredXml(): Uint8Array {
  const small = deflateRawSync(Buffer.from('<p:presentation/>'));
  return rawZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES('/ppt/presentation.xml'), method: 0 },
    { name: 'ppt/presentation.xml', data: small, method: 8, declaredSize: 200 * 1024 * 1024 },
  ]);
}

/** Twelve media entries declaring 100 MiB each: over the 1 GiB declared total. */
export function zipBombDeclaredTotal(): Uint8Array {
  const tiny = deflateRawSync(Buffer.from('x'));
  const entries: RawEntry[] = [{ name: '[Content_Types].xml', data: CONTENT_TYPES('/word/document.xml'), method: 0 }];
  for (let i = 0; i < 12; i++) entries.push({ name: `word/media/image${i}.bin`, data: tiny, method: 8, declaredSize: 100 * 1024 * 1024 });
  return rawZip(entries);
}

/** word/document.xml declares 1 KB but inflates to 64 MiB of spaces: sizes lie. */
export function lyingSizes(): Uint8Array {
  const big = Buffer.alloc(64 * 1024 * 1024, 0x20);
  big.write('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">', 0);
  return rawZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES('/word/document.xml'), method: 0 },
    { name: 'word/document.xml', data: deflateRawSync(big, { level: 9 }), method: 8, declaredSize: 1024 },
  ]);
}

/**
 * The budget workbook with a DTD and entity declaration in xl/workbook.xml: SheetJS parses the XML
 * itself, so the extractor must refuse it as corrupt first (04 §10.3).
 */
export async function xmlEntityWorkbook(): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await buildBudget());
  const part = zip.file('xl/workbook.xml');
  if (!part) throw new Error('workbook part missing');
  const xml = await part.async('string');
  const dtd = '<!DOCTYPE workbook [<!ENTITY company "Example Widgets Inc.">]>';
  const patched = /^<\?xml[^>]*\?>/.test(xml) ? xml.replace(/^(<\?xml[^>]*\?>)/, `$1${dtd}`) : dtd + xml;
  zip.file('xl/workbook.xml', patched, { date: FIXED_DATE });
  for (const f of Object.values(zip.files)) f.date = FIXED_DATE;
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
