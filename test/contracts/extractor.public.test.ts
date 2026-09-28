/** Public extractors against the Extractor contract suite (13 §10.2). */
import { createPublicExtractors, type Extractor } from '../../src/main/extract';
import { describeExtractorContract, type ExtractorContractCase } from './extractor.contract';

const CASES: Record<string, string[]> = {
  pptx: ['sources/pptx/quarterly-review.pptx', 'sources/pptx/out-of-order.pptx'],
  docx: ['sources/docx/policy-memo.docx', 'sources/docx/bold-headings.docx', 'sources/docx/localized-headings.docx'],
  pdf: ['sources/pdf/two-column.pdf', 'sources/pdf/scanned-3p.pdf', 'sources/pdf/mixed.pdf'],
  xlsx: ['sources/xlsx/budget.xlsx'],
  csv: ['sources/text/sales.csv'],
  image: ['sources/images/diagram.png', 'sources/images/screenshot-tall.png', 'sources/images/photo.jpg'],
  markdown: ['sources/text/notes.md'],
  html: ['sources/text/article.html'],
  text: ['sources/text/plain.txt', 'sources/text/bom-utf16.txt', 'sources/text/cp1252.txt'],
};

const byId =
  (id: string): (() => Extractor) =>
  () =>
    createPublicExtractors().find((e) => e.id === id)!;

for (const [id, fixtures] of Object.entries(CASES)) {
  const cases: ExtractorContractCase[] = fixtures.map((fixture) => ({
    fixture,
    golden: fixture.replace(/\.[^./]+$/, '.expected.txt'),
  }));
  describeExtractorContract(id, byId(id), cases);
}
