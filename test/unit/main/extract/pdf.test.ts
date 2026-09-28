import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTRACT_LIMITS,
  JobImageBudget,
  extractSource,
  type ExtractedContent,
  type ExtractLimits,
  type PageBlock,
} from '../../../../src/main/extract';
import { isGarbageText, maxImageCoverage } from '../../../../src/main/extract/pdf';
import { fakeServices, fixtureSource, testContext } from '../../../contracts/extractor.contract';

async function pdf(rel: string, over: Parameters<typeof testContext>[0] = {}): Promise<ExtractedContent> {
  const r = await extractSource(fixtureSource(rel), testContext(over));
  if (!r.ok) throw new Error(`skipped: ${r.skipped.code}`);
  return r.content;
}
const pages = (c: ExtractedContent): PageBlock[] => c.blocks.filter((b): b is PageBlock => b.kind === 'page');
const withPdf = (p: Partial<ExtractLimits['pdf']>): ExtractLimits => ({
  ...DEFAULT_EXTRACT_LIMITS,
  pdf: { ...DEFAULT_EXTRACT_LIMITS.pdf, ...p },
});

describe('pdf extractor (04 §6)', () => {
  it('emits text in page order with PDF page numbers', async () => {
    const c = await pdf('sources/pdf/two-column.pdf');
    expect(pages(c).map((p) => p.number)).toEqual([1, 2, 3]);
    expect(c.stats.pages).toBe(3);
    expect(c.format).toBe('pdf');
    expect(c.title).toBe('Operations Review 2026');
  });

  it('reads two columns column by column, de-hyphenates, and drops running headers/footers', async () => {
    const c = await pdf('sources/pdf/two-column.pdf');
    const p1 = pages(c)[0]!.blocks.map((b) =>
      b.kind === 'paragraph' ? b.text : b.kind === 'heading' ? `#${b.text}` : '',
    );
    expect(p1).toEqual([
      '#Operations Review 2026',
      'Example Widgets Inc. runs two plants that assemble sensors for industrial customers. This review covers the year to date.',
      'The north plant expanded its manufacturing floor by a third and hired forty new technicians.',
      'The south plant focused on quality. Defect rates fell from 1.2% to 0.7% after the new inspection line went live in April.',
      'Shipping volumes grew in every region except one, where a customs delay held orders for two weeks.',
    ]);
    const all = JSON.stringify(c.blocks);
    expect(all).not.toMatch(/Page \d of 3/);
    expect(all).not.toContain('Example Widgets Inc. Operations Review');
    expect(c.warnings).toContain('Removed 6 running header or footer lines');
  });

  it('detects headings by size and nested lists by indentation', async () => {
    const p2 = pages(await pdf('sources/pdf/two-column.pdf'))[1]!;
    expect(p2.blocks[0]).toEqual({ kind: 'heading', level: 2, text: 'Plant metrics' });
    expect(p2.blocks[1]).toEqual({
      kind: 'list',
      ordered: false,
      items: [
        { text: 'Output: 48,000 units' },
        { text: 'Overtime: down 15%', children: [{ text: 'Weekend shifts cut to two' }] },
      ],
    });
  });

  it('routes an image-only PDF to the renderer at 1568 px and reports pdf-scanned', async () => {
    const services = fakeServices();
    const c = await pdf('sources/pdf/scanned-3p.pdf', {
      services,
      renderPdfPages: services.renderPdfPages,
      normalizeImage: services.normalizeImage,
    });
    expect(services.renderCalls).toEqual([[1, 2, 3]]);
    expect(c.format).toBe('pdf-scanned');
    expect(c.stats.scannedPages).toBe(3);
    expect(c.images.map((i) => [i.origin, i.pageOrSlide])).toEqual([
      ['page-render', 1],
      ['page-render', 2],
      ['page-render', 3],
    ]);
    expect(Math.max(c.images[0]!.width, c.images[0]!.height)).toBeLessThanOrEqual(1568);
  });

  it('renders only the image-only pages of a mixed PDF', async () => {
    const services = fakeServices();
    const c = await pdf('sources/pdf/mixed.pdf', {
      services,
      renderPdfPages: services.renderPdfPages,
      normalizeImage: services.normalizeImage,
    });
    expect(services.renderCalls).toEqual([[3]]);
    expect(c.format).toBe('pdf');
    expect(c.stats.scannedPages).toBe(1);
    expect(pages(c)[2]!.blocks).toContainEqual(expect.objectContaining({ kind: 'image', origin: 'page-render' }));
    // A file-name-like info Title is ignored in favour of the first heading.
    expect(c.title).toBe('Supplier agreement summary');
  });

  it('caps rendered pages and marks truncation', async () => {
    const services = fakeServices();
    const c = await pdf('sources/pdf/scanned-3p.pdf', {
      services,
      renderPdfPages: services.renderPdfPages,
      normalizeImage: services.normalizeImage,
      limits: withPdf({ maxRenderedPages: 2 }),
    });
    expect(services.renderCalls).toEqual([[1, 2]]);
    expect(c.truncated).toBe(true);
    expect(c.warnings).toContain('Rendered first 2 of 3 scanned pages');
  });

  it('skips with scan-render-failed when no page renders, and keeps text when some do', async () => {
    const all = fakeServices({ failPages: [1, 2, 3] });
    const r = await extractSource(
      fixtureSource('sources/pdf/scanned-3p.pdf'),
      testContext({ services: all, renderPdfPages: all.renderPdfPages, normalizeImage: all.normalizeImage }),
    );
    expect(r).toMatchObject({
      ok: false,
      skipped: { code: 'scan-render-failed', reason: 'Scanned PDF pages could not be rendered' },
    });
    const some = fakeServices({ failPages: [2] });
    const c = await pdf('sources/pdf/scanned-3p.pdf', {
      services: some,
      renderPdfPages: some.renderPdfPages,
      normalizeImage: some.normalizeImage,
    });
    expect(c.images).toHaveLength(2);
    expect(c.stats.imagesDropped).toBe(1);
  });

  it('skips with scan-render-failed, not a budget reason, when every page fails normalization', async () => {
    const services = fakeServices({ normalizeFails: 'corrupt' });
    const r = await extractSource(
      fixtureSource('sources/pdf/scanned-3p.pdf'),
      testContext({ services, renderPdfPages: services.renderPdfPages, normalizeImage: services.normalizeImage }),
    );
    expect(r).toMatchObject({ ok: false, skipped: { code: 'scan-render-failed' } });
  });

  it('keeps the text pages of a mixed PDF when rendering is interrupted (04 §10.2)', async () => {
    const ac = new AbortController();
    const services = fakeServices();
    const r = await extractSource(
      fixtureSource('sources/pdf/mixed.pdf'),
      testContext({
        services,
        signal: ac.signal,
        normalizeImage: services.normalizeImage,
        renderPdfPages: (_pdf, _pages, o) =>
          new Promise((_resolve, reject) => {
            o.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            ac.abort();
          }),
      }),
    );
    if (!r.ok) throw new Error(r.skipped.code);
    expect(r.content.truncated).toBe(true);
    expect(r.content.warnings).toContain('Stopped after 2 of 3 pages (timeout)');
    expect(
      pages(r.content)
        .map((p) => p.number)
        .slice(0, 2),
    ).toEqual([1, 2]);
    expect(r.content.images).toEqual([]);
  });

  it('keeps page renders within the job image budget', async () => {
    const budget = new JobImageBudget({ maxImages: 1 });
    const c = await pdf('sources/pdf/scanned-3p.pdf', { imageBudget: budget });
    expect(c.images).toHaveLength(1);
    expect(c.warnings).toContain('2 scanned pages not sent: job image budget reached');
  });

  it('skips user-password PDFs as encrypted', async () => {
    const r = await extractSource(fixtureSource('sources/pdf/encrypted.pdf'), testContext());
    expect(r).toEqual({
      ok: false,
      skipped: { ref: 'encrypted.pdf', code: 'encrypted', reason: 'File is password protected' },
    });
  });

  it('reads at most maxPages pages', async () => {
    const c = await pdf('sources/pdf/two-column.pdf', { limits: withPdf({ maxPages: 2 }) });
    expect(pages(c).map((p) => p.number)).toEqual([1, 2]);
    expect(c.truncated).toBe(true);
    expect(c.warnings).toContain('Read the first 2 of 3 pages');
  });

  it('treats damaged bytes as corrupt', async () => {
    const r = await extractSource(fixtureSource('sources/text/plain.txt', { format: 'pdf' }), testContext());
    expect(r).toMatchObject({
      ok: false,
      skipped: { code: 'corrupt', reason: 'File could not be read (damaged or not a valid PDF)' },
    });
  });

  it('measures image coverage through the transform matrix', () => {
    const OPS = {
      save: 10,
      restore: 11,
      transform: 12,
      paintImageXObject: 85,
      paintFormXObjectBegin: 74,
      paintFormXObjectEnd: 75,
    };
    const full = { fnArray: [10, 12, 85, 11], argsArray: [null, [612, 0, 0, 792, 0, 0], ['img'], null] };
    expect(maxImageCoverage(full, OPS, 612 * 792)).toBeCloseTo(1);
    const small = { fnArray: [10, 12, 85, 11], argsArray: [null, [100, 0, 0, 100, 50, 50], ['img'], null] };
    expect(maxImageCoverage(small, OPS, 612 * 792)).toBeLessThan(0.05);
    const nested = {
      fnArray: [12, 74, 85, 75],
      argsArray: [[2, 0, 0, 2, 0, 0], [[153, 0, 0, 198, 0, 0]], ['img'], null],
    };
    expect(maxImageCoverage(nested, OPS, 612 * 792)).toBeCloseTo(0.25);
  });

  it('flags Private Use Area or replacement-character text as garbage', () => {
    expect(isGarbageText(' ab')).toBe(true);
    expect(isGarbageText('Normal text �')).toBe(false);
    expect(isGarbageText('')).toBe(false);
  });
});
