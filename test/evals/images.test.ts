import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractSource } from '../../src/main/extract';
import { FIXTURES_DIR, fixtureSource, testContext } from '../contracts/extractor.contract';
import { evalImageServices } from './lib/images';
import { EVAL_SOURCES_DIR, buildScannedPdf, buildTextPng } from './lib/sources';

const signal = new AbortController().signal;

/** Width, height and pixel bytes (filter bytes dropped; unfiltered rows) of an 8-bit PNG. */
function pngInfo(png: Uint8Array): { width: number; height: number; pixels: number[] } {
  const b = Buffer.from(png);
  expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const colorType = b[25] ?? -1;
  const idat: Buffer[] = [];
  for (let i = 8; i < b.length;) {
    const len = b.readUInt32BE(i);
    if (b.toString('ascii', i + 4, i + 8) === 'IDAT') idat.push(b.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * (colorType === 2 ? 3 : 1) + 1;
  const pixels: number[] = [];
  for (let y = 0; y < height; y++) {
    expect(raw[y * stride]).toBe(0);
    for (const v of raw.subarray(y * stride + 1, (y + 1) * stride)) pixels.push(v);
  }
  return { width, height, pixels };
}

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'eli5-eval-images-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('eval image services: real pixels reach the vision model (13 §9.3 step 1)', () => {
  it('passes a PNG within the size limit (the images-only case screenshot) through byte for byte', async () => {
    const spec: unknown = JSON.parse(
      readFileSync(path.join(EVAL_SOURCES_DIR, 'security/soc-dashboard.png.json'), 'utf8'),
    );
    const png = buildTextPng(spec as Parameters<typeof buildTextPng>[0]);
    const r = await evalImageServices().normalizeImage(png, 'image/png', { origin: 'standalone', signal });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.assets).toHaveLength(1);
    expect(Buffer.from(r.assets[0]?.data ?? [])).toEqual(Buffer.from(png));
    expect(r.assets[0]).toMatchObject({ mediaType: 'image/png', width: pngInfo(png).width, origin: 'standalone' });
  });

  it('refuses bytes that are not an image, and images above the long-edge limit', async () => {
    const s = evalImageServices();
    await expect(
      s.normalizeImage(new Uint8Array([1, 2, 3]), 'image/png', { origin: 'embedded', signal }),
    ).resolves.toEqual({
      ok: false,
      code: 'corrupt',
    });
    const huge = buildTextPng({ scale: 6, width: 120, lines: ['X'] }); // 124 * 6 * 6 = 4464 px wide
    await expect(s.normalizeImage(huge, 'image/png', { origin: 'embedded', signal })).resolves.toEqual({
      ok: false,
      code: 'image-too-large',
    });
  });

  it('renders the image-only pages of the synthetic PDFs from their embedded page images', async () => {
    const s = evalImageServices();
    const scanned = readFileSync(path.join(FIXTURES_DIR, 'sources/pdf/scanned-3p.pdf'));
    const pages = await s.renderPdfPages(scanned, [1, 3], { targetLongEdgePx: 1568, signal });
    expect(pages.map((p) => p.page)).toEqual([1, 3]);
    for (const p of pages) {
      if (!('png' in p)) throw new Error(`page ${p.page} did not render`);
      const info = pngInfo(p.png);
      expect([info.width, info.height, p.width, p.height]).toEqual([612, 792, 612, 792]);
    }
    const mixed = readFileSync(path.join(FIXTURES_DIR, 'sources/pdf/mixed.pdf'));
    const m = await s.renderPdfPages(mixed, [1, 3], { targetLongEdgePx: 1568, signal });
    expect(m[0]).toEqual({ page: 1, error: expect.stringMatching(/no page image/) });
    expect(m[1]).toMatchObject({ page: 3, width: 612, height: 792 });
  });

  it('extracts a built scanned PDF as pdf-scanned, with the drawn text pages as real images', async () => {
    const pdf = buildScannedPdf({ pages: [{ lines: ['# PAGE ONE', 'RECEIPTS OVER $25'] }, { lines: ['PAGE TWO'] }] });
    const file = path.join(tmp, 'scan.pdf');
    await writeFile(file, pdf);
    const s = evalImageServices();
    const r = await extractSource(
      fixtureSource(file),
      testContext({ renderPdfPages: s.renderPdfPages, normalizeImage: s.normalizeImage }),
    );
    if (!r.ok) throw new Error(`extraction skipped: ${r.skipped.code}`);
    expect(r.content.format).toBe('pdf-scanned');
    expect(r.content.images).toHaveLength(2);
    for (const img of r.content.images) {
      const info = pngInfo(img.data);
      expect(Math.max(info.width, info.height)).toBeLessThanOrEqual(1568);
      // Dark glyph ink on light paper, not a blank or placeholder page.
      expect(info.pixels.reduce((a, b) => Math.min(a, b), 255)).toBeLessThan(60);
      expect(info.pixels.reduce((a, b) => Math.max(a, b), 0)).toBeGreaterThan(240);
    }
  });
});
