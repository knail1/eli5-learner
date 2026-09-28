/**
 * Excel (.xlsx) and CSV/TSV (04 §8.1): SheetJS CE, a simple table dump. Visible sheets only,
 * capped at 10 sheets, 200 rows, 30 columns and 200 characters per cell; values are the formatted
 * display strings. The ZIP is checked (and every entry test-inflated) before SheetJS sees it.
 */
import * as XLSX from 'xlsx';
import type { ResolvedSource } from '../sources';
import { readSourceBytes, readSourceText } from './payload';
import { ExtractError } from './skip';
import { cleanInline, newContent, plural } from './text-util';
import type { ContentBlock, ExtractContext, ExtractResult, Extractor, TableBlock } from './types';
import { SafeZip } from './zip-safety';

const CELL_MAX = 200;
const NUMBERISH = /^[-+(]?\s*[$€£¥]?\s*\d[\d,]*(\.\d+)?\s*%?\)?$|^[-+]?\d+(\.\d+)?[eE][-+]?\d+$/;
const DATEISH =
  /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$|^\d{1,2}[- ](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[- ]\d{2,4}$/i;

function isNumberOrDate(s: string): boolean {
  const t = s.trim();
  return t !== '' && (NUMBERISH.test(t) || DATEISH.test(t));
}

function capCell(s: string): string {
  const t = cleanInline(s);
  return t.length > CELL_MAX ? `${t.slice(0, CELL_MAX - 1)}…` : t;
}

/** Used rectangle: drops empty rows and empty leading/trailing columns (04 §8.1 step 3). */
export function usedRect(rows: string[][]): string[][] {
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!nonEmpty.length) return [];
  let first = Infinity;
  let last = -1;
  for (const r of nonEmpty) {
    r.forEach((c, i) => {
      if (c.trim() !== '') {
        first = Math.min(first, i);
        last = Math.max(last, i);
      }
    });
  }
  return nonEmpty.map((r) => {
    const out = r.slice(first, last + 1);
    while (out.length < last - first + 1) out.push('');
    return out;
  });
}

export interface SheetTable {
  table: TableBlock;
  warnings: string[];
  truncated: boolean;
}

/**
 * Caps and header detection for one sheet (04 §8.1 steps 3-5). `fullRows` is the sheet's full
 * row count when SheetJS stopped early at sheetRows.
 */
export function sheetToTable(
  name: string | undefined,
  raw: string[][],
  limits: { maxRows: number; maxCols: number },
  fullRows?: number,
): SheetTable | undefined {
  const rect = usedRect(raw);
  if (!rect.length) return undefined;
  const warnings: string[] = [];
  const width = rect[0]!.length;
  const droppedCols = Math.max(0, width - limits.maxCols);
  const rows = rect.map((r) => r.slice(0, limits.maxCols).map(capCell));

  const r1 = rows[0]!;
  const r2 = rows[1];
  const hasHeader =
    r1.some((c) => c !== '') && r1.every((c) => c === '' || !isNumberOrDate(c)) && !!r2?.some(isNumberOrDate);
  const header = hasHeader ? r1 : undefined;
  let body = hasHeader ? rows.slice(1) : rows;
  const knownRows = Math.max(fullRows ?? 0, rows.length) - (hasHeader ? 1 : 0);
  let droppedRows = Math.max(0, knownRows - limits.maxRows);
  if (body.length > limits.maxRows) {
    droppedRows = Math.max(droppedRows, body.length - limits.maxRows);
    body = body.slice(0, limits.maxRows);
  }
  const label = name ? `Sheet '${name}'` : 'Table';
  if (droppedRows) warnings.push(`${label} truncated at ${limits.maxRows} rows`);
  if (droppedCols) warnings.push(`${label} truncated at ${limits.maxCols} columns`);
  const table: TableBlock = {
    kind: 'table',
    ...(name ? { caption: name } : {}),
    ...(header ? { header } : {}),
    rows: body,
    ...(droppedRows || droppedCols
      ? { truncated: { ...(droppedRows ? { rows: droppedRows } : {}), ...(droppedCols ? { cols: droppedCols } : {}) } }
      : {}),
  };
  return { table, warnings, truncated: droppedRows > 0 || droppedCols > 0 };
}

