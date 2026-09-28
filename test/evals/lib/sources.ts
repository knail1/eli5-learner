/**
 * Eval case sources (13 §9.2): maps each case source to a pipeline SourceInput.
 *
 * - `sources/<path>`: a committed fixture under test/fixtures/ (13 §5.1), as a dropped file.
 * - `sites/<name>/`: a fixture site served by the local fixture server (13 §6.4), as a URL.
 * - `evals/sites/<name>.html`: an eval-owned page, served at `/evals/<name>/`, as a URL.
 * - `evals/<path>.docx.json` / `.xlsx.json` / `.png.json`: a spec built at run time into the work dir
 *   (like 13 §5.3's generated-at-test-time fixtures), as a dropped file named without `.json`.
 * - `evals/<path>`: any other eval-owned file under test/evals/sources/, as a dropped file.
 *
 * Everything is synthetic; builders are deterministic.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import type { SourceInput } from '../../../src/preload/contract';
import {
  FIXED_DATE,
  REL,
  XML_DECL,
  contentTypesXml,
  coreXml,
  encodePng,
  esc,
  relsXml,
  zipFiles,
} from '../../fixtures/build/common';
import type { FixtureServer } from '../../helpers/fixture-server';
import { GLYPH_H, GLYPH_W, glyph } from './font';

export const FIXTURES_DIR = path.resolve(import.meta.dirname, '../../fixtures');
export const EVAL_SOURCES_DIR = path.resolve(import.meta.dirname, '../sources');

/** The slice of fixture-server.ts the resolver needs. */
export type SiteServer = Pick<FixtureServer, 'url' | 'route'>;

export type SourceKind = 'fixture-file' | 'fixture-site' | 'eval-site' | 'eval-built' | 'eval-file';

export interface SourceRef {
  kind: SourceKind;
  /** Absolute path of the committed file (or spec) behind the source. */
  file: string;
  /** Built file name, or the served path for sites. */
  name: string;
}

export function classifySource(ref: string): SourceRef {
  if (ref.startsWith('sites/')) {
    const name = ref.slice('sites/'.length).replace(/\/$/, '');
    return { kind: 'fixture-site', file: path.join(FIXTURES_DIR, 'sites', name, 'index.html'), name: `/${name}/` };
  }
  if (ref.startsWith('sources/'))
    return { kind: 'fixture-file', file: path.join(FIXTURES_DIR, ref), name: path.basename(ref) };
  if (ref.startsWith('evals/sites/') && ref.endsWith('.html')) {
    const name = path.basename(ref, '.html');
    return {
      kind: 'eval-site',
      file: path.join(EVAL_SOURCES_DIR, ref.slice('evals/'.length)),
      name: `/evals/${name}/`,
    };
  }
  if (ref.startsWith('evals/')) {
    const file = path.join(EVAL_SOURCES_DIR, ref.slice('evals/'.length));
    if (/\.(docx|xlsx|png)\.json$/.test(ref)) return { kind: 'eval-built', file, name: path.basename(ref, '.json') };
    return { kind: 'eval-file', file, name: path.basename(ref) };
  }
  throw new Error(`source "${ref}" must start with sources/, sites/ or evals/`);
}

// ---- builders ----

const DocxSpec = z
  .object({
    title: z.string(),
    blocks: z.array(
      z.union([
        z.object({ h1: z.string() }).strict(),
        z.object({ h2: z.string() }).strict(),
        z.object({ p: z.string() }).strict(),
        z.object({ li: z.string() }).strict(),
        z.object({ table: z.array(z.array(z.string())).min(1) }).strict(),
      ]),
    ),
  })
  .strict();

const XlsxSpec = z
  .object({
    sheets: z
      .array(z.object({ name: z.string(), rows: z.array(z.array(z.union([z.string(), z.number()]))) }).strict())
      .min(1),
  })
  .strict();

const PngSpec = z
  .object({
    /** Pixel scale of the 5×7 glyphs. */
    scale: z.number().int().min(2).max(6).default(3),
    width: z.number().int().min(20).max(120).default(64),
    lines: z.array(z.string()).min(1),
  })
  .strict();

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DOCX_CT = {
  doc: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  styles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
  numbering: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
};

