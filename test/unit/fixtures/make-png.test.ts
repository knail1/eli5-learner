import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { makePng } from '../../fixtures/documents/drafts';

/**
 * Golden documents embed this PNG, so its bytes must not depend on the zlib build: compressed
 * deflate output differs between zlib versions and CPU paths (GitHub's macOS runner produced
 * different bytes for the same pixels). makePng writes uncompressed "stored" deflate blocks.
 */
function idat(png: Uint8Array): Uint8Array {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let o = 8;
  while (o < png.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    if (type === 'IDAT') return png.subarray(o + 8, o + 8 + len);
    o += 12 + len;
  }
  throw new Error('no IDAT');
}

describe('makePng (golden fixture image)', () => {
  it('writes stored (uncompressed) deflate blocks that inflate to the pattern', () => {
    const data = idat(makePng(64, 40));
    expect(data[0]).toBe(0x78);
    expect(data[2]! & 0b110).toBe(0); // BTYPE 00: stored block
    const raw = inflateSync(data);
    expect(raw.length).toBe((64 * 3 + 1) * 40);
    expect([raw[1], raw[2], raw[3]]).toEqual([31, 111, 178]); // (0,0) is "on"
  });

  it('is byte-identical everywhere (pinned hash)', () => {
    const sha = createHash('sha256').update(makePng(64, 40)).digest('hex');
    expect(sha).toBe('148a83520559413a10d20a075f5f2e8f36ec925e5814a74fed7ea800b8f200a9');
  });
});
