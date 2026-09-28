import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { oleStreamNames, readZipEntry } from '../../../../src/main/sources/containers';
import { readHead } from '../../../../src/main/sources/io';
import { sniff } from '../../../../src/main/sources/sniff';
import { containerReaders } from '../../../../src/main/sources/io';
import * as fx from './fixtures';

describe('readZipEntry (built-in central-directory reader)', () => {
  it.each(['DEFLATE', 'STORE'] as const)('reads [Content_Types].xml from a %s package', async (compression) => {
    const dir = await fx.tmpDir();
    const file = await fx.put(dir, 'deck.pptx', await fx.ooxml('pptx', compression));
    const buf = await readZipEntry(file, '[Content_Types].xml');
    expect(buf?.toString('utf8')).toContain('presentationml.presentation.main+xml');
  });

  it('returns null for a missing entry, a non-zip, a missing file and an over-cap entry', async () => {
    const dir = await fx.tmpDir();
    const zipFile = await fx.put(dir, 'a.bin', await fx.genericZip());
    expect(await readZipEntry(zipFile, '[Content_Types].xml')).toBeNull();
    expect(await readZipEntry(await fx.put(dir, 'b.txt', 'hello'), 'x')).toBeNull();
    expect(await readZipEntry(`${dir}/missing.zip`, 'x')).toBeNull();
    const big = new JSZip();
    big.file('[Content_Types].xml', 'x'.repeat(5000));
    const bigFile = await fx.put(
      dir,
      'big.zip',
      await big.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    );
    expect(await readZipEntry(bigFile, '[Content_Types].xml', 1000)).toBeNull();
    expect((await readZipEntry(bigFile, '[Content_Types].xml'))?.length).toBe(5000);
  });

  it('returns null for a truncated archive', async () => {
    const dir = await fx.tmpDir();
    const whole = await fx.ooxml('docx');
    const file = await fx.put(dir, 'cut.docx', whole.subarray(0, whole.length - 30));
    expect(await readZipEntry(file, '[Content_Types].xml')).toBeNull();
  });
});

describe('oleStreamNames (built-in MS-CFB directory reader)', () => {
  it('lists stream names from a minimal compound file', async () => {
    const dir = await fx.tmpDir();
    const file = await fx.put(dir, 'enc.docx', fx.ole(['EncryptionInfo', 'EncryptedPackage']));
    expect(await oleStreamNames(file)).toEqual(['EncryptionInfo', 'EncryptedPackage']);
  });

  it('returns [] for non-OLE or missing files', async () => {
    const dir = await fx.tmpDir();
    expect(await oleStreamNames(await fx.put(dir, 'a.txt', 'hello'))).toEqual([]);
    expect(await oleStreamNames(`${dir}/nope`)).toEqual([]);
  });
});

describe('sniff() with file-backed container readers', () => {
  it.each([
    ['deck.pptx', () => fx.ooxml('pptx'), { ok: true, format: 'pptx' }],
    ['memo.docm', () => fx.ooxml('docm'), { ok: true, format: 'docx' }],
    ['book.xlsx', () => fx.ooxml('xlsx'), { ok: true, format: 'xlsx' }],
    ['generic-archive.bin', () => fx.genericZip(), { ok: false, code: 'unsupported-type', detail: 'ZIP archive' }],
    ['secret.doc', () => Promise.resolve(fx.ole(['EncryptedPackage'])), { ok: false, code: 'encrypted' }],
    ['old.ppt', () => Promise.resolve(fx.ole(['PowerPoint Document'])), { ok: false, code: 'legacy-office-format' }],
  ] as const)('%s', async (name, make, expected) => {
    const dir = await fx.tmpDir();
    const file = await fx.put(dir, name, await make());
    expect(await sniff(await readHead(file), name, containerReaders(file))).toMatchObject(expected);
  });
});