const run = (t: string): string => `<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const para = (t: string, style?: string, bullet = false): string =>
  `<w:p>${style || bullet ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${bullet ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ''}</w:pPr>` : ''}${run(t)}</w:p>`;
const style = (id: string, name: string, lvl?: number): string =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${lvl !== undefined ? `<w:pPr><w:outlineLvl w:val="${lvl}"/></w:pPr>` : ''}</w:style>`;

/** Minimal WordprocessingML: Title, Heading 1/2, bulleted paragraphs and simple tables. */
export async function buildDocx(spec: z.input<typeof DocxSpec>): Promise<Uint8Array> {
  const s = DocxSpec.parse(spec);
  const body = [
    para(s.title, 'Title'),
    ...s.blocks.map((b) => {
      if ('h1' in b) return para(b.h1, 'Heading1');
      if ('h2' in b) return para(b.h2, 'Heading2');
      if ('li' in b) return para(b.li, 'ListParagraph', true);
      if ('table' in b) {
        const cols = b.table[0]?.length ?? 1;
        return (
          `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="3000"/>'.repeat(cols)}</w:tblGrid>` +
          b.table
            .map(
              (row, i) =>
                `<w:tr>${i === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${row.map((c) => `<w:tc>${para(c)}</w:tc>`).join('')}</w:tr>`,
            )
            .join('') +
          '</w:tbl>'
        );
      }
      return para(b.p);
    }),
  ].join('');
  const styles =
    XML_DECL +
    `<w:styles xmlns:w="${W}">${style('Normal', 'Normal')}${style('Title', 'Title')}${style('Heading1', 'heading 1', 0)}` +
    `${style('Heading2', 'heading 2', 1)}${style('ListParagraph', 'List Paragraph')}</w:styles>`;
  const numbering =
    XML_DECL +
    `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/>` +
    '<w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';
  return zipFiles([
    [
      '[Content_Types].xml',
      contentTypesXml(
        { rels: 'application/vnd.openxmlformats-package.relationships+xml', xml: 'application/xml' },
        {
          '/word/document.xml': DOCX_CT.doc,
          '/word/styles.xml': DOCX_CT.styles,
          '/word/numbering.xml': DOCX_CT.numbering,
          '/docProps/core.xml': DOCX_CT.core,
        },
      ),
    ],
    [
      '_rels/.rels',
      relsXml([
        { id: 'rId1', type: REL.officeDocument, target: 'word/document.xml' },
        { id: 'rId2', type: REL.core, target: 'docProps/core.xml' },
      ]),
    ],
    ['word/document.xml', XML_DECL + `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`],
    [
      'word/_rels/document.xml.rels',
      relsXml([
        { id: 'rIdS', type: REL.styles, target: 'styles.xml' },
        { id: 'rIdN', type: REL.numbering, target: 'numbering.xml' },
      ]),
    ],
    ['word/styles.xml', styles],
    ['word/numbering.xml', numbering],
    ['docProps/core.xml', coreXml(s.title)],
  ]);
}

export async function buildXlsx(spec: z.input<typeof XlsxSpec>): Promise<Uint8Array> {
  const s = XlsxSpec.parse(spec);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Example Widgets Inc.';
  wb.created = FIXED_DATE;
  wb.modified = FIXED_DATE;
  for (const sh of s.sheets) {
    const ws = wb.addWorksheet(sh.name);
    for (const r of sh.rows) ws.addRow(r);
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** Text lines drawn with the 5×7 font; a line starting with "# " is a title band. */
export function buildTextPng(spec: z.input<typeof PngSpec>): Uint8Array {
  const s = PngSpec.parse(spec);
  const cell = GLYPH_W + 1;
  const lineH = GLYPH_H + 4;
  const margin = 2;
  const cols = s.width;
  const width = (cols + margin * 2) * cell * s.scale;
  const height = (s.lines.length + margin) * lineH * s.scale;
  const ink = new Uint8Array(width * height);
  const band = new Set<number>();
  s.lines.forEach((raw, row) => {
    const title = raw.startsWith('# ');
    const text = (title ? raw.slice(2) : raw).slice(0, cols);
    const y0 = (row + 1) * lineH * s.scale;
    if (title) for (let y = y0 - 2 * s.scale; y < y0 + (GLYPH_H + 2) * s.scale; y++) band.add(y);
    [...text].forEach((ch, i) => {
      const g = glyph(ch);
      const x0 = (margin + i) * cell * s.scale;
      for (let gy = 0; gy < GLYPH_H; gy++)
        for (let gx = 0; gx < GLYPH_W; gx++) {
          if (!g[gy]?.[gx]) continue;
          for (let dy = 0; dy < s.scale; dy++)
            for (let dx = 0; dx < s.scale; dx++) ink[(y0 + gy * s.scale + dy) * width + x0 + gx * s.scale + dx] = 1;
        }
    });
  });
  return encodePng(width, height, (x, y) => {
    if (ink[y * width + x]) return band.has(y) ? [255, 255, 255] : [25, 30, 40];
    return band.has(y) ? [30, 70, 140] : [250, 250, 248];
  });
}

async function build(ref: SourceRef): Promise<Uint8Array> {
  const spec: unknown = JSON.parse(readFileSync(ref.file, 'utf8'));
  if (ref.name.endsWith('.docx')) return buildDocx(spec as z.input<typeof DocxSpec>);
  if (ref.name.endsWith('.xlsx')) return buildXlsx(spec as z.input<typeof XlsxSpec>);
  return buildTextPng(spec as z.input<typeof PngSpec>);
}

/** Every committed file behind a case source exists (checked before any spend). */
export function sourceExists(ref: string): boolean {
  return existsSync(classifySource(ref).file);
}

/** Builds and serves what a case needs and returns its pipeline inputs, in case order. */
export async function resolveCaseSources(
  refs: readonly string[],
  o: { workDir: string; server: SiteServer },
): Promise<SourceInput[]> {
  await mkdir(o.workDir, { recursive: true });
  const out: SourceInput[] = [];
  for (const [i, raw] of refs.entries()) {
    const id = `in-${(i + 1).toString(16).padStart(8, '0')}`;
    const ref = classifySource(raw);
    switch (ref.kind) {
      case 'fixture-site':
        out.push({ id, kind: 'url', origin: 'url-field', url: o.server.url(ref.name) });
        break;
      case 'eval-site': {
        const html = readFileSync(ref.file, 'utf8');
        o.server.route(ref.name, (_req, res) =>
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html),
        );
        out.push({ id, kind: 'url', origin: 'url-field', url: o.server.url(ref.name) });
        break;
      }
      case 'eval-built': {
        const p = path.join(o.workDir, ref.name);
        await writeFile(p, await build(ref));
        out.push({ id, kind: 'file', origin: 'drop', path: p });
        break;
      }
      default:
        out.push({ id, kind: 'file', origin: 'drop', path: ref.file });
    }
  }
  return out;
}
