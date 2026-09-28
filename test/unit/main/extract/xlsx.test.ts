import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTRACT_LIMITS,
  extractSource,
  type ExtractedContent,
  type ExtractLimits,
  type TableBlock,
} from '../../../../src/main/extract';
import { sheetToTable, usedRect } from '../../../../src/main/extract/xlsx';
import { fixtureSource, testContext, textSource } from '../../../contracts/extractor.contract';

async function run(src: ReturnType<typeof fixtureSource>, limits?: ExtractLimits): Promise<ExtractedContent> {
  const r = await extractSource(src, testContext(limits ? { limits } : {}));
  if (!r.ok) throw new Error(`skipped: ${r.skipped.code}`);
  return r.content;
}
const tables = (c: ExtractedContent): TableBlock[] => c.blocks.filter((b): b is TableBlock => b.kind === 'table');

describe('xlsx and csv (04 §8.1)', () => {
  it('reads visible sheets only, as formatted display strings', async () => {
    const c = await run(fixtureSource('sources/xlsx/budget.xlsx'));
    expect(tables(c).map((t) => t.caption)).toEqual(['Summary', 'Detail']);
    expect(c.stats.sheets).toBe(2);
    expect(c.warnings).toContain('1 hidden sheet skipped');
    expect(JSON.stringify(c.blocks)).not.toContain('Hidden export');
    expect(tables(c)[0]).toEqual({
      kind: 'table',
      caption: 'Summary',
      header: ['Department', 'Budget', 'Review date'],
      rows: [
        ['Engineering', '$1,250,000.00', '2026-03-31'],
        ['Sales', '$830,000.00', '2026-06-30'],
        ['Support', '$410,500.50', '2026-09-30'],
      ],
    });
  });

  it('applies the 200-row and 30-column caps and reports them', async () => {
    const c = await run(fixtureSource('sources/xlsx/budget.xlsx'));
    const detail = tables(c)[1]!;
    expect(detail.header).toHaveLength(30);
    expect(detail.rows).toHaveLength(200);
    expect(detail.truncated).toEqual({ rows: 50, cols: 5 });
    expect(c.truncated).toBe(true);
    expect(c.warnings).toEqual(
      expect.arrayContaining(["Sheet 'Detail' truncated at 200 rows", "Sheet 'Detail' truncated at 30 columns"]),
    );
  });

  it('caps the number of sheets', async () => {
    const limits: ExtractLimits = { ...DEFAULT_EXTRACT_LIMITS, xlsx: { maxSheets: 1, maxRows: 200, maxCols: 30 } };
    const c = await run(fixtureSource('sources/xlsx/budget.xlsx'), limits);
    expect(tables(c).map((t) => t.caption)).toEqual(['Summary']);
    expect(c.warnings).toContain('1 sheet past the first 1 skipped');
  });

  it('parses CSV through the same path, keeping values as written', async () => {
    const c = await run(fixtureSource('sources/text/sales.csv'));
    expect(tables(c)[0]).toEqual({
      kind: 'table',
      header: ['Region', 'Q1', 'Q2', 'Q3'],
      rows: [
        ['North', '1,200', '1350', '1410'],
        ['South', '980', '1020', '1100'],
        ['West', '450', '470', '500'],
      ],
    });
  });

  it('uses a tab delimiter for .tsv', async () => {
    const src = textSource('a\tb\n1\t2\n', 'csv', { location: '/tmp/data.tsv' });
    const c = await run(src);
    expect(tables(c)[0]).toMatchObject({ header: ['a', 'b'], rows: [['1', '2']] });
  });

  it('skips a CSV with no cells as empty', async () => {
    const r = await extractSource(textSource(' \n\n', 'csv', { location: '/tmp/e.csv' }), testContext());
    expect(r).toMatchObject({ ok: false, skipped: { code: 'empty', reason: 'No readable content found' } });
  });

  it('detects the used rectangle and headers conservatively', () => {
    expect(
      usedRect([
        ['', '', ''],
        ['', 'a', ''],
        ['', '', 'b'],
      ]),
    ).toEqual([
      ['a', ''],
      ['', 'b'],
    ]);
    const noHeader = sheetToTable(
      'S',
      [
        ['1', '2'],
        ['3', '4'],
      ],
      { maxRows: 10, maxCols: 10 },
    );
    expect(noHeader?.table.header).toBeUndefined();
    const textOnly = sheetToTable(
      'S',
      [
        ['Name', 'Team'],
        ['Ana', 'Ops'],
      ],
      { maxRows: 10, maxCols: 10 },
    );
    expect(textOnly?.table.header).toBeUndefined();
    const long = sheetToTable(undefined, [['x'.repeat(300)]], { maxRows: 10, maxCols: 10 });
    expect(long?.table.rows[0]?.[0]).toHaveLength(200);
    expect(long?.table.rows[0]?.[0]?.endsWith('…')).toBe(true);
  });
});
