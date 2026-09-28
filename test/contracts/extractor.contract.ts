/**
 * Extractor contract suite (13 §10.2) plus the deterministic fakes it needs: a fake
 * PdfPageRenderer and ImageNormalizer (04 §6.3, §7.1) so extraction runs in Node with no window.
 * Public and private extractors run identical assertions.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ResolvedSource, SourceFormat } from '../../src/main/sources';
import {
  DEFAULT_EXTRACT_LIMITS,
  ExtractedContentSchema,
  JobImageBudget,
  extractSource,
  planTiles,
  toPromptText,
  type ExtractContext,
  type ExtractLimits,
  type Extractor,
  type ImageAsset,
  type ImageNormalizer,
  type PdfPageRenderer,
} from '../../src/main/extract';

export const FIXTURES_DIR = resolve(import.meta.dirname, '../fixtures');

const EXT_FORMAT: Record<string, SourceFormat> = {
  pptx: 'pptx',
  docx: 'docx',
  xlsx: 'xlsx',
  pdf: 'pdf',
  md: 'markdown',
  txt: 'text',
  csv: 'csv',
  tsv: 'csv',
  html: 'html',
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
  bmp: 'bmp',
  heic: 'heic',
  tiff: 'tiff',
};

const MEDIA: Partial<Record<SourceFormat, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
  markdown: 'text/markdown',
  text: 'text/plain',
  csv: 'text/csv',
};

/** A ResolvedSource for a fixture file under test/fixtures/ (path payload, as 03 produces). */
export function fixtureSource(rel: string, over: Partial<ResolvedSource> = {}): ResolvedSource {
  const abs = resolve(FIXTURES_DIR, rel);
  const bytes = readFileSync(abs);
  const ext = rel.split('.').pop()?.toLowerCase() ?? '';
  const format = EXT_FORMAT[ext] ?? 'text';
  const name = rel.split('/').pop() ?? rel;
  return {
    id: 'src-01',
    inputId: 'in-01',
    ref: name,
    location: abs,
    lane: 'local',
    resolverId: 'file',
    format,
    mediaType: MEDIA[format] ?? 'application/octet-stream',
    payload: { kind: 'path', path: abs },
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    notes: [],
    ...over,
  };
}

/** An in-memory text source (clipboard-style payload). */
export function textSource(
  text: string,
  format: SourceFormat = 'text',
  over: Partial<ResolvedSource> = {},
): ResolvedSource {
  return {
    id: 'src-02',
    inputId: 'in-02',
    ref: 'Pasted text',
    location: 'clipboard',
    lane: 'local',
    resolverId: 'clipboard',
    format,
    mediaType: 'text/plain',
    payload: { kind: 'text', text },
    sizeBytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
    notes: [],
    ...over,
  };
}

/** Header-only PNG bytes of a given size (enough for header parsing). */
export function fakePng(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = 2;
  return new Uint8Array(b);
}

function dims(bytes: Uint8Array): { w: number; h: number } | undefined {
  const b = Buffer.from(bytes);
  if (b.length >= 24 && b[0] === 0x89 && b.toString('ascii', 12, 16) === 'IHDR')
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      const m = b[i + 1]!;
      if (m >= 0xc0 && m <= 0xc3) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return undefined;
}

export interface FakeServices {
  renderPdfPages: PdfPageRenderer;
  normalizeImage: ImageNormalizer;
  renderCalls: number[][];
  normalizeCalls: string[];
}

/**
 * Deterministic fakes: the renderer returns a 612:792 PNG header per page (or an error for
 * pages in `failPages`); the normalizer scales to 1568 px, tiles tall images like the real page,
 * and returns 64 bytes derived from the input so ids and goldens are stable.
 */