function rowsOf(ws: XLSX.WorkSheet): string[][] {
  const json = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, blankrows: false, defval: '' });
  return json.map((r) => (Array.isArray(r) ? r.map((c) => (c === null || c === undefined ? '' : String(c))) : []));
}

function fullRowCount(ws: XLSX.WorkSheet): number | undefined {
  const full = ws['!fullref'];
  if (typeof full !== 'string') return undefined;
  const r = XLSX.utils.decode_range(full);
  return r.e.r - r.s.r + 1;
}

function readWorkbook(data: Uint8Array | string, opts: XLSX.ParsingOptions): XLSX.WorkBook {
  try {
    return XLSX.read(data, opts);
  } catch {
    throw new ExtractError('corrupt', 'sheetjs: parse error');
  }
}

export const xlsxExtractor: Extractor = {
  id: 'xlsx',
  formats: ['xlsx'],
  canHandle: (s) => s.format === 'xlsx',
  async extract(source: ResolvedSource, ctx: ExtractContext): Promise<ExtractResult> {
    const bytes = await readSourceBytes(source);
    SafeZip.open(bytes).verifyAll();
    const { maxSheets, maxRows, maxCols } = ctx.limits.xlsx;
    const wb = readWorkbook(bytes, {
      type: 'array',
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      sheetRows: maxRows + 1,
      dense: true,
    });
    const blocks: ContentBlock[] = [];
    const warnings: string[] = [];
    let truncated = false;
    let hidden = 0;
    let extra = 0;
    let visible = 0;
    for (const [i, name] of wb.SheetNames.entries()) {
      if ((wb.Workbook?.Sheets?.[i]?.Hidden ?? 0) !== 0) {
        hidden++;
        continue;
      }
      if (visible >= maxSheets) {
        extra++;
        continue;
      }
      if (ctx.signal.aborted) break;
      visible++;
      const ws = wb.Sheets[name];
      if (!ws) continue;
      const t = sheetToTable(name, rowsOf(ws), { maxRows, maxCols }, fullRowCount(ws));
      if (!t) continue;
      blocks.push({ kind: 'heading', level: 2, text: cleanInline(name) || `Sheet ${i + 1}` }, t.table);
      warnings.push(...t.warnings);
      truncated ||= t.truncated;
    }
    if (hidden) warnings.push(`${plural(hidden, 'hidden sheet')} skipped`);
    if (extra) {
      warnings.push(`${plural(extra, 'sheet')} past the first ${maxSheets} skipped`);
      truncated = true;
    }
    if (!blocks.length) throw new ExtractError('empty', 'no non-empty cells');
    const content = newContent(source, { blocks, warnings, truncated });
    content.stats.sheets = visible;
    return { ok: true, content };
  },
};

export const csvExtractor: Extractor = {
  id: 'csv',
  formats: ['csv'],
  canHandle: (s) => s.format === 'csv',
  async extract(source: ResolvedSource, ctx: ExtractContext): Promise<ExtractResult> {
    const text = (await readSourceText(source)).replace(/^\uFEFF/, '');
    const isTsv = /\.tsv$/i.test(source.location);
    // raw: true keeps CSV values exactly as written (no date or number re-formatting).
    const wb = readWorkbook(text, {
      type: 'string',
      raw: true,
      dense: true,
      sheetRows: ctx.limits.xlsx.maxRows + 1,
      ...(isTsv ? { FS: '\t' } : {}),
    });
    const name = wb.SheetNames[0];
    const ws = name ? wb.Sheets[name] : undefined;
    const t = ws ? sheetToTable(undefined, rowsOf(ws), ctx.limits.xlsx, fullRowCount(ws)) : undefined;
    if (!t) throw new ExtractError('empty', 'no non-empty cells');
    return {
      ok: true,
      content: newContent(source, { blocks: [t.table], warnings: t.warnings, truncated: t.truncated }),
    };
  },
};
