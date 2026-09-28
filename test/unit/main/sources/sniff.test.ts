import { describe, expect, it } from 'vitest';
import { countInvalidUtf8, isImageFormat, sniff, textProbe } from '../../../../src/main/sources/sniff';
import { IMAGE_FORMATS } from '../../../../src/main/sources/types';
import * as fx from './fixtures';

const noZip = { readZipEntry: () => Promise.resolve(null) };

describe('sniff(): signature table (03 §5.2)', () => {
  it.each([
    ['pdf', fx.pdf(), 'a.pdf', 'application/pdf'],
    ['png', fx.png(), 'a.png', 'image/png'],
    ['jpeg', fx.jpeg(), 'a.jpg', 'image/jpeg'],
    ['gif', fx.gif87(), 'a.gif', 'image/gif'],
    ['gif', fx.gif89(), 'a.gif', 'image/gif'],
    ['webp', fx.webp(), 'a.webp', 'image/webp'],
    ['tiff', fx.tiffLE(), 'a.tif', 'image/tiff'],
    ['tiff', fx.tiffBE(), 'a.tiff', 'image/tiff'],
    ['bmp', fx.bmp(), 'a.bmp', 'image/bmp'],
    ['heic', fx.ftyp('heic', ['mif1', 'heic']), 'a.heic', 'image/heic'],
    ['heic', fx.ftyp('heix', ['mif1']), 'a.heic', 'image/heic'],
    ['heic', fx.ftyp('mif1', ['heic']), 'a.heif', 'image/heic'],
    ['heic', fx.ftyp('msf1', ['msf1']), 'a.heic', 'image/heic'],
  ] as const)('%s from magic bytes (%s)', async (format, head, name, mediaType) => {
    const r = await sniff(head, name);
    expect(r).toEqual({ ok: true, format, mediaType, notes: [] });
  });

  it('finds %PDF- anywhere in the first 1024 bytes, not beyond', async () => {
    const lead = Buffer.alloc(1000, 0x20);
    expect(await sniff(Buffer.concat([lead, fx.pdf()]), 'x.pdf')).toMatchObject({ ok: true, format: 'pdf' });
    const far = Buffer.concat([Buffer.alloc(1100, 0x20), fx.pdf()]);
    expect(await sniff(far, 'x.txt')).toMatchObject({ ok: true, format: 'text' });
  });

  it('rejects BM without a plausible DIB header size as bmp', async () => {
    const r = await sniff(fx.bmp(7), 'x.bmp');
    expect(r.ok && r.format === 'bmp').toBe(false);
  });

  it.each([
    ['pptx', 'deck.pptx'],
    ['pptm', 'deck.pptm'],
    ['docx', 'memo.docx'],
    ['docm', 'memo.docm'],
    ['xlsx', 'book.xlsx'],
    ['xlsm', 'book.xlsm'],
  ] as const)('classifies OOXML %s by [Content_Types].xml', async (kind, name) => {
    const zip = await fx.ooxml(kind);
    const ct = zip; // read the entry through a fake reader over the same bytes
    const r = await sniff(ct.subarray(0, 8192), name, {
      readZipEntry: async (entry) => {
        const JSZip = (await import('jszip')).default;
        const f = (await JSZip.loadAsync(ct)).file(entry);
        return f ? f.async('nodebuffer') : null;
      },
    });
    const base = kind.replace(/m$/, 'x');
    expect(r).toMatchObject({ ok: true, format: base, notes: [] });
  });

  it('OOXML classification ignores the extension (content decides)', async () => {
    const zip = await fx.ooxml('docx');
    const r = await sniff(zip, 'renamed.pptx', {
      readZipEntry: async () =>
        Buffer.from(
          '<Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
        ),
    });
    expect(r).toMatchObject({ ok: true, format: 'docx', notes: ['extension .pptx but content is Word'] });
  });

  it('generic ZIP (no or other [Content_Types].xml) is unsupported-type "ZIP archive"', async () => {
    const zip = await fx.genericZip();
    expect(await sniff(zip, 'generic-archive.bin', noZip)).toEqual({
      ok: false,
      code: 'unsupported-type',
      detail: 'ZIP archive',
    });
    expect(
      await sniff(zip, 'a.zip', { readZipEntry: () => Promise.resolve(Buffer.from('<Types><Default/></Types>')) }),
    ).toMatchObject({ ok: false, code: 'unsupported-type' });
    // No reader at all behaves as a missing entry.
    expect(await sniff(zip, 'a.zip')).toMatchObject({ ok: false, code: 'unsupported-type' });
  });

  it('a reader that throws is treated as a missing entry', async () => {
    const zip = await fx.genericZip();
    const r = await sniff(zip, 'a.docx', { readZipEntry: () => Promise.reject(new Error('boom')) });
    expect(r).toMatchObject({ ok: false, code: 'unsupported-type', detail: 'ZIP archive' });
  });

  describe('OLE compound files', () => {
    const head = fx.ole(['WordDocument']);
    it.each(['old.doc', 'old.ppt', 'old.xls', 'noext'])('%s -> legacy-office-format', async (name) => {
      expect(await sniff(head, name, { oleStreamNames: () => Promise.resolve(['WordDocument']) })).toEqual({
        ok: false,
        code: 'legacy-office-format',
        detail: 'Older Office format; re-save as .pptx, .docx, or .xlsx',
      });
    });
    it('EncryptedPackage stream -> encrypted regardless of extension', async () => {
      const r = await sniff(head, 'x.doc', {
        oleStreamNames: () => Promise.resolve(['EncryptionInfo', 'EncryptedPackage']),
      });
      expect(r).toEqual({ ok: false, code: 'encrypted', detail: 'File is password protected' });
    });
    it.each(['a.pptx', 'a.docx', 'a.xlsx', 'a.pptm', 'a.docm', 'a.xlsm'])(
      'OOXML extension %s on an OLE container -> encrypted',
      async (name) => {
        expect(await sniff(head, name)).toMatchObject({ ok: false, code: 'encrypted' });
      },
    );
  });

  it('AVIF (major or compatible brand without HEVC) -> unsupported-type with export hint', async () => {
    const detail = 'AVIF image; export as PNG or JPEG';
    expect(await sniff(fx.ftyp('avif', ['mif1', 'avif']), 'a.avif')).toEqual({
      ok: false,
      code: 'unsupported-type',
      detail,
    });
    expect(await sniff(fx.ftyp('mif1', ['avif']), 'a.heif')).toEqual({ ok: false, code: 'unsupported-type', detail });
  });

  it('other ftyp brands (e.g. mp4) fall through to binary', async () => {
    const r = await sniff(Buffer.concat([fx.ftyp('isom', ['isom', 'mp42']), Buffer.alloc(16)]), 'clip.mp4');
    expect(r).toEqual({ ok: false, code: 'unsupported-type', detail: 'Unrecognized binary file' });
  });

  it('RTF -> unsupported-type with save hint', async () => {
    expect(await sniff(fx.rtf(), 'memo.rtf')).toEqual({
      ok: false,
      code: 'unsupported-type',
      detail: 'RTF; save as .docx or plain text',
    });
  });

  it('unrecognized binary -> unsupported-type', async () => {
    expect(await sniff(Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe]), 'blob.dat')).toEqual({
      ok: false,
      code: 'unsupported-type',
      detail: 'Unrecognized binary file',
    });
  });
});

