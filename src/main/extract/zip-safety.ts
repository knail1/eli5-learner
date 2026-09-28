/**
 * ZIP (OOXML) safety (04 §10.3). A small central-directory reader replaces yauzl, which is not a
 * dependency (01 §7 lists jszip; jszip has no pre-inflate size checks). It validates the archive
 * before anything is inflated, then inflates only requested parts with a hard output cap:
 * - entryCount > 10,000, declared total > 1 GiB, or an .xml/.rels part > 100 MiB: zip-bomb
 * - entry names with "..", absolute paths or backslashes: corrupt
 * - a part inflating past its declared size (sizes can lie) or the archive-wide running total
 *   passing 1 GiB: zip-bomb
 */
import { inflateRawSync } from 'node:zlib';
import { ZIP_LIMITS } from './limits';
import { ExtractError } from './skip';

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  encrypted: boolean;
}

export interface ZipLimits {
  maxEntries: number;
  maxTotalUncompressed: number;
  maxXmlPartBytes: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

function corrupt(detail: string): ExtractError {
  return new ExtractError('corrupt', `zip: ${detail}`);
}
function bomb(detail: string): ExtractError {
  return new ExtractError('zip-bomb', `zip: ${detail}`);
}

function u64(view: DataView, off: number): number {
  const v = view.getBigUint64(off, true);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw bomb('64-bit size out of range');
  return Number(v);
}

function unsafeName(name: string): boolean {
  if (name.includes('\\') || name.includes('\0')) return true;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return true;
  return name.split('/').some((seg) => seg === '..');
}

export class SafeZip {
  private readonly view: DataView;
  private readonly byName = new Map<string, ZipEntry>();
  private inflatedTotal = 0;

  private constructor(
    private readonly bytes: Uint8Array,
    readonly entries: readonly ZipEntry[],
    private readonly limits: ZipLimits,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const e of entries) if (!this.byName.has(e.name)) this.byName.set(e.name, e);
  }