export function fakeServices(
  opts: { failPages?: number[]; normalizeFails?: 'corrupt' | 'image-too-large' } = {},
): FakeServices {
  const renderCalls: number[][] = [];
  const normalizeCalls: string[] = [];
  const renderPdfPages: PdfPageRenderer = async (_pdf, pages, o) => {
    renderCalls.push([...pages]);
    return pages.map((page) =>
      opts.failPages?.includes(page)
        ? { page, error: 'render failed' }
        : {
            page,
            png: fakePng(Math.round((o.targetLongEdgePx * 612) / 792), o.targetLongEdgePx),
            width: Math.round((o.targetLongEdgePx * 612) / 792),
            height: o.targetLongEdgePx,
          },
    );
  };
  const normalizeImage: ImageNormalizer = async (bytes, mediaType, o) => {
    normalizeCalls.push(mediaType);
    if (opts.normalizeFails) return { ok: false, code: opts.normalizeFails };
    const d = dims(bytes);
    if (!d) return { ok: false, code: 'corrupt' };
    const lim = DEFAULT_EXTRACT_LIMITS.images;
    const tiles = planTiles(d.w, d.h, lim.maxAspect)?.tiles ?? [{ y: 0, height: d.h }];
    const assets: ImageAsset[] = tiles.map((t, i) => {
      const scale = Math.min(1, lim.targetLongEdgePx / Math.max(d.w, t.height));
      const data = new Uint8Array(createHash('sha512').update(bytes).update(String(i)).digest());
      return {
        id: `fake-${i}`,
        mediaType: 'image/png',
        data,
        width: Math.max(1, Math.round(d.w * scale)),
        height: Math.max(1, Math.round(t.height * scale)),
        byteLength: data.byteLength,
        distinctColors: 16,
        origin: o.origin,
      };
    });
    return { ok: true, assets };
  };
  return { renderPdfPages, normalizeImage, renderCalls, normalizeCalls };
}

export function testContext(
  over: Partial<ExtractContext> & { services?: FakeServices; limits?: ExtractLimits } = {},
): ExtractContext & { logs: string[]; services: FakeServices } {
  const services = over.services ?? fakeServices();
  const logs: string[] = [];
  return {
    signal: new AbortController().signal,
    limits: DEFAULT_EXTRACT_LIMITS,
    imageBudget: new JobImageBudget(),
    renderPdfPages: services.renderPdfPages,
    normalizeImage: services.normalizeImage,
    log: (m) => logs.push(m),
    ...over,
    logs,
    services,
  };
}

/** Normalizes a golden for comparison: files end with one newline, output does not. */
export function goldenText(out: string): string {
  return `${out}\n`;
}

export interface ExtractorContractCase {
  /** Relative to test/fixtures/. */
  fixture: string;
  /** Relative to test/fixtures/; compared byte for byte with toPromptText output. */
  golden?: string;
}

/** 13 §10.2: output validates as ExtractedContent; toPromptText is deterministic; canHandle is pure. */
export function describeExtractorContract(name: string, make: () => Extractor, cases: ExtractorContractCase[]): void {
  describe(`Extractor contract: ${name}`, () => {
    it('has a stable id and declares formats', () => {
      const e = make();
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
      expect(e.formats.length).toBeGreaterThan(0);
    });

    for (const c of cases) {
      it(`${c.fixture}: canHandle is pure and synchronous`, () => {
        const e = make();
        const src = fixtureSource(c.fixture);
        const first = e.canHandle(src);
        expect(first).toBe(true);
        expect(e.canHandle(src)).toBe(first);
        expect(e.canHandle({ ...src, format: e.formats.includes('text') ? 'pptx' : 'text' })).toBe(false);
      });

      it(`${c.fixture}: output validates and serializes deterministically`, async () => {
        const run = async (): Promise<string> => {
          const r = await extractSource(fixtureSource(c.fixture), testContext(), [make()]);
          if (!r.ok) throw new Error(`skipped: ${r.skipped.code}`);
          ExtractedContentSchema.parse(r.content);
          return toPromptText(r.content);
        };
        const a = await run();
        const b = await run();
        expect(b).toBe(a);
        if (c.golden) expect(goldenText(a)).toBe(readFileSync(resolve(FIXTURES_DIR, c.golden), 'utf8'));
      });
    }
  });
}
