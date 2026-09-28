import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ExtractError } from '../../../../src/main/extract';
import { SafeZip, relsPathFor, resolvePartPath } from '../../../../src/main/extract/zip-safety';
import { FIXTURES_DIR } from '../../../contracts/extractor.contract';
import { zipFiles } from '../../../fixtures/build/common';
import { rawZip } from '../../../fixtures/build/hostile';

const fixture = (rel: string): Uint8Array => new Uint8Array(readFileSync(resolve(FIXTURES_DIR, rel)));

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof ExtractError ? e.code : 'other';
  }
}

describe('SafeZip (04 §10.3)', () => {
  it('reads parts of a normal archive', async () => {
    const zip = SafeZip.open(
      await zipFiles([
        ['a/b.xml', '<x>hi</x>'],
        ['c.bin', new Uint8Array([1, 2, 3])],
      ]),
    );
    expect(zip.readText('a/b.xml')).toBe('<x>hi</x>');
    expect([...zip.read('c.bin')!]).toEqual([1, 2, 3]);
    expect(zip.read('missing')).toBeUndefined();
    expect(zip.has('a/b.xml')).toBe(true);
  });

  it('refuses too many entries before inflating anything', () => {
    expect(codeOf(() => SafeZip.open(fixture('sources/hostile/zip-bomb-entries.pptx')))).toBe('zip-bomb');
  });

  it('refuses declared sizes over the part and archive caps', () => {
    expect(codeOf(() => SafeZip.open(fixture('sources/hostile/declared-xml-size.pptx')))).toBe('zip-bomb');
    expect(codeOf(() => SafeZip.open(fixture('sources/hostile/declared-total-size.docx')))).toBe('zip-bomb');
  });

  it('refuses a part that inflates past its declared size, fast and without large memory growth', () => {
    const zip = SafeZip.open(fixture('sources/hostile/lying-sizes.docx'));
    const before = process.memoryUsage().rss;
    const t = Date.now();
    expect(codeOf(() => zip.read('word/document.xml'))).toBe('zip-bomb');
    expect(codeOf(() => zip.verifyAll())).toBe('zip-bomb');
    expect(Date.now() - t).toBeLessThan(1000);
    expect(process.memoryUsage().rss - before).toBeLessThan(64 * 1024 * 1024);
  });

  it('enforces the archive-wide running total while inflating', () => {
    const data = Buffer.alloc(4096, 0x41);
    const z = rawZip([{ name: 'a.xml', data: deflateRawSync(data), method: 8, inflatedSize: 4096 }]);
    const zip = SafeZip.open(z, { maxEntries: 10, maxTotalUncompressed: 6000, maxXmlPartBytes: 5000 });
    expect(zip.read('a.xml')?.byteLength).toBe(4096);
    // Re-reading counts again: the running total is across everything inflated from the archive.
    expect(codeOf(() => zip.read('a.xml'))).toBe('zip-bomb');
    const declared = rawZip([
      { name: 'a.xml', data: deflateRawSync(data), method: 8, inflatedSize: 4096 },
      { name: 'b.xml', data: deflateRawSync(data), method: 8, inflatedSize: 4096 },
    ]);
    expect(
      codeOf(() => SafeZip.open(declared, { maxEntries: 10, maxTotalUncompressed: 6000, maxXmlPartBytes: 5000 })),
    ).toBe('zip-bomb');
  });

  it('refuses unsafe entry names and non-zip input as corrupt', () => {
    const evil = rawZip([{ name: '../evil.xml', data: Buffer.from('<x/>'), method: 0 }]);
    expect(codeOf(() => SafeZip.open(evil))).toBe('corrupt');
    const abs = rawZip([{ name: '/etc/x.xml', data: Buffer.from('<x/>'), method: 0 }]);
    expect(codeOf(() => SafeZip.open(abs))).toBe('corrupt');
    expect(codeOf(() => SafeZip.open(new TextEncoder().encode('not a zip at all, just text')))).toBe('corrupt');
  });

  it('detects a stored entry whose size does not match', () => {
    const z = rawZip([{ name: 'a.xml', data: Buffer.from('<x/>'), method: 0, declaredSize: 2 }]);
    expect(codeOf(() => SafeZip.open(z).read('a.xml'))).toBe('zip-bomb');
  });

  it('resolves relationship targets', () => {
    expect(resolvePartPath('ppt/slides', '../media/image1.png')).toBe('ppt/media/image1.png');
    expect(resolvePartPath('ppt', 'slides/slide1.xml')).toBe('ppt/slides/slide1.xml');
    expect(resolvePartPath('ppt/slides', '/ppt/charts/c.xml')).toBe('ppt/charts/c.xml');
    expect(relsPathFor('ppt/slides/slide1.xml')).toBe('ppt/slides/_rels/slide1.xml.rels');
    expect(relsPathFor('doc.xml')).toBe('_rels/doc.xml.rels');
  });
});