describe('sniff(): mismatched extensions (magic bytes win, note recorded)', () => {
  it('.pdf with PNG content resolves as png with the 03 §14 note', async () => {
    expect(await sniff(fx.png(), 'report.pdf')).toEqual({
      ok: true,
      format: 'png',
      mediaType: 'image/png',
      notes: ['extension .pdf but content is PNG'],
    });
  });

  it('.txt with PDF content resolves as pdf with a note', async () => {
    const r = await sniff(fx.pdf(), 'notes.txt');
    expect(r).toMatchObject({ ok: true, format: 'pdf', notes: ['extension .txt but content is PDF'] });
  });

  it('.png with text content resolves as text with a note', async () => {
    const r = await sniff(Buffer.from(fx.TEXT_BODY), 'image.png');
    expect(r).toMatchObject({ ok: true, format: 'text', notes: ['extension .png but content is text'] });
  });

  it('jpg vs jpeg aliases do not produce a note', async () => {
    expect(await sniff(fx.jpeg(), 'a.jpeg')).toMatchObject({ notes: [] });
    expect(await sniff(fx.jpeg(), 'A.JPG')).toMatchObject({ notes: [] });
  });

  it('unknown extensions on binary content add no mismatch note', async () => {
    expect(await sniff(fx.png(), 'shot.data')).toMatchObject({ format: 'png', notes: [] });
  });
});

