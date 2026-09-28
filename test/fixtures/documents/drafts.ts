/**
 * Synthetic drafts for the golden documents (13 §5, §7). Every DraftBlock variant and every chart
 * kind appears at least once. Images are generated in memory (no binary files in the repo).
 */
import { deflateSync } from 'node:zlib';
import type { BuildInput, DocTheme } from '../../../src/main/document';
import { defaultDocTheme } from '../../../src/main/document';
import type { DocumentDraftTab, GlossaryDraft } from '../../../src/main/llm';
import type { ResolvedSource, SkippedSource } from '../../../src/main/sources';
import { SeededIdSource } from '../../helpers/ids';

export const FIXTURE_NOW = '2026-09-27T12:00:00.000Z';
export const FIXTURE_DOC_ID = '6f1c2b8e-3d4a-4b5c-9e7f-0a1b2c3d4e5f';

// ---------------------------------------------------------------------------
// Tiny PNG encoder (RGB or RGBA), for figure fixtures
// ---------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A w×h PNG with a diagonal two-color pattern. */
export function makePng(w: number, h: number, alpha = false): Uint8Array {
  const bpp = alpha ? 4 : 3;
  const raw = new Uint8Array((w * bpp + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * bpp + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * bpp + 1) + 1 + x * bpp;
      const on = (x + y) % 16 < 8;
      raw[o] = on ? 31 : 240;
      raw[o + 1] = on ? 111 : 236;
      raw[o + 2] = on ? 178 : 228;
      if (alpha) raw[o + 3] = 255;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, alpha ? 6 : 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function src(p: Partial<ResolvedSource> & Pick<ResolvedSource, 'resolverId' | 'location' | 'ref'>): ResolvedSource {
  return {
    id: 'src-00',
    inputId: 'in-1',
    lane: 'local',
    format: 'pdf',
    mediaType: 'application/pdf',
    payload: { kind: 'path', path: '/tmp/x' },
    sizeBytes: 2048,
    sha256: '0'.repeat(64),
    notes: [],
    ...p,
  };
}

export const RESOLVED: ResolvedSource[] = [
  src({
    resolverId: 'file',
    ref: 'widget-sales-q3.pptx',
    location: '/Users/example/Documents/widget-sales-q3.pptx',
    format: 'pptx',
    sizeBytes: 2 * 1024 * 1024,
  }),
  src({
    resolverId: 'url',
    lane: 'web',
    ref: 'https://www.example.com/widgets/pricing',
    location: 'https://www.example.com/widgets/pricing',
    format: 'html',
    title: 'Example Widgets Inc. pricing',
  }),
  src({
    resolverId: 'clipboard',
    ref: 'Pasted text: notes',
    location: 'clipboard',
    format: 'text',
    payload: { kind: 'text', text: 'Quarterly notes from the widget team about channel mix.' },
  }),
];

export const SKIPPED: SkippedSource[] = [
  { ref: 'https://portal.example.com/login', reason: 'Page required login.', code: 'login-required' },
  {
    ref: '/Users/example/Documents/old-forecast.numbers',
    reason: 'File type is not supported.',
    code: 'unsupported-type',
  },
];

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

const DIAGRAM_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120" class="gl-note">' +
  '<script>alert(1)</script>' +
  '<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>' +
  '<rect x="10" y="30" width="110" height="60" rx="8" fill="#1f6fb2" onclick="steal()"/>' +
  '<text x="65" y="65" text-anchor="middle" fill="#ffffff">Order</text>' +
  '<line x1="120" y1="60" x2="200" y2="60" stroke="var(--ink)" stroke-width="2" marker-end="url(#arrow)"/>' +
  '<rect x="200" y="30" width="110" height="60" rx="8" fill="rgb(46,139,87)" style="fill:red"/>' +
  '<text x="255" y="65" text-anchor="middle" fill="white">Ship</text>' +
  '<foreignObject x="0" y="0" width="10" height="10"><div>x</div></foreignObject>' +
  '<image href="https://tracker.example.com/pixel.png" x="0" y="0" width="1" height="1"/>' +
  '</svg>';

export const INDEPTH_DRAFT: DocumentDraftTab = {
  kind: 'indepth',
  title: 'How Example Widgets Inc. decides where to spend on ads',
  dek: 'Return on ad spend (ROAS) drives the budget, and paid search wins most quarters.',
  sections: [
    {
      heading: 'Why ad spend is judged by ROAS',
      blocks: [
        {
          type: 'paragraph',
          md: 'Example Widgets Inc. judges every channel by **ROAS**, the revenue earned for each dollar spent. A channel with a ROAS of 4 returns *four dollars* for every dollar. See [the pricing page](https://www.example.com/widgets/pricing).',
        },
        { type: 'paragraph', md: 'Would you like me to add a forecast for next quarter?' },
        {
          type: 'list',
          ordered: false,
          items: [
            'Paid search: intent is high, so conversion is strong',
            'Social: cheap reach, weaker **conversion**',
            'Email: tiny cost, `utm` tagged',
          ],
        },
        {
          type: 'pullquote',
          text: 'We stopped asking what a click costs and started asking what it returns.',
          attribution: 'Marketing lead',
        },
        {
          type: 'callout',
          tone: 'keypoint',
          md: 'A ROAS below 1 means the channel **loses money** before any other cost.',
        },
        {
          type: 'chart',
          chart: {
            kind: 'bar',
            title: 'Paid search returns the most per dollar',
            subtitle: 'ROAS by channel, Q3',
            source: 'Company sales deck',
            categories: ['Paid search', 'Social', 'Email', 'Display', 'Affiliate'],
            series: [{ name: 'ROAS', values: [4.2, 1.8, 3.1, 0.9, null] }],
            highlight: { category: 'Paid search', note: 'Highest return' },
          },
        },
      ],
    },
    {
      heading: '2. How the budget moved',
      blocks: [
        {
          type: 'paragraph',
          md: 'Budget shifted toward search over the year, while display was cut. ROAS stayed the north star.',
        },
        {
          type: 'chart',
          chart: {
            kind: 'line',
            title: 'Search took a growing share of spend',
            subtitle: 'Monthly spend, USD',
            unit: '$',
            categories: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
            series: [
              { name: 'Search', values: [12000, 13500, 15000, null, 17500, 19000] },
              { name: 'Display', values: [9000, 8500, 8000, 7200, 6400, 5000] },
            ],
          },
        },
        {
          type: 'chart',
          chart: {
            kind: 'area',
            title: 'Email revenue grew steadily',
            categories: ['Q1', 'Q2', 'Q3', 'Q4'],
            series: [{ name: 'Email revenue', values: [120000, 150000, 175000, 230000] }],
            unit: '$',
          },
        },
        {
          type: 'chart',
          chart: {
            kind: 'stacked-bar',
            title: 'Most revenue still comes from repeat buyers',
            categories: ['Q1', 'Q2', 'Q3'],
            series: [
              { name: 'New buyers', values: [40, 45, 52] },
              { name: 'Repeat buyers', values: [60, 62, 70] },
            ],
          },
        },
        {
          type: 'chart',
          chart: {
            kind: 'pie',
            title: 'Search is the biggest line in the budget',
            unit: '%',
            categories: ['Search', 'Social', 'Email', 'Display'],
            series: [{ name: 'Share', values: [45, 25, 10, 20] }],
          },
        },
        {
          type: 'chart',
          chart: {
            kind: 'scatter',
            title: 'Higher spend did not always mean higher return',
            xLabel: 'Spend (thousands)',
            yLabel: 'ROAS',
            categories: ['5', '10', '15', '20', '25'],
            series: [{ name: 'Campaigns', values: [4.5, 3.9, 3.2, 2.8, 2.9] }],
          },
        },
        {
          type: 'table',
          caption: 'Q3 channel results',
          header: ['Channel', 'Spend', 'Revenue', 'ROAS'],
          rows: [
            ['Paid search', '$19,000', '$79,800', '4.2'],
            ['Social', '$8,000', '$14,400', '1.8'],
            ['Email', '$1,200'],
          ],
        },
      ],
    },
    {
      heading: 'How an order flows',
      blocks: [
        {
          type: 'diagram',
          title: 'Order to shipment',
          svg: DIAGRAM_SVG,
          alt: 'An order box with an arrow to a ship box',
        },
        {
          type: 'stepper',
          title: 'From click to delivery',
          steps: [
            { label: 'Click', md: 'A shopper clicks a search ad.' },
            { label: 'Buy', md: 'They buy a widget; revenue is attributed to search.' },
            { label: 'Ship', md: 'The warehouse ships within **two days**.' },
          ],
        },
        {
          type: 'stepper',
          title: 'Single step',
          steps: [{ label: 'Only', md: 'A stepper with one step becomes a list.' }],
        },
        {
          type: 'figure',
          imageLabel: 'Image 1',
          caption: 'The Q3 channel dashboard',
          annotations: [
            { x: 0.2, y: 0.3, text: 'Search spend' },
            { x: 0.7, y: 0.6, text: 'Display cut' },
          ],
        },
        { type: 'figure', imageLabel: 'Image 9', caption: 'Missing image is dropped' },
        { type: 'analogy', md: 'ROAS is like a vending machine that tells you how many snacks each coin buys.' },
        {
          type: 'callout',
          tone: 'warning',
          md: 'Attribution windows change ROAS. <script>alert(1)</script> is shown as text.',
        },
        { type: 'callout', tone: 'note', md: 'Figures are illustrative.' },
      ],
    },
    { heading: 'Dropped section', blocks: [{ type: 'paragraph', md: 'Do you want me to go on?' }] },
  ],
};

export const ELI5_DRAFT: DocumentDraftTab = {
  kind: 'eli5',
  title: 'Ads, explained simply',
  sections: [
    {
      heading: 'Money in, money out',
      blocks: [
        {
          type: 'paragraph',
          md: 'A company pays for ads. Some ads bring back lots of money, and some bring back only a little.',
        },
        { type: 'analogy', md: 'It is like planting seeds: some seeds grow big plants, some grow tiny ones.' },
      ],
    },
    {
      heading: 'Picking the best ads',
      blocks: [{ type: 'paragraph', md: 'The company keeps the ads that bring back the most money, like search ads.' }],
    },
  ],
};

export const GLOSSARY_DRAFT: GlossaryDraft = {
  entries: [
    {
      term: 'ROAS',
      expansion: 'return on ad spend',
      explanation: 'Revenue earned for each dollar spent on ads. A ROAS of 4 means $4 back per $1 spent.',
      anchorSectionIndex: 1,
      anchorText: 'ROAS',
    },
    {
      term: 'conversion',
      explanation: 'When a visitor becomes a buyer.',
      anchorSectionIndex: 0,
      anchorText: 'Conversion',
    },
    {
      term: 'utm',
      explanation: 'Tracking tags; only in code here, so not anchorable.',
      anchorSectionIndex: 0,
      anchorText: 'utm',
    },
    { term: 'roas', explanation: 'Duplicate term, dropped.', anchorSectionIndex: 0, anchorText: 'ROAS' },
    {
      term: 'Attribution window',
      explanation: 'How long after a click a sale still counts for the ad.',
      anchorSectionIndex: 2,
      anchorText: 'attribution   windows',
    },
    { term: 'Out of range', explanation: 'Dropped.', anchorSectionIndex: 9, anchorText: 'x' },
  ],
};

export type FixtureName = 'full' | 'placeholder' | 'themed';
export const FIXTURE_NAMES: readonly FixtureName[] = ['full', 'placeholder', 'themed'];

export const THEMED: DocTheme = {
  id: 'example-theme',
  version: '2',
  tokens: { '--accent': '#8a1c7c', '--font-serif': '"Iowan Old Style", Georgia, serif' },
  footer: 'Example footer label',
  logoSvg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" role="img" aria-label="Logo"><circle cx="10" cy="10" r="8" class="viz-fill-1"/></svg>',
};

/** BuildInput for a named fixture, with a fresh SeededIdSource (13 §3.2). */
export function fixtureInput(name: FixtureName, seed = 7): BuildInput {
  const base: BuildInput = {
    docId: FIXTURE_DOC_ID,
    slug: 'example-widgets-ad-spend',
    now: FIXTURE_NOW,
    indepth: INDEPTH_DRAFT,
    eli5: ELI5_DRAFT,
    glossary: GLOSSARY_DRAFT,
    images: [{ label: 'Image 1', mime: 'image/png', bytes: makePng(64, 40) }],
    resolved: RESOLVED,
    skipped: SKIPPED,
    theme: defaultDocTheme,
    idSource: new SeededIdSource(seed),
    generator: { app: 'ELI5 Learner', version: '1.0.0', edition: 'public', runtimeVersion: '1.0.0' },
  };
  if (name === 'placeholder') return { ...base, eli5: null, glossary: null, images: [], skipped: [] };
  if (name === 'themed') return { ...base, theme: THEMED, themeSource: 'overlay' };
  return base;
}
