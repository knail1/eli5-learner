/**
 * Spreadsheet fixture (13 §5.1): budget.xlsx via exceljs (dev dependency only). Two visible sheets
 * and one hidden; "Detail" has 250 rows and 35 columns so the 200-row and 30-column caps apply.
 * Currency and date number formats check that display strings come through.
 */
import ExcelJS from 'exceljs';
import { FIXED_DATE } from './common';

export async function buildBudget(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Example Widgets Inc.';
  wb.created = FIXED_DATE;
  wb.modified = FIXED_DATE;

  const summary = wb.addWorksheet('Summary');
  summary.addRow(['Department', 'Budget', 'Review date']);
  const rows: Array<[string, number, Date]> = [
    ['Engineering', 1250000, new Date(Date.UTC(2026, 2, 31))],
    ['Sales', 830000, new Date(Date.UTC(2026, 5, 30))],
    ['Support', 410500.5, new Date(Date.UTC(2026, 8, 30))],
  ];
  for (const r of rows) summary.addRow(r);
  summary.getColumn(2).numFmt = '"$"#,##0.00';
  summary.getColumn(3).numFmt = 'yyyy-mm-dd';
  summary.getCell('B1').numFmt = 'General';
  summary.getCell('C1').numFmt = 'General';

  const detail = wb.addWorksheet('Detail');
  detail.addRow(['Line', ...Array.from({ length: 34 }, (_, i) => `Month ${i + 1}`)]);
  for (let r = 1; r <= 250; r++) {
    detail.addRow([`Item ${r}`, ...Array.from({ length: 34 }, (_, c) => (r * 7 + c * 3) % 100)]);
  }

  const raw = wb.addWorksheet('Raw', { state: 'hidden' });
  raw.addRow(['Hidden export', 'Do not read']);

  return new Uint8Array(await wb.xlsx.writeBuffer());
}
