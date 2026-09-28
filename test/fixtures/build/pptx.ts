/**
 * PowerPoint fixtures (13 §5.1): quarterly-review.pptx and out-of-order.pptx, written as raw OOXML
 * through jszip. Content is synthetic ("Example Widgets Inc.").
 */
import { REL, XML_DECL, contentTypesXml, coreXml, encodePng, esc, relsXml, zipFiles } from './common';

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const IN = 914400;

const CT = {
  pres: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  layout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  master: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  notes: 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
  chart: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
  dgmData: 'application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
};

// ---- shape builders ----

let shapeId = 10;
function nv(name: string, ph?: { type?: string; idx?: number }): string {
  const phXml = ph ? `<p:ph${ph.type ? ` type="${ph.type}"` : ''}${ph.idx !== undefined ? ` idx="${ph.idx}"` : ''}/>` : '';
  return `<p:nvSpPr><p:cNvPr id="${shapeId++}" name="${esc(name)}"/><p:cNvSpPr/><p:nvPr>${phXml}</p:nvPr></p:nvSpPr>`;
}
function xfrm(x: number, y: number, cx = 8 * IN, cy = IN): string {
  return `<p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></p:spPr>`;
}
const run = (t: string): string => `<a:r><a:rPr lang="en-US"/><a:t>${esc(t)}</a:t></a:r>`;

interface Para {
  text?: string;
  raw?: string;
  lvl?: number;
  bullet?: 'char' | 'num' | 'none';
}
function para(p: Para): string {
  const bu = p.bullet === 'char' ? '<a:buChar char="•"/>' : p.bullet === 'num' ? '<a:buAutoNum type="arabicPeriod"/>' : p.bullet === 'none' ? '<a:buNone/>' : '';
  const pPr = p.lvl !== undefined || bu ? `<a:pPr${p.lvl ? ` lvl="${p.lvl}"` : ''}>${bu}</a:pPr>` : '';
  return `<a:p>${pPr}${p.raw ?? (p.text !== undefined ? run(p.text) : '')}</a:p>`;
}
function txBody(paras: Para[]): string {
  return `<p:txBody><a:bodyPr/><a:lstStyle/>${paras.map(para).join('')}</p:txBody>`;
}
function title(text: string, type = 'title'): string {
  // No xfrm: position inherits from the layout placeholder.
  return `<p:sp>${nv('Title', { type })}<p:spPr/>${txBody([{ text }])}</p:sp>`;
}
function body(paras: Para[], idx = 1): string {
  return `<p:sp>${nv('Content', { idx })}<p:spPr/>${txBody(paras)}</p:sp>`;
}
function textBox(name: string, x: number, y: number, paras: Para[]): string {
  return `<p:sp>${nv(name)}${xfrm(x, y)}${txBody(paras)}</p:sp>`;
}
const FOOTER = textBox('Footer', 0.5 * IN, 7 * IN, [{ text: 'Example Widgets Inc. | Internal review draft' }]);
function slideNumber(n: number): string {
  return `<p:sp>${nv('Slide Number', { type: 'sldNum', idx: 12 })}${xfrm(9 * IN, 7 * IN, IN, IN / 2)}${txBody([
    { raw: `<a:fld id="{00000000-0000-0000-0000-00000000000${n % 10}}" type="slidenum"><a:t>${n}</a:t></a:fld>` },
  ])}</p:sp>`;
}
function pic(rid: string, descr: string, x: number, y: number, cx: number, cy: number): string {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${shapeId++}" name="Picture" descr="${esc(descr)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}
function frame(inner: string, uri: string, y: number): string {
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${shapeId++}" name="Frame"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${IN}" y="${y}"/><a:ext cx="${8 * IN}" cy="${3 * IN}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="${uri}">${inner}</a:graphicData></a:graphic></p:graphicFrame>`
  );
}
function slideXml(shapes: string[], opts: { hidden?: boolean } = {}): string {
  return (
    XML_DECL +
    `<p:sld ${NS}${opts.hidden ? ' show="0"' : ''}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    shapes.join('') +
    '</p:spTree></p:cSld></p:sld>'
  );
}
function notesXml(lines: string[], slideNo: number): string {
  return (
    XML_DECL +
    `<p:notes ${NS}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    `<p:sp>${nv('Slide Image', { type: 'sldImg' })}<p:spPr/></p:sp>` +
    `<p:sp>${nv('Notes', { type: 'body', idx: 1 })}<p:spPr/>${txBody(lines.map((text) => ({ text })))}</p:sp>` +
    `<p:sp>${nv('Slide Number', { type: 'sldNum', idx: 5 })}<p:spPr/>${txBody([
      { raw: `<a:fld id="{00000000-0000-0000-0000-000000000001}" type="slidenum"><a:t>${slideNo}</a:t></a:fld>` },
    ])}</p:sp>` +
    '</p:spTree></p:cSld></p:notes>'
  );
}