describe('sniff(): text family (03 §5.2 text probe)', () => {
  const t = Buffer.from(fx.TEXT_BODY);
  it.each([
    ['notes.md', 'markdown'],
    ['notes.markdown', 'markdown'],
    ['notes.mdx', 'markdown'],
    ['page.html', 'html'],
    ['page.htm', 'html'],
    ['page.xhtml', 'html'],
    ['table.csv', 'csv'],
    ['table.tsv', 'csv'],
    ['plain.txt', 'text'],
    ['data.json', 'text'],
    ['conf.yaml', 'text'],
    ['conf.yml', 'text'],
    ['app.log', 'text'],
    ['feed.xml', 'text'],
    ['main.ts', 'text'],
    ['script.py', 'text'],
    ['README', 'text'],
  ] as const)('%s -> %s', async (name, format) => {
    expect(await sniff(t, name)).toMatchObject({ ok: true, format, notes: [] });
  });

  it('unknown extension -> text with "treated as plain text" note', async () => {
    expect(await sniff(t, 'notes.weird')).toMatchObject({
      ok: true,
      format: 'text',
      notes: ['extension .weird treated as plain text'],
    });
  });

  it('text-like extension with an HTML document -> html', async () => {
    expect(await sniff(Buffer.from('<!DOCTYPE html><html><body>x</body></html>'), 'saved.txt')).toMatchObject({
      format: 'html',
    });
    expect(await sniff(Buffer.from('  <html lang="en"><p>x</p></html>'), 'noext')).toMatchObject({ format: 'html' });
  });

  it('declared media type breaks ties only in the text family', async () => {
    expect(await sniff(t, 'download', { declaredMediaType: 'text/markdown; charset=utf-8' })).toMatchObject({
      format: 'markdown',
    });
    expect(await sniff(t, 'export.weird', { declaredMediaType: 'text/csv' })).toMatchObject({
      format: 'csv',
      notes: [],
    });
    expect(await sniff(fx.png(), 'x', { declaredMediaType: 'text/plain' })).toMatchObject({ format: 'png' });
    // Extension beats the declaration where it is decisive.
    expect(await sniff(t, 'notes.md', { declaredMediaType: 'text/html' })).toMatchObject({ format: 'markdown' });
  });

  it('BOM variants: UTF-8, UTF-16 LE, UTF-16 BE', async () => {
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), t]);
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(fx.TEXT_BODY, 'utf16le')]);
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(fx.TEXT_BODY, 'utf16le').swap16()]);
    for (const head of [utf8, le, be]) {
      expect(await sniff(head, 'bom.txt')).toMatchObject({ ok: true, format: 'text', notes: [] });
      expect(textProbe(head).text).toBe(fx.TEXT_BODY);
    }
  });

  it('NUL byte without a UTF-16 BOM fails the probe', async () => {
    expect(await sniff(Buffer.from('abc\0def'), 'a.txt')).toMatchObject({ ok: false, code: 'unsupported-type' });
  });

  it('Windows-1252 bytes: under 2% invalid decodes with a note, over 2% fails', async () => {
    const few = Buffer.concat([Buffer.from('a'.repeat(200)), Buffer.from([0x93]), Buffer.from('b'.repeat(200))]);
    expect(await sniff(few, 'cp1252.txt')).toMatchObject({
      ok: true,
      format: 'text',
      notes: ['contains invalid UTF-8; decoded with replacement characters'],
    });
    const many = Buffer.from(Array.from({ length: 100 }, (_, i) => (i % 5 === 0 ? 0x93 : 0x61)));
    expect(await sniff(many, 'cp1252.txt')).toMatchObject({ ok: false, code: 'unsupported-type' });
  });

  it('countInvalidUtf8 counts bad sequences but not a sequence cut by the head end', () => {
    expect(countInvalidUtf8(Buffer.from('héllo ✓ 𝄞'))).toBe(0);
    expect(countInvalidUtf8(Buffer.from([0xc0, 0xaf]))).toBe(2); // overlong
    expect(countInvalidUtf8(Buffer.from([0xed, 0xa0, 0x80]))).toBe(3); // surrogate: one per byte, as WHATWG decoding does
    expect(countInvalidUtf8(Buffer.from([0x61, 0xe2, 0x9c]))).toBe(0); // truncated tail
  });
});

describe('isImageFormat', () => {
  it('matches IMAGE_FORMATS exactly', () => {
    for (const f of IMAGE_FORMATS) expect(isImageFormat(f)).toBe(true);
    for (const f of ['pdf', 'text', 'pptx', 'html'] as const) expect(isImageFormat(f)).toBe(false);
  });
});
