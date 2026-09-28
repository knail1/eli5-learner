import { describe, expect, it } from 'vitest';
import { LIMITS } from '../../../../src/main/fetch/constants';
import {
  decodeBody,
  declaredCap,
  effectiveMime,
  filenameFor,
  headerMime,
  MIME,
  routeMime,
  sanitizeFilename,
  sniffBytes,
} from '../../../../src/main/fetch/route';

const bytes = (...xs: Array<number | string>): Uint8Array =>
  Uint8Array.from(xs.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x])));

describe('sniffing (05 §4.6)', () => {
  it.each([
    [bytes('%PDF-1.7'), 'x', MIME.pdf],
    [bytes(0x89, 0x50, 0x4e, 0x47, 0x0d), 'x', MIME.png],
    [bytes(0xff, 0xd8, 0xff, 0xe0), 'x', MIME.jpeg],
    [bytes('GIF89a'), 'x', MIME.gif],
    [bytes('GIF87a'), 'x', MIME.gif],
    [bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 '), 'x', MIME.webp],
    [bytes(0x50, 0x4b, 3, 4), '/deck.pptx', MIME.pptx],
    [bytes(0x50, 0x4b, 3, 4), 'Plan.DOCX', MIME.docx],
    [bytes(0x50, 0x4b, 3, 4), 'budget.xlsx', MIME.xlsx],
    [bytes(0x50, 0x4b, 3, 4), 'archive.bin', null],
    [bytes(0xef, 0xbb, 0xbf, '  \n<!DOCTYPE html><html>'), 'x', MIME.html],
    [bytes('<HTML><body>'), 'x', MIME.html],
    [bytes('hello'), 'x', null],
  ])('%#', (b, hint, want) => expect(sniffBytes(b, hint)).toBe(want));

  it('sniffs when the header is missing or octet-stream, or contradicts PDF/image magic', () => {
    const pdf = bytes('%PDF-1.4');
    expect(effectiveMime('', pdf, 'x')).toBe(MIME.pdf);
    expect(effectiveMime('application/octet-stream', pdf, 'x')).toBe(MIME.pdf);
    expect(effectiveMime('binary/octet-stream', pdf, 'x')).toBe(MIME.pdf);
    expect(effectiveMime('text/html', pdf, 'x')).toBe(MIME.pdf);
    expect(effectiveMime('text/plain', bytes('plain'), 'x')).toBe('text/plain');
    expect(effectiveMime('application/zip', bytes(0x50, 0x4b, 3, 4), 'a.docx')).toBe(MIME.docx);
  });

  it('strips parameters and lowercases the header', () => {
    expect(headerMime('Text/HTML; charset=UTF-8')).toBe('text/html');
    expect(headerMime(undefined)).toBe('');
  });
});

describe('routing table and caps (05 §4.5, §4.6)', () => {
  it('routes each family with the right cap', () => {
    expect(routeMime('text/html')).toEqual({ lane: 'html' });
    expect(routeMime('application/xhtml+xml')).toEqual({ lane: 'html' });
    expect(routeMime(MIME.pdf)).toMatchObject({ lane: 'binary', capBytes: LIMITS.MAX_DOCUMENT_BYTES });
    expect(routeMime(MIME.pptx)).toMatchObject({ lane: 'binary', capBytes: LIMITS.MAX_DOCUMENT_BYTES });
    expect(routeMime(MIME.webp)).toMatchObject({ lane: 'binary', capBytes: LIMITS.MAX_IMAGE_BYTES });
    expect(routeMime('text/markdown')).toMatchObject({ lane: 'binary', capBytes: LIMITS.MAX_TEXT_BYTES });
    expect(routeMime('application/json')).toMatchObject({ lane: 'binary' });
    expect(routeMime('text/csv')).toMatchObject({ lane: 'binary' });
    expect(routeMime(MIME.svg)).toEqual({ lane: 'svg', capBytes: LIMITS.MAX_SVG_BYTES });
    for (const m of ['video/mp4', 'audio/mpeg', 'application/zip', 'application/xml', 'application/x-msdownload']) {
      expect(routeMime(m)).toEqual({ lane: 'unsupported', mime: m });
    }
    expect(routeMime('')).toEqual({ lane: 'unsupported', mime: 'unknown' });
  });

  it('pre-checks Content-Length for binaries and unknown types, never for HTML', () => {
    expect(declaredCap('text/html')).toBeNull();
    expect(declaredCap('application/pdf')).toBe(LIMITS.MAX_DOCUMENT_BYTES);
    expect(declaredCap('application/octet-stream')).toBe(LIMITS.MAX_DOCUMENT_BYTES);
    expect(declaredCap('image/png')).toBe(LIMITS.MAX_IMAGE_BYTES);
    expect(declaredCap('video/mp4')).toBeNull();
  });
});

describe('filenames (05 §4.6)', () => {
  it('prefers filename*, then filename, then the URL path, then download.<ext>', () => {
    expect(filenameFor("attachment; filename*=UTF-8''Caf%C3%A9%20menu.pdf", 'https://x.example/a', MIME.pdf)).toBe(
      'Café menu.pdf',
    );
    expect(filenameFor('attachment; filename="Plan.docx"', 'https://x.example/a', MIME.docx)).toBe('Plan.docx');
    expect(filenameFor(undefined, 'https://x.example/files/Report%202026.pdf?dl=1', MIME.pdf)).toBe('Report 2026.pdf');
    expect(filenameFor(undefined, 'https://x.example/', MIME.png)).toBe('download.png');
    expect(filenameFor(undefined, 'https://x.example/img/chart', MIME.png)).toBe('chart.png');
  });

  it('removes separators and control characters and caps the length at 120', () => {
    expect(sanitizeFilename('../../etc/pa\u0000ss\nwd.txt')).toBe('etcpasswd.txt');
    const long = sanitizeFilename('a'.repeat(300) + '.pdf');
    expect(long.length).toBe(120);
    expect(long.endsWith('.pdf')).toBe(true);
  });
});

describe('charset decoding (05 §4.7)', () => {
  const latin1 = (s: string) => Uint8Array.from(Buffer.from(s, 'latin1'));

  it('BOM wins over everything', () => {
    const utf16 = Uint8Array.from([0xff, 0xfe, ...Buffer.from('hé', 'utf16le')]);
    expect(decodeBody(utf16, 'text/html; charset=iso-8859-1')).toBe('hé');
  });

  it('then the Content-Type charset, then meta charset in the first 1024 bytes, then UTF-8', () => {
    expect(decodeBody(latin1('café'), 'text/plain; charset=ISO-8859-1', false)).toBe('café');
    expect(decodeBody(latin1('<meta charset="windows-1252"><p>café</p>'), 'text/html')).toContain('café');
    expect(
      decodeBody(latin1('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">é'), 'text/html'),
    ).toContain('é');
    expect(decodeBody(Uint8Array.from(Buffer.from('café', 'utf8')), undefined)).toBe('café');
  });

  it('unknown labels fall back to windows-1252', () => {
    expect(decodeBody(latin1('é'), 'text/html; charset=x-made-up')).toBe('é');
  });
});