const LAYOUT =
  XML_DECL +
  `<p:sldLayout ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
  `<p:sp>${nv('Title', { type: 'title' })}${xfrm(0.5 * IN, 0.3 * IN)}${txBody([])}</p:sp>` +
  `<p:sp>${nv('Subtitle', { type: 'subTitle', idx: 1 })}${xfrm(0.5 * IN, 2 * IN)}${txBody([])}</p:sp>` +
  `<p:sp>${nv('Content', { idx: 1 })}${xfrm(0.5 * IN, 1.5 * IN, 9 * IN, 5 * IN)}${txBody([])}</p:sp>` +
  '</p:spTree></p:cSld></p:sldLayout>';
const MASTER =
  XML_DECL +
  `<p:sldMaster ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>` +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';

function chartXml(): string {
  const cats = ['Q1', 'Q2', 'Q3', 'Q4'];
  const vals = ['38', '41', '46', '49'];
  const pts = (xs: string[]): string => xs.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('');
  return (
    XML_DECL +
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Revenue ($M)</a:t></a:r></a:p></c:rich></c:tx></c:title>' +
    '<c:plotArea><c:barChart><c:barDir val="col"/>' +
    '<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>2026</c:v></c:pt></c:strCache></c:strRef></c:tx>' +
    `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$5</c:f><c:strCache><c:ptCount val="4"/>${pts(cats)}</c:strCache></c:strRef></c:cat>` +
    `<c:val><c:numRef><c:f>Sheet1!$B$2:$B$5</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="4"/>${pts(vals)}</c:numCache></c:numRef></c:val>` +
    '</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>'
  );
}

function smartArtData(items: string[]): string {
  return (
    XML_DECL +
    '<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst>' +
    '<dgm:pt modelId="{0}" type="doc"><dgm:prSet/><dgm:spPr/></dgm:pt>' +
    items
      .map((t, i) => `<dgm:pt modelId="{${i + 1}}"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p></dgm:t></dgm:pt>`)
      .join('') +
    '</dgm:ptLst></dgm:dataModel>'
  );
}

function tableXml(): string {
  const cell = (t: string, extra = ''): string =>
    `<a:tc${extra}><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${t ? run(t) : ''}</a:p></a:txBody><a:tcPr/></a:tc>`;
  const row = (cells: string): string => `<a:tr h="370840">${cells}</a:tr>`;
  return (
    '<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid>' +
    row(cell('Region') + cell('Q2') + cell('Q3')) +
    row(cell('NA') + cell('41') + cell('46')) +
    row(cell('EMEA') + cell('30') + cell('33')) +
    row(cell('Total | all regions', ' gridSpan="2"') + cell('', ' hMerge="1"') + cell('79')) +
    '</a:tbl>'
  );
}

interface SlideSpec {
  xml: string;
  rels: Array<{ id: string; type: string; target: string }>;
  notes?: string[];
}

async function buildDeck(opts: {
  title: string;
  slides: Array<{ file: string; spec: SlideSpec }>;
  order: string[];
  extra?: Array<[string, string | Uint8Array]>;
  extraOverrides?: Record<string, string>;
}): Promise<Uint8Array> {
  const files: Array<[string, string | Uint8Array]> = [];
  const overrides: Record<string, string> = {
    '/ppt/presentation.xml': CT.pres,
    '/ppt/slideLayouts/slideLayout1.xml': CT.layout,
    '/ppt/slideMasters/slideMaster1.xml': CT.master,
    '/docProps/core.xml': CT.core,
    ...opts.extraOverrides,
  };
  const presRels = [{ id: 'rIdM', type: REL.slideMaster, target: 'slideMasters/slideMaster1.xml' }];
  opts.order.forEach((file, i) => presRels.push({ id: `rId${i + 1}`, type: REL.slide, target: `slides/${file}` }));
  for (const s of opts.slides) {
    overrides[`/ppt/slides/${s.file}`] = CT.slide;
    const rels = [{ id: 'rIdL', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' }, ...s.spec.rels];
    if (s.spec.notes) {
      const notesFile = s.file.replace('slide', 'notesSlide');
      const n = opts.order.indexOf(s.file) + 1;
      files.push([`ppt/notesSlides/${notesFile}`, notesXml(s.spec.notes, n)]);
      overrides[`/ppt/notesSlides/${notesFile}`] = CT.notes;
      rels.push({ id: 'rIdN', type: REL.notesSlide, target: `../notesSlides/${notesFile}` });
    }
    files.push([`ppt/slides/${s.file}`, s.spec.xml], [`ppt/slides/_rels/${s.file}.rels`, relsXml(rels)]);
  }
  const presentation =
    XML_DECL +
    `<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdM"/></p:sldMasterIdLst><p:sldIdLst>` +
    opts.order.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('') +
    '</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>';
  const head: Array<[string, string | Uint8Array]> = [
    ['[Content_Types].xml', contentTypesXml({ rels: 'application/vnd.openxmlformats-package.relationships+xml', xml: 'application/xml', png: 'image/png' }, overrides)],
    ['_rels/.rels', relsXml([
      { id: 'rId1', type: REL.officeDocument, target: 'ppt/presentation.xml' },
      { id: 'rId2', type: REL.core, target: 'docProps/core.xml' },
    ])],
    ['docProps/core.xml', coreXml(opts.title)],
    ['ppt/presentation.xml', presentation],
    ['ppt/_rels/presentation.xml.rels', relsXml(presRels)],
    ['ppt/slideMasters/slideMaster1.xml', MASTER],
    ['ppt/slideMasters/_rels/slideMaster1.xml.rels', relsXml([{ id: 'rId1', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' }])],
    ['ppt/slideLayouts/slideLayout1.xml', LAYOUT],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', relsXml([{ id: 'rId1', type: REL.slideMaster, target: '../slideMasters/slideMaster1.xml' }])],
  ];
  return zipFiles([...head, ...files, ...(opts.extra ?? [])]);
}

/** A 400×300 "architecture diagram": boxes and connectors in four flat colors. */
export function diagramPng(): Uint8Array {
  return encodePng(400, 300, (x, y) => {
    const box = (x0: number, y0: number): boolean => x >= x0 && x < x0 + 100 && y >= y0 && y < y0 + 60;
    if (box(30, 40) || box(270, 40) || box(150, 200)) return [40, 90, 160];
    if ((y === 70 && x > 130 && x < 270) || (x === 200 && y > 100 && y < 200)) return [30, 30, 30];
    return [245, 245, 245];
  });
}

/** A 32×32 logo: dropped by the §7.3 size and repetition rules. */
function logoPng(): Uint8Array {
  return encodePng(32, 32, (x, y) => ((x + y) % 8 < 4 ? [200, 60, 40] : [255, 255, 255]));
}

export async function buildQuarterlyReview(): Promise<Uint8Array> {
  shapeId = 10;
  const logo = { id: 'rIdLogo', type: REL.image, target: '../media/logo.png' };
  const logoPic = pic('rIdLogo', 'Company logo', 9 * IN, 0.2 * IN, 0.4 * IN, 0.4 * IN);
  const common = (n: number): string[] => [FOOTER, slideNumber(n)];
  const slides: Array<{ file: string; spec: SlideSpec }> = [
    {
      file: 'slide1.xml',
      spec: {
        xml: slideXml([title('Quarterly Review: Q3 2026', 'ctrTitle'), `<p:sp>${nv('Subtitle', { type: 'subTitle', idx: 1 })}<p:spPr/>${txBody([{ text: 'Example Widgets Inc.' }])}</p:sp>`, ...common(1)]),
        rels: [],
        notes: ['Welcome everyone.', 'Keep the opening under two minutes.'],
      },
    },
    {
      file: 'slide2.xml',
      spec: {
        xml: slideXml([title('Agenda'), body([{ text: 'Results' }, { text: 'Revenue bridge' }, { text: 'Outlook' }]), logoPic, ...common(2)]),
        rels: [logo],
      },
    },
    {
      file: 'slide3.xml',
      spec: {
        xml: slideXml([
          title('Revenue bridge'),
          body([
            { text: 'Net revenue up 12% YoY' },
            { text: 'Driven by enterprise renewals', lvl: 1 },
            { text: 'Renewal rate reached 94%', lvl: 2 },
            { text: 'Services revenue flat' },
            { text: 'Hardware margin improved', lvl: 1 },
          ]),
          logoPic,
          ...common(3),
        ]),
        rels: [logo],
        notes: ['Emphasize that churn is flat.', 'Renewals carried the quarter.'],
      },
    },
    {
      file: 'slide4.xml',
      spec: {
        xml: slideXml([
          title('Research spend'),
          textBox('Body', 0.5 * IN, 1.5 * IN, [
            { text: 'R&D <50% of operating expense' },
            { raw: `${run('Revenue ')}<a:r><a:rPr lang="en-US" b="1"/><a:t>grew</a:t></a:r><a:br/>${run('in ')}<a:fld id="{00000000-0000-0000-0000-000000000009}" type="datetime1"><a:t>Q3</a:t></a:fld>${run(' as planned')}` },
          ]),
          logoPic,
          ...common(4),
        ]),
        rels: [logo],
      },
    },
    {
      file: 'slide5.xml',
      spec: {
        xml: slideXml([title('Regional results'), frame(tableXml(), 'http://schemas.openxmlformats.org/drawingml/2006/table', 1.5 * IN), ...common(5)]),
        rels: [],
      },
    },
    {
      file: 'slide6.xml',
      spec: {
        xml: slideXml([
          title('Revenue by quarter'),
          frame('<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdC"/>', 'http://schemas.openxmlformats.org/drawingml/2006/chart', 1.5 * IN),
          ...common(6),
        ]),
        rels: [{ id: 'rIdC', type: REL.chart, target: '../charts/chart1.xml' }],
      },
    },
    {
      file: 'slide7.xml',
      spec: {
        // Right column appears first in the file; reading order must still be left then right.
        xml: slideXml([
          title('Two teams'),
          textBox('Right', 5 * IN, 1.5 * IN, [{ text: 'Platform team: shipped the billing rewrite' }]),
          textBox('Left', 0.5 * IN, 1.6 * IN, [{ text: 'Devices team: cut unit cost by 8%' }]),
          ...common(7),
        ]),
        rels: [],
      },
    },
    {
      file: 'slide8.xml',
      spec: { xml: slideXml([title('Backup: raw survey data'), body([{ text: 'Not for presentation' }]), ...common(8)], { hidden: true }), rels: [] },
    },
    {
      file: 'slide9.xml',
      spec: {
        xml: slideXml([title('Architecture'), pic('rIdD', 'System architecture diagram', IN, 1.5 * IN, 4 * IN, 3 * IN), ...common(9)]),
        rels: [{ id: 'rIdD', type: REL.image, target: '../media/diagram.png' }],
        notes: ['Walk through the three services left to right.'],
      },
    },
    {
      file: 'slide10.xml',
      spec: { xml: slideXml([textBox('Callout', IN, 3 * IN, [{ text: 'Questions welcome at any point' }]), ...common(10)]), rels: [] },
    },
    {
      file: 'slide11.xml',
      spec: {
        xml: slideXml([
          title('Release process'),
          frame('<dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rIdDm" r:lo="rIdLo" r:qs="rIdQs" r:cs="rIdCs"/>', 'http://schemas.openxmlformats.org/drawingml/2006/diagram', 1.5 * IN),
          ...common(11),
        ]),
        rels: [{ id: 'rIdDm', type: REL.diagramData, target: '../diagrams/data1.xml' }],
      },
    },
    {
      file: 'slide12.xml',
      spec: {
        xml: slideXml([
          title('Next steps'),
          textBox('Steps', 0.5 * IN, 1.5 * IN, [
            { text: 'Hire two support engineers', bullet: 'num' },
            { text: 'Close the Q4 books by January 15', bullet: 'num' },
            { text: 'Owner: finance team', bullet: 'none' },
          ]),
          ...common(12),
        ]),
        rels: [],
        notes: ['Ask for volunteers.'],
      },
    },
  ];
  return buildDeck({
    title: 'Quarterly Review Q3 2026',
    slides,
    order: slides.map((s) => s.file),
    extra: [
      ['ppt/media/logo.png', logoPng()],
      ['ppt/media/diagram.png', diagramPng()],
      ['ppt/charts/chart1.xml', chartXml()],
      ['ppt/diagrams/data1.xml', smartArtData(['Plan', 'Build', 'Verify', 'Ship'])],
    ],
    extraOverrides: { '/ppt/charts/chart1.xml': CT.chart, '/ppt/diagrams/data1.xml': CT.dgmData },
  });
}

export async function buildOutOfOrder(): Promise<Uint8Array> {
  shapeId = 10;
  const mk = (t: string, line: string): SlideSpec => ({ xml: slideXml([title(t), body([{ text: line }])]), rels: [] });
  // File names sort as slide1, slide10, slide2; presentation order is slide10, slide2, slide1.
  return buildDeck({
    title: 'PowerPoint Presentation',
    slides: [
      { file: 'slide1.xml', spec: mk('Closing', 'Thanks for reading') },
      { file: 'slide10.xml', spec: { ...mk('Opening', 'Why this deck exists'), notes: ['Notes for the opening slide.'] } },
      { file: 'slide2.xml', spec: mk('Middle', 'The main argument') },
    ],
    order: ['slide10.xml', 'slide2.xml', 'slide1.xml'],
  });
}

/** Deck whose presentation.xml carries an entity-expansion DTD (13 §5.1 hostile). */
export async function buildXmlEntityDeck(): Promise<Uint8Array> {
  const bomb =
    XML_DECL +
    '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">' +
    '<!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">' +
    '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>' +
    `<p:presentation ${NS}><p:sldIdLst/><p:extLst>&lol3;</p:extLst></p:presentation>`;
  return zipFiles([
    ['[Content_Types].xml', contentTypesXml({ rels: 'application/vnd.openxmlformats-package.relationships+xml', xml: 'application/xml' }, { '/ppt/presentation.xml': CT.pres })],
    ['_rels/.rels', relsXml([{ id: 'rId1', type: REL.officeDocument, target: 'ppt/presentation.xml' }])],
    ['ppt/presentation.xml', bomb],
  ]);
}
