/**
 * Minimal read-only container inspection for sniff() (03 §5.2): one entry from a ZIP central
 * directory, and the stream names of an OLE compound file. Small built-in readers so no zip or CFB
 * dependency is needed (01 §7 lists yauzl, which is not installed). Neither ever reads more than a
 * bounded amount of the file, and both return null / [] instead of throwing on malformed input.
 */
import { open, type FileHandle } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

/** Cap on the uncompressed size of a sniffed ZIP entry ([Content_Types].xml is a few KiB). */
export const MAX_ZIP_ENTRY_BYTES = 1024 * 1024;
const MAX_CENTRAL_DIR_BYTES = 16 * 1024 * 1024;
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return bytesRead === length ? buf : buf.subarray(0, bytesRead);
}

/**
 * Read one entry (exact name) from a ZIP file via its central directory. Returns null when the entry
 * is missing, larger than maxBytes, uses an unsupported method, or the archive is ZIP64/malformed.
 */
export async function readZipEntry(
  filePath: string,
  name: string,
  maxBytes = MAX_ZIP_ENTRY_BYTES,
): Promise<Buffer | null> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(filePath, 'r');
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || cdSize > MAX_CENTRAL_DIR_BYTES || cdOffset + cdSize > size) return null;
    const cd = await readAt(fh, cdOffset, cdSize);
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === CEN_SIG) {
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const entryName = cd.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (entryName !== name) continue;
      if (uncompSize > maxBytes || compSize > maxBytes) return null;
      const loc = await readAt(fh, localOffset, 30);
      if (loc.length < 30 || loc.readUInt32LE(0) !== LOC_SIG) return null;
      const dataStart = localOffset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
      const data = await readAt(fh, dataStart, compSize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
      return null;
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

const ENDOFCHAIN = 0xfffffffe;
const MAX_SECTOR = 0xfffffffa;
const MAX_FAT_SECTORS = 4096;
const MAX_DIR_SECTORS = 4096;

/**
 * Names of the storages and streams in an OLE compound file (MS-CFB), e.g. "EncryptedPackage" for
 * encrypted OOXML. Reads only the header, the FAT and the directory chain. [] on any error.
 */
export async function oleStreamNames(filePath: string): Promise<string[]> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(filePath, 'r');
    const h = await readAt(fh, 0, 512);
    if (h.length < 512 || h.readUInt32LE(0) !== 0xe011cfd0 || h.readUInt32LE(4) !== 0xe11ab1a1) return [];
    const shift = h.readUInt16LE(30);
    if (shift !== 9 && shift !== 12) return [];
    const ss = 1 << shift;
    const numFat = h.readUInt32LE(44);
    const firstDir = h.readUInt32LE(48);
    let difatSector = h.readUInt32LE(68);
    if (numFat > MAX_FAT_SECTORS) return [];
    const at = (sector: number) => (sector + 1) * ss;

    const fatIds: number[] = [];
    for (let i = 0; i < 109 && fatIds.length < numFat; i++) fatIds.push(h.readUInt32LE(76 + i * 4));
    for (let guard = 0; fatIds.length < numFat && difatSector <= MAX_SECTOR && guard < MAX_FAT_SECTORS; guard++) {
      const s = await readAt(fh, at(difatSector), ss);
      if (s.length < ss) break;
      for (let i = 0; i < ss / 4 - 1 && fatIds.length < numFat; i++) fatIds.push(s.readUInt32LE(i * 4));
      difatSector = s.readUInt32LE(ss - 4);
    }
    const fat: number[] = [];
    for (const id of fatIds) {
      if (id > MAX_SECTOR) break;
      const s = await readAt(fh, at(id), ss);
      for (let i = 0; i + 4 <= s.length; i += 4) fat.push(s.readUInt32LE(i));
    }

    const names: string[] = [];
    const seen = new Set<number>();
    for (let sec = firstDir; sec <= MAX_SECTOR && !seen.has(sec) && seen.size < MAX_DIR_SECTORS;) {
      seen.add(sec);
      const s = await readAt(fh, at(sec), ss);
      for (let o = 0; o + 128 <= s.length; o += 128) {
        const nameLen = s.readUInt16LE(o + 64);
        const type = s[o + 66];
        if ((type === 1 || type === 2) && nameLen >= 2 && nameLen <= 64) {
          names.push(s.toString('utf16le', o, o + nameLen - 2));
        }
      }
      const next = fat[sec];
      if (next === undefined || next === ENDOFCHAIN) break;
      sec = next;
    }
    return names;
  } catch {
    return [];
  } finally {
    await fh?.close();
  }
}
