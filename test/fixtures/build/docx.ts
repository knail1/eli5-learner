/**
 * Word fixtures (13 §5.1): policy-memo.docx (headings h1-h3, nested lists, two tables, a caption,
 * a footnote, a text box, an image), bold-headings.docx (no heading styles), and
 * localized-headings.docx (heading styles named in German, French and Japanese that carry
 * w:outlineLvl). Raw WordprocessingML through jszip; synthetic content only.
 */
import { REL, XML_DECL, contentTypesXml, coreXml, esc, relsXml, zipFiles } from './common';
import { diagramPng } from './pptx';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS =
  `xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml"';

const CT = {
  doc: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  styles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
  numbering: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
  footnotes: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
};

const r = (t: string, bold = false): string =>
  `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
function p(text: string, opts: { style?: string; bold?: boolean; num?: [number, number]; extra?: string } = {}): string {
  const pPr =
    opts.style || opts.num
      ? `<w:pPr>${opts.style ? `<w:pStyle w:val="${opts.style}"/>` : ''}${
          opts.num ? `<w:numPr><w:ilvl w:val="${opts.num[1]}"/><w:numId w:val="${opts.num[0]}"/></w:numPr>` : ''
        }</w:pPr>`
      : '';
  return `<w:p>${pPr}${text ? r(text, opts.bold) : ''}${opts.extra ?? ''}</w:p>`;
}
function tc(content: string): string {
  return `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${content}</w:tc>`;
}
function table(rows: string[][], headerRow: boolean, nested?: { row: number; col: number; xml: string }): string {
  return (
    '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>' +
    (rows[0] ?? []).map(() => '<w:gridCol w:w="3000"/>').join('') +
    '</w:tblGrid>' +
    rows
      .map(
        (row, i) =>
          `<w:tr>${i === 0 && headerRow ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${row
            .map((c, j) => tc(p(c) + (nested && nested.row === i && nested.col === j ? nested.xml + p('') : '')))
            .join('')}</w:tr>`,
      )
      .join('') +
    '</w:tbl>'
  );
}

function styleXml(id: string, name: string, opts: { lvl?: number; basedOn?: string } = {}): string {
  return (
    `<w:style w:type="paragraph" w:styleId="${esc(id)}"><w:name w:val="${esc(name)}"/>` +
    (opts.basedOn ? `<w:basedOn w:val="${esc(opts.basedOn)}"/>` : '') +
    (opts.lvl !== undefined ? `<w:pPr><w:outlineLvl w:val="${opts.lvl}"/></w:pPr>` : '') +
    '</w:style>'
  );
}
function stylesXml(styles: string[]): string {
  return XML_DECL + `<w:styles xmlns:w="${W}">${styleXml('Normal', 'Normal')}${styles.join('')}</w:styles>`;
}

