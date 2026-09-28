import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobImageBudget, extractSource, planTiles, type SipsConverter } from '../../../../src/main/extract';
import { readImageHeader, sniffImage } from '../../../../src/main/extract/image-header';
import {
  createImageExtractor,
  imageIdGen,
  processEmbeddedImages,
  type EmbeddedCandidate,
} from '../../../../src/main/extract/images';
import { FIXTURES_DIR, fakePng, fakeServices, fixtureSource, testContext } from '../../../contracts/extractor.contract';
import { encodePng } from '../../../fixtures/build/common';
import { encodeGrayJpeg } from '../../../fixtures/build/images';

const read = (rel: string): Uint8Array => new Uint8Array(readFileSync(resolve(FIXTURES_DIR, rel)));

describe('image headers (04 §7.1 step 1)', () => {
  it('reads PNG and JPEG dimensions and the EXIF orientation', () => {
    expect(readImageHeader(read('sources/images/diagram.png'))).toEqual({ kind: 'png', width: 400, height: 300 });
    expect(readImageHeader(read('sources/images/photo.jpg'))).toEqual({
      kind: 'jpeg',
      width: 640,
      height: 480,
      orientation: 6,
    });
    expect(readImageHeader(encodeGrayJpeg(16, 8, () => 128))).toEqual({ kind: 'jpeg', width: 16, height: 8 });
  });

  it('reads GIF, BMP, WebP (VP8, VP8L, VP8X), TIFF and HEIC headers', () => {
    const gif = Buffer.from('GIF89a\x40\x01\xf0\x00\x00\x00\x00\x00', 'latin1');
    expect(readImageHeader(gif)).toMatchObject({ kind: 'gif', width: 320, height: 240 });
    const bmp = Buffer.alloc(30);
    bmp.write('BM', 0, 'ascii');
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(100, 18);
    bmp.writeInt32LE(-50, 22);
    expect(readImageHeader(bmp)).toMatchObject({ kind: 'bmp', width: 100, height: 50 });
    const webp = (chunk: string, body: number[]): Buffer => {
      const b = Buffer.alloc(40);
      b.write('RIFF', 0, 'ascii');
      b.write('WEBP', 8, 'ascii');
      b.write(chunk, 12, 'ascii');
      Buffer.from(body).copy(b, 20);
      return b;
    };
    const vp8 = webp('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]);
    expect(readImageHeader(vp8)).toMatchObject({ kind: 'webp', width: 640, height: 480 });
    // VP8L: signature 0x2f, then width-1 = 639 and height-1 = 479 as 14-bit little-endian fields.
    const bits = 639 | (479 << 14);
    const vp8l = webp('VP8L', [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >> 24) & 255]);
    expect(readImageHeader(vp8l)).toMatchObject({ kind: 'webp', width: 640, height: 480 });
    const vp8x = webp('VP8X', [0, 0, 0, 0, 0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00]);
    expect(readImageHeader(vp8x)).toMatchObject({ kind: 'webp', width: 640, height: 480 });
    const tiff = Buffer.alloc(40);
    tiff.write('II*\0', 0, 'latin1');
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(2, 8);
    tiff.writeUInt16LE(256, 10);
    tiff.writeUInt16LE(3, 12);
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt16LE(800, 18);
    tiff.writeUInt16LE(257, 22);
    tiff.writeUInt16LE(4, 24);
    tiff.writeUInt32LE(1, 26);
    tiff.writeUInt32LE(600, 30);
    expect(readImageHeader(tiff)).toMatchObject({ kind: 'tiff', width: 800, height: 600 });
    const heic = Buffer.alloc(64);
    heic.writeUInt32BE(24, 0);
    heic.write('ftypheic', 4, 'ascii');
    heic.write('ispe', 32, 'ascii');
    heic.writeUInt32BE(4032, 40);
    heic.writeUInt32BE(3024, 44);
    expect(readImageHeader(heic)).toMatchObject({ kind: 'heic', width: 4032, height: 3024 });
  });

  it('recognizes EMF/WMF and rejects unknown bytes', () => {
    const emf = Buffer.alloc(60);
    emf[0] = 1;
    emf.write(' EMF', 40, 'ascii');
    expect(sniffImage(emf)).toBe('emf');
    expect(sniffImage(Buffer.from([0xd7, 0xcd, 0xc6, 0x9a, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('wmf');
    expect(readImageHeader(Buffer.from('plain text, not an image'))).toBeUndefined();
  });
});

describe('standalone images (04 §7)', () => {
  it('refuses a 60+ MP image from its header before any decode', async () => {
    const services = fakeServices();
    const r = await extractSource(
      fixtureSource('sources/hostile/huge-dimensions.png'),
      testContext({ services, normalizeImage: services.normalizeImage }),
    );
    expect(r).toMatchObject({ ok: false, skipped: { code: 'image-too-large', reason: 'Image too large to send' } });
    expect(services.normalizeCalls).toEqual([]);
  });

  it('tiles a 1000×9000 screenshot into at most 6 parts with part labels', async () => {
    const r = await extractSource(fixtureSource('sources/images/screenshot-tall.png'), testContext());
    if (!r.ok) throw new Error(r.skipped.code);
    expect(r.content.images).toHaveLength(6);
    expect(r.content.blocks[0]).toMatchObject({ kind: 'image', origin: 'standalone', alt: 'part 1 of 6' });
    expect(r.content.warnings).toEqual(['Tall image: 1 part past the first 6 not sent']);
    expect(r.content.stats.chars).toBe(0);
    expect(r.content.title).toBeUndefined();
  });

  it('plans tiles of 1.4 × width with 5% overlap', () => {
    expect(planTiles(1000, 7000, 8)).toBeNull();
    const plan = planTiles(1000, 12000, 8)!;
    expect(plan.tiles[0]).toEqual({ y: 0, height: 1400 });
    expect(plan.tiles[1]).toEqual({ y: 1330, height: 1400 });
    expect(plan.tiles).toHaveLength(6);
    expect(plan.dropped).toBeGreaterThan(0);
  });

  it('maps normalizer failures and unreadable headers to skip codes', async () => {
    const tooBig = fakeServices({ normalizeFails: 'image-too-large' });
    const r = await extractSource(
      fixtureSource('sources/images/diagram.png'),
      testContext({ normalizeImage: tooBig.normalizeImage }),
    );
    expect(r).toMatchObject({ ok: false, skipped: { code: 'image-too-large' } });
    const bad = await extractSource(fixtureSource('sources/text/plain.txt', { format: 'png' }), testContext());
    expect(bad).toMatchObject({
      ok: false,
      skipped: { code: 'corrupt', reason: 'File could not be read (damaged or not a valid PNG image)' },
    });
  });

  it('converts HEIC and TIFF through sips before normalizing', async () => {
    const calls: string[] = [];
    const sips: SipsConverter = async (_bytes, ext) => {
      calls.push(ext);
      return encodeGrayJpeg(64, 64, () => 100);
    };
    const heic = Buffer.alloc(64);
    heic.writeUInt32BE(24, 0);
    heic.write('ftypheic', 4, 'ascii');
    heic.write('ispe', 32, 'ascii');
    heic.writeUInt32BE(64, 40);
    heic.writeUInt32BE(64, 44);
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(resolve(tmpdir(), 'eli5-heic-'));
    const path = resolve(dir, 'photo.heic');
    writeFileSync(path, heic);
    const services = fakeServices();
    const r = await extractSource(
      fixtureSource('sources/images/photo.jpg', {
        format: 'heic',
        location: path,
        payload: { kind: 'path', path },
        sizeBytes: 64,
      }),
      testContext({ services, normalizeImage: services.normalizeImage }),
      [createImageExtractor({ sips })],
    );
    expect(calls).toEqual(['heic']);
    expect(services.normalizeCalls).toEqual(['image/jpeg']);
    expect(r.ok).toBe(true);
  });

  it('skips a standalone image that cannot fit the job budget', async () => {
    const budget = new JobImageBudget({ maxImages: 0 });
    const r = await extractSource(fixtureSource('sources/images/diagram.png'), testContext({ imageBudget: budget }));
    expect(r).toEqual({
      ok: false,
      skipped: { ref: 'diagram.png', code: 'image-budget-exceeded', reason: 'Too many images in one job (limit 0)' },
    });
  });
});

describe('job image budget (04 §7.4)', () => {
  it('holds slots for announced standalone images', () => {
    const b = new JobImageBudget({ maxImages: 3, maxTotalBytes: 10_000_000 });
    b.reserveStandalone(2);
    expect(b.tryReserve(100, 'embedded')).toBe(true);
    expect(b.tryReserve(100, 'page-render')).toBe(false);
    expect(b.tryReserve(100, 'standalone')).toBe(true);
    expect(b.tryReserve(100, 'standalone')).toBe(true);
    expect(b.tryReserve(100, 'standalone')).toBe(false);
  });

  it('enforces the byte cap and round-trips through snapshots', () => {
    const b = new JobImageBudget({ maxImages: 20, maxTotalBytes: 1000 });
    expect(b.tryReserve(900, 'embedded')).toBe(true);
    expect(b.tryReserve(200, 'embedded')).toBe(false);
    const copy = JobImageBudget.fromState(b.snapshot());
    expect(copy.tryReserve(100, 'embedded')).toBe(true);
    b.apply(copy.snapshot());
    expect(b.snapshot()).toMatchObject({ usedImages: 2, usedBytes: 1000 });
  });
});

describe('embedded image policy (04 §7.3)', () => {
  const png = (w: number, h: number, seed: number): Uint8Array =>
    encodePng(w, h, (x, y) => [(x * seed) & 255, (y * seed) & 255, seed]);

  it('drops tiny and repeated images, ranks diagram slides first, and caps per source', async () => {
    const logo = png(32, 32, 1);
    const cands: EmbeddedCandidate[] = [
      { key: 'k0', bytes: logo, containerChars: 500 },
      { key: 'k1', bytes: png(300, 300, 2), containerChars: 500, alt: 'photo' },
      { key: 'k2', bytes: png(100, 100, 3), containerChars: 10, alt: 'diagram' },
      { key: 'k3', bytes: png(400, 400, 4), containerChars: 500 },
      { key: 'k4', bytes: png(120, 120, 5), containerChars: 500 },
      { key: 'k5', bytes: png(120, 120, 5), containerChars: 500 },
      { key: 'k6', bytes: png(120, 120, 5), containerChars: 500 },
    ];
    const ctx = testContext({ limits: { ...testContext().limits, embeddedImagesPerSource: 2 } });
    const out = await processEmbeddedImages(cands, ctx, imageIdGen({ sha256: 'abcdef0123', id: 'src-01' }));
    // k0 too small, k4-k6 repeated more than twice; ranking: k2 (diagram slide), then k3 (largest); k1 over the cap.
    expect(out.kept).toBe(2);
    expect(out.blocks.get('k2')?.[0]).toMatchObject({ kind: 'image', alt: 'diagram', imageId: 'abcdef01-img-1' });
    expect(out.blocks.get('k3')?.[0]).toMatchObject({ kind: 'image', imageId: 'abcdef01-img-2' });
    expect(out.blocks.get('k1')).toEqual([{ kind: 'paragraph', text: '[image omitted: photo]' }]);
    expect(out.blocks.get('k0')).toEqual([{ kind: 'paragraph', text: '[image omitted: figure]' }]);
    expect(out.dropped).toBe(5);
  });

  it('omits EMF/WMF with a warning', async () => {
    const emf = Buffer.alloc(60);
    emf[0] = 1;
    emf.write(' EMF', 40, 'ascii');
    const out = await processEmbeddedImages([{ key: 'v', bytes: emf, containerChars: 0 }], testContext(), () => 'x');
    expect(out.warnings).toEqual(['1 embedded vector image (EMF/WMF) omitted']);
  });

  it('uses the fake PNG helper for header-only sizes', () => {
    expect(readImageHeader(fakePng(10, 20))).toEqual({ kind: 'png', width: 10, height: 20 });
  });
});
