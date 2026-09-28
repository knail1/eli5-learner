/**
 * Catalog of the extraction fixtures (13 §5.1, §5.2): where each file lives, which generator
 * builds it (absent = hand-written), and what extraction must produce. The manifest's entries for
 * these files are derived from this list plus the committed bytes' sha256.
 */
import { buildBoldHeadings, buildLocalizedHeadings, buildPolicyMemo, buildTableImage } from './docx';
import {
  lyingSizes,
  zipBombDeclaredTotal,
  zipBombDeclaredXml,
  zipBombEntries,
  buildXmlEntityDeck,
  xmlEntityWorkbook,
} from './hostile';
import { diagramPng, hugeHeaderPng, photoJpg, screenshotTallPng } from './images';
import { buildEncrypted, buildMixed, buildScanned3p, buildTwoColumn } from './pdf';
import { buildOutOfOrder, buildQuarterlyReview } from './pptx';
import { bomUtf16, cp1252 } from './text';
import { buildBudget } from './xlsx';

export type FixtureFormat =
  | 'pptx'
  | 'docx'
  | 'pdf'
  | 'pdf-scanned'
  | 'xlsx'
  | 'image'
  | 'md'
  | 'txt'
  | 'html'
  | 'unsupported'
  | 'hostile';

export interface FixtureSpec {
  /** Relative to test/fixtures/. */
  path: string;
  format: FixtureFormat;
  generator?: string;
  build?: () => Uint8Array | Promise<Uint8Array>;
  expect: { kind: 'extract' | 'skip'; skipCode?: string; imageCount?: number };
}

/** `sources/pptx/quarterly-review.pptx` -> `sources/pptx/quarterly-review.expected.txt`. */
export function goldenPathFor(path: string): string {
  return path.replace(/\.[^./]+$/, '.expected.txt');
}

const g = (name: string): string => `test/fixtures/build/${name}.ts`;

export const EXTRACT_FIXTURES: readonly FixtureSpec[] = [
  { path: 'sources/pptx/quarterly-review.pptx', format: 'pptx', generator: g('pptx'), build: buildQuarterlyReview, expect: { kind: 'extract', imageCount: 1 } },
  { path: 'sources/pptx/out-of-order.pptx', format: 'pptx', generator: g('pptx'), build: buildOutOfOrder, expect: { kind: 'extract', imageCount: 0 } },
  { path: 'sources/docx/policy-memo.docx', format: 'docx', generator: g('docx'), build: buildPolicyMemo, expect: { kind: 'extract', imageCount: 1 } },
  { path: 'sources/docx/bold-headings.docx', format: 'docx', generator: g('docx'), build: buildBoldHeadings, expect: { kind: 'extract', imageCount: 0 } },
  { path: 'sources/docx/localized-headings.docx', format: 'docx', generator: g('docx'), build: buildLocalizedHeadings, expect: { kind: 'extract', imageCount: 0 } },
  { path: 'sources/docx/table-image.docx', format: 'docx', generator: g('docx'), build: buildTableImage, expect: { kind: 'extract', imageCount: 2 } },
  { path: 'sources/pdf/two-column.pdf', format: 'pdf', generator: g('pdf'), build: buildTwoColumn, expect: { kind: 'extract', imageCount: 0 } },
  { path: 'sources/pdf/scanned-3p.pdf', format: 'pdf-scanned', generator: g('pdf'), build: buildScanned3p, expect: { kind: 'extract', imageCount: 3 } },
  { path: 'sources/pdf/mixed.pdf', format: 'pdf', generator: g('pdf'), build: buildMixed, expect: { kind: 'extract', imageCount: 1 } },
  { path: 'sources/pdf/encrypted.pdf', format: 'pdf', generator: g('pdf'), build: buildEncrypted, expect: { kind: 'skip', skipCode: 'encrypted' } },
  { path: 'sources/xlsx/budget.xlsx', format: 'xlsx', generator: g('xlsx'), build: buildBudget, expect: { kind: 'extract', imageCount: 0 } },
  { path: 'sources/images/diagram.png', format: 'image', generator: g('images'), build: diagramPng, expect: { kind: 'extract', imageCount: 1 } },
  { path: 'sources/images/screenshot-tall.png', format: 'image', generator: g('images'), build: screenshotTallPng, expect: { kind: 'extract', imageCount: 6 } },
  { path: 'sources/images/photo.jpg', format: 'image', generator: g('images'), build: photoJpg, expect: { kind: 'extract', imageCount: 1 } },
  { path: 'sources/text/notes.md', format: 'md', expect: { kind: 'extract' } },
  { path: 'sources/text/plain.txt', format: 'txt', expect: { kind: 'extract' } },
  { path: 'sources/text/sales.csv', format: 'txt', expect: { kind: 'extract' } },
  { path: 'sources/text/article.html', format: 'html', expect: { kind: 'extract' } },
  { path: 'sources/text/bom-utf16.txt', format: 'txt', generator: g('text'), build: bomUtf16, expect: { kind: 'extract' } },
  { path: 'sources/text/empty.txt', format: 'txt', expect: { kind: 'skip', skipCode: 'empty' } },
  { path: 'sources/text/cp1252.txt', format: 'txt', generator: g('text'), build: cp1252, expect: { kind: 'extract' } },
  { path: 'sources/hostile/zip-bomb-entries.pptx', format: 'hostile', generator: g('hostile'), build: zipBombEntries, expect: { kind: 'skip', skipCode: 'zip-bomb' } },
  { path: 'sources/hostile/declared-xml-size.pptx', format: 'hostile', generator: g('hostile'), build: zipBombDeclaredXml, expect: { kind: 'skip', skipCode: 'zip-bomb' } },
  { path: 'sources/hostile/declared-total-size.docx', format: 'hostile', generator: g('hostile'), build: zipBombDeclaredTotal, expect: { kind: 'skip', skipCode: 'zip-bomb' } },
  { path: 'sources/hostile/lying-sizes.docx', format: 'hostile', generator: g('hostile'), build: lyingSizes, expect: { kind: 'skip', skipCode: 'zip-bomb' } },
  { path: 'sources/hostile/xml-entity.pptx', format: 'hostile', generator: g('hostile'), build: buildXmlEntityDeck, expect: { kind: 'skip', skipCode: 'corrupt' } },
  { path: 'sources/hostile/xml-entity.xlsx', format: 'hostile', generator: g('hostile'), build: xmlEntityWorkbook, expect: { kind: 'skip', skipCode: 'corrupt' } },
  { path: 'sources/hostile/huge-dimensions.png', format: 'hostile', generator: g('images'), build: hugeHeaderPng, expect: { kind: 'skip', skipCode: 'image-too-large' } },
];