const NUMBERING =
  XML_DECL +
  `<w:numbering xmlns:w="${W}">` +
  '<w:abstractNum w:abstractNumId="0">' +
  ['•', 'o', '▪']
    .map((t, i) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${t}"/></w:lvl>`)
    .join('') +
  '</w:abstractNum><w:abstractNum w:abstractNumId="1">' +
  [0, 1]
    .map((i) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${i + 1}."/></w:lvl>`)
    .join('') +
  '</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>';

const FOOTNOTES =
  XML_DECL +
  `<w:footnotes xmlns:w="${W}">` +
  '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
  '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
  `<w:footnote w:id="1"><w:p>${r('Contractors follow their own agreement.')}</w:p></w:footnote>` +
  '</w:footnotes>';

function imageRun(rid: string, descr: string): string {
  const cx = 3657600;
  const cy = 2743200;
  return (
    `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="Picture 1" descr="${esc(descr)}"/>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
    `<pic:nvPicPr><pic:cNvPr id="0" name="diagram.png" descr="${esc(descr)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
  );
}

function textBoxRun(text: string): string {
  return `<w:r><w:pict><v:shape style="width:200pt;height:40pt"><v:textbox><w:txbxContent>${p(text)}</w:txbxContent></v:textbox></v:shape></w:pict></w:r>`;
}

async function buildDocx(opts: {
  title?: string;
  body: string;
  styles: string;
  numbering?: boolean;
  footnotes?: boolean;
  media?: Array<[string, Uint8Array]>;
}): Promise<Uint8Array> {
  const docRels = [{ id: 'rIdS', type: REL.styles, target: 'styles.xml' }];
  const overrides: Record<string, string> = { '/word/document.xml': CT.doc, '/word/styles.xml': CT.styles };
  const files: Array<[string, string | Uint8Array]> = [];
  if (opts.numbering) {
    docRels.push({ id: 'rIdN', type: REL.numbering, target: 'numbering.xml' });
    overrides['/word/numbering.xml'] = CT.numbering;
    files.push(['word/numbering.xml', NUMBERING]);
  }
  if (opts.footnotes) {
    docRels.push({ id: 'rIdF', type: REL.footnotes, target: 'footnotes.xml' });
    overrides['/word/footnotes.xml'] = CT.footnotes;
    files.push(['word/footnotes.xml', FOOTNOTES]);
  }
  for (const [name, bytes] of opts.media ?? []) {
    docRels.push({ id: `rId_${name.replace(/\W/g, '')}`, type: REL.image, target: `media/${name}` });
    files.push([`word/media/${name}`, bytes]);
  }
  const rootRels = [{ id: 'rId1', type: REL.officeDocument, target: 'word/document.xml' }];
  if (opts.title) {
    rootRels.push({ id: 'rId2', type: REL.core, target: 'docProps/core.xml' });
    overrides['/docProps/core.xml'] = CT.core;
    files.push(['docProps/core.xml', coreXml(opts.title)]);
  }
  const document = XML_DECL + `<w:document ${NS}><w:body>${opts.body}<w:sectPr/></w:body></w:document>`;
  return zipFiles([
    ['[Content_Types].xml', contentTypesXml({ rels: 'application/vnd.openxmlformats-package.relationships+xml', xml: 'application/xml', png: 'image/png' }, overrides)],
    ['_rels/.rels', relsXml(rootRels)],
    ['word/document.xml', document],
    ['word/_rels/document.xml.rels', relsXml(docRels)],
    ['word/styles.xml', opts.styles],
    ...files,
  ]);
}

const HEADING_STYLES = [
  styleXml('Title', 'Title'),
  styleXml('Heading1', 'heading 1', { lvl: 0 }),
  styleXml('Heading2', 'heading 2', { lvl: 1 }),
  styleXml('Heading3', 'heading 3', { lvl: 2 }),
  styleXml('Caption', 'Caption'),
  styleXml('ListParagraph', 'List Paragraph'),
  styleXml('Quote', 'Quote'),
];

export async function buildPolicyMemo(): Promise<Uint8Array> {
  const nested = table(
    [
      ['Tier', 'Days'],
      ['A', '3'],
    ],
    false,
  );
  const body = [
    p('Remote Work Policy', { style: 'Title' }),
    p('Purpose', { style: 'Heading1' }),
    p('This memo sets out how Example Widgets Inc. supports remote work for its 120 staff.'),
    p('Scope', { style: 'Heading2' }),
    p('The policy covers all full-time employees.', {
      extra: '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>',
    }),
    p('Eligible roles include:'),
    p('Engineering', { style: 'ListParagraph', num: [1, 0] }),
    p('Platform services', { style: 'ListParagraph', num: [1, 1] }),
    p('On-call rotation excluded', { style: 'ListParagraph', num: [1, 2] }),
    p('Finance', { style: 'ListParagraph', num: [1, 0] }),
    p('Approval steps', { style: 'Heading2' }),
    p('Submit a request form', { style: 'ListParagraph', num: [2, 0] }),
    p('Manager signs off within five days', { style: 'ListParagraph', num: [2, 0] }),
    p('Escalations go to the operations lead', { style: 'ListParagraph', num: [2, 1] }),
    p('Equipment', { style: 'Heading3' }),
    p('Table 1: Equipment allowance', { style: 'Caption' }),
    table(
      [
        ['Item', 'Allowance'],
        ['Laptop', '$1,500'],
        ['Monitor', '$300'],
      ],
      true,
    ),
    p('Office days per tier are listed below.'),
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>` +
      `<w:tr>${tc(p('Team'))}${tc(p('Office days'))}</w:tr>` +
      `<w:tr>${tc(p('Support'))}${tc(p('See tiers:') + nested + p(''))}</w:tr></w:tbl>`,
    p('Architecture overview', { style: 'Heading2' }),
    p('', { extra: imageRun('rId_diagrampng', 'Office network diagram') }),
    p('', { extra: textBoxRun('Contact IT for exceptions') }),
    p('Remote work is a privilege, not a right.', { style: 'Quote' }),
  ].join('');
  return buildDocx({
    title: 'Remote Work Policy',
    body,
    styles: stylesXml(HEADING_STYLES),
    numbering: true,
    footnotes: true,
    media: [['diagram.png', diagramPng()]],
  });
}

export async function buildBoldHeadings(): Promise<Uint8Array> {
  const body = [
    p('Background', { bold: true }),
    p('Example Widgets Inc. opened a second warehouse in March.'),
    p('Findings', { bold: true }),
    p('Pick rates rose 9% after the layout change.'),
    p('Shipping errors fell to 0.4% of orders.'),
    p('Next steps', { bold: true }),
    p('Roll the layout out to the first warehouse by June.'),
  ].join('');
  return buildDocx({ body, styles: stylesXml([]) });
}

export async function buildLocalizedHeadings(): Promise<Uint8Array> {
  const styles = [
    styleXml('berschrift1', 'Überschrift 1', { lvl: 0 }),
    styleXml('TitreBase', 'Titre base', { lvl: 1 }),
    styleXml('Titre2', 'Titre 2', { basedOn: 'TitreBase' }),
    styleXml('Midashi3', '見出し 3', { lvl: 2 }),
    styleXml('Hinweis', 'Hinweis', { basedOn: 'Normal' }),
  ];
  const body = [
    p('Jahresbericht', { style: 'berschrift1' }),
    p('Der Umsatz stieg um 7 Prozent.'),
    p('Résultats', { style: 'Titre2' }),
    p('Les marges sont stables.'),
    p('概要', { style: 'Midashi3' }),
    p('売上は増加しました。'),
    p('Nur ein Hinweis, keine Überschrift.', { style: 'Hinweis' }),
  ].join('');
  return buildDocx({ body, styles: stylesXml(styles) });
}

/**
 * table-image.docx: a picture inside a table cell, and one inside a bold pseudo-heading that the
 * §5.2 fallback promotes. Both must end up as ImageBlocks (04 §2 invariant 1).
 */
export async function buildTableImage(): Promise<Uint8Array> {
  const body = [
    p('Floor plan', { bold: true, extra: imageRun('rId_diagrampng', 'Warehouse floor plan') }),
    p('Example Widgets Inc. moved packing next to the loading dock.'),
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>` +
      `<w:tr>${tc(p('Zone'))}${tc(p('Layout'))}</w:tr>` +
      `<w:tr>${tc(p('Packing'))}${tc(p('', { extra: imageRun('rId_diagrampng', 'Packing zone layout') }))}</w:tr></w:tbl>`,
    p('Pick rates are reviewed monthly.'),
  ].join('');
  return buildDocx({ body, styles: stylesXml([]), media: [['diagram.png', diagramPng()]] });
}