  /** Reads and checks the central directory. Nothing is inflated here (§10.3 step 1). */
  static open(bytes: Uint8Array, limits: ZipLimits = ZIP_LIMITS): SafeZip {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = bytes.byteLength;
    if (len < 22) throw corrupt('too short');
    let eocd = -1;
    for (let i = len - 22; i >= Math.max(0, len - 22 - 0xffff); i--) {
      if (view.getUint32(i, true) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw corrupt('no end of central directory');
    let count = view.getUint16(eocd + 10, true);
    let cdSize = view.getUint32(eocd + 12, true);
    let cdOffset = view.getUint32(eocd + 16, true);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || view.getUint32(loc, true) !== SIG_EOCD64_LOCATOR) throw corrupt('missing zip64 locator');
      const rec = u64(view, loc + 8);
      if (rec + 56 > len || view.getUint32(rec, true) !== SIG_EOCD64) throw corrupt('bad zip64 record');
      count = u64(view, rec + 32);
      cdSize = u64(view, rec + 40);
      cdOffset = u64(view, rec + 48);
    }
    if (count > limits.maxEntries) throw bomb(`entry count ${count}`);
    if (cdOffset + cdSize > len) throw corrupt('central directory out of range');

    const entries: ZipEntry[] = [];
    let total = 0;
    let p = cdOffset;
    const dec = new TextDecoder('utf-8');
    for (let i = 0; i < count; i++) {
      if (p + 46 > len || view.getUint32(p, true) !== SIG_CEN) throw corrupt('bad central directory entry');
      const flags = view.getUint16(p + 8, true);
      const method = view.getUint16(p + 10, true);
      let compressedSize = view.getUint32(p + 20, true);
      let uncompressedSize = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      let localHeaderOffset = view.getUint32(p + 42, true);
      const nameStart = p + 46;
      if (nameStart + nameLen + extraLen > len) throw corrupt('entry name out of range');
      const name = dec.decode(bytes.subarray(nameStart, nameStart + nameLen));
      // Zip64 extended information (header id 0x0001): only the saturated fields are present.
      let x = nameStart + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = view.getUint16(x, true);
        const size = view.getUint16(x + 2, true);
        if (id === 0x0001) {
          let q = x + 4;
          if (uncompressedSize === 0xffffffff && q + 8 <= xEnd) {
            uncompressedSize = u64(view, q);
            q += 8;
          }
          if (compressedSize === 0xffffffff && q + 8 <= xEnd) {
            compressedSize = u64(view, q);
            q += 8;
          }
          if (localHeaderOffset === 0xffffffff && q + 8 <= xEnd) localHeaderOffset = u64(view, q);
        }
        x += 4 + size;
      }
      if (unsafeName(name)) throw corrupt('unsafe entry name');
      total += uncompressedSize;
      if (total > limits.maxTotalUncompressed) throw bomb('declared total size');
      if (/\.(xml|rels)$/i.test(name) && uncompressedSize > limits.maxXmlPartBytes) throw bomb('declared part size');
      entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset, encrypted: (flags & 1) === 1 });
      p = nameStart + nameLen + extraLen + commentLen;
    }
    return new SafeZip(bytes, entries, limits);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  entry(name: string): ZipEntry | undefined {
    return this.byName.get(name);
  }

  /** Inflates one part with its declared size as a hard cap (§10.3 step 2). */
  read(name: string): Uint8Array | undefined {
    const e = this.byName.get(name);
    if (!e) return undefined;
    return this.inflate(e);
  }

  readText(name: string): string | undefined {
    const b = this.read(name);
    return b === undefined ? undefined : new TextDecoder('utf-8').decode(b);
  }

  /**
   * Inflates every entry under the same caps without keeping the output. Used before handing the
   * archive to a library that unzips internally (mammoth, SheetJS), so lying sizes are caught first.
   */
  verifyAll(): void {
    for (const e of this.entries) this.inflate(e);
  }

  private inflate(e: ZipEntry): Uint8Array {
    if (e.encrypted) throw new ExtractError('encrypted', 'zip: encrypted entry');
    const off = e.localHeaderOffset;
    if (off + 30 > this.bytes.byteLength || this.view.getUint32(off, true) !== SIG_LOC) {
      throw corrupt('bad local header');
    }
    const start = off + 30 + this.view.getUint16(off + 26, true) + this.view.getUint16(off + 28, true);
    const end = start + e.compressedSize;
    if (end > this.bytes.byteLength) throw corrupt('entry data out of range');
    const data = this.bytes.subarray(start, end);
    const remaining = this.limits.maxTotalUncompressed - this.inflatedTotal;
    let out: Uint8Array;
    if (e.method === 0) {
      out = data;
    } else if (e.method === 8) {
      // One byte of headroom: inflating past the declared size proves the size lied.
      const cap = Math.min(e.uncompressedSize, remaining) + 1;
      try {
        out = inflateRawSync(data, { maxOutputLength: cap });
      } catch (err) {
        if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
          throw bomb('inflated past declared size');
        }
        throw corrupt('inflate failed');
      }
    } else {
      throw corrupt(`unsupported compression method ${e.method}`);
    }
    if (out.byteLength > e.uncompressedSize) throw bomb('inflated past declared size');
    if (out.byteLength !== e.uncompressedSize) throw corrupt('size mismatch');
    this.inflatedTotal += out.byteLength;
    if (this.inflatedTotal > this.limits.maxTotalUncompressed) throw bomb('running total');
    return out;
  }
}

/** Resolves a relationship target against the part that owns the .rels file. */
export function resolvePartPath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = baseDir ? baseDir.split('/') : [];
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

/** "ppt/slides/slide1.xml" -> "ppt/slides/_rels/slide1.xml.rels". */
export function relsPathFor(part: string): string {
  const i = part.lastIndexOf('/');
  return i < 0 ? `_rels/${part}.rels` : `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
}

export function dirOf(part: string): string {
  const i = part.lastIndexOf('/');
  return i < 0 ? '' : part.slice(0, i);
}
