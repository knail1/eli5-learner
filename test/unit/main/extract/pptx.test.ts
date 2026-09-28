import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EXTRACT_LIMITS,
  JobImageBudget,
  extractSource,
  type ExtractedContent,
  type ExtractLimits,
  type SlideBlock,
} from '../../../../src/main/extract';
import { chartTable, readingOrder, removeRepeatedLines } from '../../../../src/main/extract/pptx';
import { SafeZip } from '../../../../src/main/extract/zip-safety';
import { fixtureSource, testContext } from '../../../contracts/extractor.contract';

async function deck(rel: string, over: Parameters<typeof testContext>[0] = {}): Promise<ExtractedContent> {
  const r = await extractSource(fixtureSource(rel), testContext(over));
  if (!r.ok) throw new Error(`skipped: ${r.skipped.code}`);
  return r.content;
}
const slides = (c: ExtractedContent): SlideBlock[] => c.blocks.filter((b): b is SlideBlock => b.kind === 'slide');
const slide = (c: ExtractedContent, index: number): SlideBlock => slides(c).find((s) => s.index === index)!;

describe('pptx extractor (04 §5.1)', () => {
  it('orders slides by sldIdLst, not file name', async () => {
    const c = await deck('sources/pptx/out-of-order.pptx');
    expect(slides(c).map((s) => s.title)).toEqual(['Opening', 'Middle', 'Closing']);
    expect(slides(c).map((s) => s.index)).toEqual([1, 2, 3]);
    // Speaker notes stay with their slide even though the file is slide10.xml.
    expect(slide(c, 1).notes?.text).toBe('Notes for the opening slide.');
    expect(slide(c, 2).notes).toBeUndefined();
    // A default core title falls back to the first slide's title.
    expect(c.title).toBe('Opening');
  });

  it('reads titles, 3-level bullets, notes without slide numbers, and the core title', async () => {
    const c = await deck('sources/pptx/quarterly-review.pptx');
    expect(c.title).toBe('Quarterly Review Q3 2026');
    expect(slide(c, 1).title).toBe('Quarterly Review: Q3 2026');
    const bridge = slide(c, 3);
    const list = bridge.blocks.find((b) => b.kind === 'list');
    expect(list).toEqual({
      kind: 'list',
      ordered: false,
      items: [
        {
          text: 'Net revenue up 12% YoY',
          children: [{ text: 'Driven by enterprise renewals', children: [{ text: 'Renewal rate reached 94%' }] }],
        },
        { text: 'Services revenue flat', children: [{ text: 'Hardware margin improved' }] },
      ],
    });
    expect(bridge.notes?.text).toBe('Emphasize that churn is flat.\nRenewals carried the quarter.');
    expect(bridge.notes?.text).not.toMatch(/\b3\b/);
  });

  it('decodes entities and keeps run, break and field order', async () => {
    const texts = slide(await deck('sources/pptx/quarterly-review.pptx'), 4).blocks.flatMap((b) =>
      b.kind === 'paragraph' ? [b.text] : [],
    );
    expect(texts).toContain('R&D <50% of operating expense');
    expect(texts).toContain('Revenue grew in Q3 as planned');
  });

  it('removes repeated footers and slide-number placeholders, and records it', async () => {
    const c = await deck('sources/pptx/quarterly-review.pptx');
    expect(JSON.stringify(c.blocks)).not.toContain('Internal review draft');
    expect(c.warnings.some((w) => /repeated footer line/.test(w))).toBe(true);
  });

  it('inflates media shared across slides once (04 §10.3 running total)', async () => {
    const read = vi.spyOn(SafeZip.prototype, 'read');
    try {
      await deck('sources/pptx/quarterly-review.pptx');
      const media = read.mock.calls.map(([name]) => name).filter((n) => n.startsWith('ppt/media/'));
      expect(media.length).toBeGreaterThan(0);
      expect(new Set(media).size).toBe(media.length);
    } finally {
      read.mockRestore();
    }
  });

  it('turns tables, charts and SmartArt into blocks', async () => {
    const c = await deck('sources/pptx/quarterly-review.pptx');
    expect(slide(c, 5).blocks[0]).toEqual({
      kind: 'table',
      header: ['Region', 'Q2', 'Q3'],
      rows: [
        ['NA', '41', '46'],
        ['EMEA', '30', '33'],
        ['Total | all regions', '', '79'],
      ],
    });
    expect(slide(c, 6).blocks[0]).toMatchObject({
      kind: 'table',
      caption: 'Chart: Revenue ($M)',
      header: ['Category', '2026'],
    });
    expect(slide(c, 11).blocks[0]).toMatchObject({
      kind: 'list',
      items: [{ text: 'Plan' }, { text: 'Build' }, { text: 'Verify' }, { text: 'Ship' }],
    });
  });

  it('reads two columns left then right, and numbered lists', async () => {
    const c = await deck('sources/pptx/quarterly-review.pptx');
    expect(slide(c, 7).blocks.map((b) => (b.kind === 'paragraph' ? b.text : ''))).toEqual([
      'Devices team: cut unit cost by 8%',
      'Platform team: shipped the billing rewrite',
    ]);
    expect(slide(c, 12).blocks[0]).toMatchObject({ kind: 'list', ordered: true });
  });

  it('skips hidden slides by default and counts untitled slides', async () => {
    const c = await deck('sources/pptx/quarterly-review.pptx');
    expect(slides(c).map((s) => s.index)).not.toContain(8);
    expect(c.warnings).toContain('1 hidden slide skipped');
    expect(c.warnings).toContain('1 slide had no title');
    expect(slide(c, 10).title).toBeUndefined();
    const limits: ExtractLimits = { ...DEFAULT_EXTRACT_LIMITS, pptx: { maxSlides: 300, includeHidden: true } };
    const withHidden = await deck('sources/pptx/quarterly-review.pptx', { limits });
    expect(slide(withHidden, 8)).toMatchObject({ hidden: true, title: 'Backup: raw survey data' });
  });

  it('keeps the diagram for vision and drops small repeated logos with a placeholder', async () => {
    const c = await deck('sources/pptx/quarterly-review.pptx');
    expect(c.images).toHaveLength(1);
    expect(c.images[0]).toMatchObject({ origin: 'embedded', pageOrSlide: 9 });
    expect(slide(c, 9).blocks[0]).toMatchObject({ kind: 'image', alt: 'System architecture diagram' });
    expect(slide(c, 2).blocks[0]).toEqual({ kind: 'paragraph', text: '[image omitted: Company logo]' });
    expect(c.stats).toMatchObject({ imagesKept: 1, imagesDropped: 3, slides: 11 });
  });

  it('drops embedded images with a warning when the job budget is spent, without skipping the deck', async () => {
    const budget = new JobImageBudget({ maxImages: 1 });
    expect(budget.tryReserve(10, 'standalone')).toBe(true);
    const c = await deck('sources/pptx/quarterly-review.pptx', { imageBudget: budget });
    expect(c.images).toHaveLength(0);
    expect(slide(c, 9).blocks[0]).toEqual({ kind: 'paragraph', text: '[image omitted: System architecture diagram]' });
    expect(c.warnings.some((w) => /job image budget/.test(w))).toBe(true);
  });

  it('keeps the first maxSlides slides and marks truncation', async () => {
    const limits: ExtractLimits = { ...DEFAULT_EXTRACT_LIMITS, pptx: { maxSlides: 2, includeHidden: false } };
    const c = await deck('sources/pptx/quarterly-review.pptx', { limits });
    expect(slides(c)).toHaveLength(2);
    expect(c.truncated).toBe(true);
    expect(c.warnings).toContain('Kept the first 2 of 12 slides');
  });

  it('refuses entity-expansion XML as corrupt', async () => {
    const r = await extractSource(fixtureSource('sources/hostile/xml-entity.pptx'), testContext());
    expect(r).toMatchObject({ ok: false, skipped: { code: 'corrupt' } });
  });

  it('sorts shapes by row with a half-inch tolerance', () => {
    const IN = 914400;
    const order = readingOrder([
      { order: 0, pos: { x: 5 * IN, y: 1 * IN } },
      { order: 1, pos: { x: 0.5 * IN, y: 1.3 * IN } },
      { order: 2, pos: { x: 0.5 * IN, y: 3 * IN } },
      { order: 3 },
    ]);
    expect(order.map((s) => s.order)).toEqual([1, 0, 2, 3]);
  });

  it('removes lines on more than 60% of slides and at least 3', () => {
    const mk = (i: number, lines: string[]): SlideBlock => ({
      kind: 'slide',
      index: i,
      blocks: lines.map((text) => ({ kind: 'paragraph' as const, text })),
    });
    const s = [mk(1, ['a', 'foot']), mk(2, ['b', 'foot']), mk(3, ['c', 'foot']), mk(4, ['d'])];
    expect(removeRepeatedLines(s)).toBe(3);
    expect(s.map((x) => x.blocks.length)).toEqual([1, 1, 1, 1]);
    const two = [mk(1, ['foot']), mk(2, ['foot'])];
    expect(removeRepeatedLines(two)).toBe(0);
  });

  it('builds chart tables from cached values only', () => {
    const t = chartTable(
      '<c:chartSpace xmlns:c="c"><c:chart><c:plotArea><c:lineChart><c:ser><c:tx><c:v>Units</c:v></c:tx>' +
        '<c:cat><c:strLit><c:pt idx="0"><c:v>Jan</c:v></c:pt></c:strLit></c:cat>' +
        '<c:val><c:numLit><c:pt idx="0"><c:v>5</c:v></c:pt></c:numLit></c:val></c:ser></c:lineChart></c:plotArea></c:chart></c:chartSpace>',
    );
    expect(t).toEqual({ kind: 'table', caption: 'Chart', header: ['Category', 'Units'], rows: [['Jan', '5']] });
  });

  it('fails with timeout when aborted before any slide', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await extractSource(fixtureSource('sources/pptx/out-of-order.pptx'), testContext({ signal: ac.signal }));
    expect(r).toMatchObject({ ok: false, skipped: { code: 'timeout' } });
  });
});
