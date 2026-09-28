/**
 * PowerPoint (04 §5.1): slide order from p:sldIdLst (never file names), titles from title
 * placeholders, bullet nesting from a:pPr@lvl, tables, chart cached values, SmartArt text,
 * pictures through the embedded-image policy, and speaker notes from the notes body placeholder.
 */
import type { ResolvedSource } from '../sources';
import { processEmbeddedImages, imageIdGen, type EmbeddedCandidate, type SipsConverter } from './images';
import {
  allText,
  attr,
  child,
  children,
  coreTitle,
  kids,
  leafText,
  parseRels,
  parseXml,
  path,
  rootEl,
  tagOf,
  type Relationship,
  type XNode,
} from './ooxml-xml';
import { readSourceBytes } from './payload';
import { ExtractError } from './skip';
import { buildNestedList, cleanInline, cleanMultiline, countChars, newContent, plural } from './text-util';
import type { ContentBlock, ExtractContext, ExtractResult, Extractor, ListItem, SlideBlock, TableBlock } from './types';
import { SafeZip, dirOf, relsPathFor, resolvePartPath } from './zip-safety';

const EMU_PER_INCH = 914400;
const ROW_TOLERANCE = EMU_PER_INCH / 2;
const DEFAULT_TITLES = /^(powerpoint presentation|presentation\d*|slide \d+|untitled|title)$/i;
const FOOTER_PH = new Set(['ftr', 'sldNum', 'dt']);
const TITLE_PH = new Set(['title', 'ctrTitle']);
const REL = {
  slideLayout: '/slideLayout',
  notesSlide: '/notesSlide',
  chart: '/chart',
  diagramData: '/diagramData',
};

// ---- geometry ----

interface Xf {
  ox: number;
  oy: number;
  chx: number;
  chy: number;
  sx: number;
  sy: number;
}
const IDENTITY: Xf = { ox: 0, oy: 0, chx: 0, chy: 0, sx: 1, sy: 1 };

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function offOf(xfrm: XNode | undefined): { x: number; y: number } | undefined {
  const off = child(xfrm, 'a:off');
  const x = num(attr(off, 'x'));
  const y = num(attr(off, 'y'));
  return x === undefined || y === undefined ? undefined : { x, y };
}

function apply(xf: Xf, p: { x: number; y: number }): { x: number; y: number } {
  return { x: xf.ox + (p.x - xf.chx) * xf.sx, y: xf.oy + (p.y - xf.chy) * xf.sy };
}

function groupXf(grp: XNode, parent: Xf): Xf {
  const xfrm = path(grp, 'p:grpSpPr', 'a:xfrm');
  const off = offOf(xfrm);
  if (!off) return parent;
  const ext = child(xfrm, 'a:ext');
  const chOff = child(xfrm, 'a:chOff');
  const chExt = child(xfrm, 'a:chExt');
  const cx = num(attr(ext, 'cx')) ?? 1;
  const cy = num(attr(ext, 'cy')) ?? 1;
  const ccx = num(attr(chExt, 'cx')) || cx;
  const ccy = num(attr(chExt, 'cy')) || cy;
  const o = apply(parent, off);
  return {
    ox: o.x,
    oy: o.y,
    chx: num(attr(chOff, 'x')) ?? 0,
    chy: num(attr(chOff, 'y')) ?? 0,
    sx: (cx / ccx) * parent.sx,
    sy: (cy / ccy) * parent.sy,
  };
}

// ---- shapes ----

interface Placeholder {
  type: string;
  idx?: string;
}

interface RawShape {
  node: XNode;
  tag: string;
  pos?: { x: number; y: number };
  ph?: Placeholder;
  order: number;
}

function placeholderOf(shape: XNode, tag: string): Placeholder | undefined {
  const nv = tag === 'p:sp' ? 'p:nvSpPr' : tag === 'p:pic' ? 'p:nvPicPr' : 'p:nvGraphicFramePr';
  const ph = path(shape, nv, 'p:nvPr', 'p:ph');
  if (!ph) return undefined;
  const idx = attr(ph, 'idx');
  // ST_PlaceholderType defaults to "obj".
  return { type: attr(ph, 'type') ?? 'obj', ...(idx !== undefined ? { idx } : {}) };
}

/** Depth-first shape walk flattening p:grpSp (04 §5.1 step 3.2). */
function walkShapes(nodes: readonly XNode[], xf: Xf, out: RawShape[]): void {
  for (const c of nodes) {
    const tag = tagOf(c);
    if (!tag) continue;
    if (tag === 'p:grpSp') {
      walkShapes(kids(c), groupXf(c, xf), out);
    } else if (tag === 'mc:AlternateContent') {
      const choice = child(c, 'mc:Choice') ?? child(c, 'mc:Fallback');
      walkShapes(kids(choice), xf, out);
    } else if (tag === 'p:sp' || tag === 'p:pic' || tag === 'p:graphicFrame') {
      const xfrm = tag === 'p:graphicFrame' ? child(c, 'p:xfrm') : path(c, 'p:spPr', 'a:xfrm');
      const off = offOf(xfrm);
      const ph = placeholderOf(c, tag);
      out.push({
        node: c,
        tag,
        order: out.length,
        ...(off ? { pos: apply(xf, off) } : {}),
        ...(ph ? { ph } : {}),
      });
    }
  }
}

/** Sorts by (y, x) with a 0.5-inch row tolerance so two-column layouts read left then right. */
export function readingOrder<T extends { pos?: { x: number; y: number }; order: number }>(shapes: readonly T[]): T[] {
  let last = { x: -1, y: -1 };
  const eff = shapes.map((s) => {
    if (s.pos) last = s.pos;
    return { s, x: last.x, y: last.y };
  });
  eff.sort((a, b) => a.y - b.y || a.s.order - b.s.order);
  const rows: (typeof eff)[] = [];
  for (const e of eff) {
    const row = rows[rows.length - 1];
    if (row && e.y - row[0]!.y <= ROW_TOLERANCE) row.push(e);
    else rows.push([e]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x || a.s.order - b.s.order).map((e) => e.s));
}

// ---- text ----

function paragraphText(p: XNode, opts: { notes?: boolean } = {}): string {
  let s = '';
  for (const c of kids(p)) {
    switch (tagOf(c)) {
      case 'a:r':
        s += leafText(child(c, 'a:t'));
        break;
      case 'a:br':
        s += ' ';
        break;
      case 'a:fld':
        if (!(opts.notes && attr(c, 'type') === 'slidenum')) s += leafText(child(c, 'a:t'));
        break;
      case 'a14:m':
        s += allText(c, 'm:t');
        break;
      case 'mc:AlternateContent': {
        const choice = child(c, 'mc:Choice') ?? child(c, 'mc:Fallback');
        if (choice) s += paragraphText(choice, opts);
        break;
      }
      default:
        break;
    }
  }
  return cleanInline(s);
}

function isBulleted(p: XNode, ph: Placeholder | undefined): { bulleted: boolean; ordered: boolean } {
  const pPr = child(p, 'a:pPr');
  if (child(pPr, 'a:buAutoNum')) return { bulleted: true, ordered: true };
  if (child(pPr, 'a:buChar') || child(pPr, 'a:buBlip')) return { bulleted: true, ordered: false };
  if (child(pPr, 'a:buNone')) return { bulleted: false, ordered: false };
  // Body and content placeholders get their bullets from the layout.
  return { bulleted: !!ph && (ph.type === 'body' || ph.type === 'obj'), ordered: false };
}

/** Paragraphs of a txBody as paragraph and list blocks (04 §5.1 step 3.4). */
function textBodyBlocks(txBody: XNode | undefined, ph: Placeholder | undefined): ContentBlock[] {
  const out: ContentBlock[] = [];
  let items: Array<{ level: number; text: string }> = [];
  let ordered = false;
  const flush = (): void => {
    if (items.length) out.push({ kind: 'list', ordered, items: buildNestedList(items) });
    items = [];
  };
  for (const p of children(txBody, 'a:p')) {
    const text = paragraphText(p);
    if (!text) continue;
    const b = isBulleted(p, ph);
    if (b.bulleted) {
      if (!items.length) ordered = b.ordered;
      const lvl = Math.min(8, Math.max(0, num(attr(child(p, 'a:pPr'), 'lvl')) ?? 0));
      items.push({ level: lvl, text });
    } else {
      flush();
      out.push({ kind: 'paragraph', text });
    }
  }
  flush();
  return out;
}

function tableBlock(tbl: XNode): TableBlock | undefined {
  const rows: string[][] = [];
  for (const tr of children(tbl, 'a:tr')) {
    const cells: string[] = [];
    for (const tc of children(tr, 'a:tc')) {
      const continuation = attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1';
      cells.push(
        continuation
          ? ''
          : cleanInline(
              children(child(tc, 'a:txBody'), 'a:p')
                .map((p) => paragraphText(p))
                .join(' '),
            ),
      );
    }
    rows.push(cells);
  }
  if (!rows.length || rows.every((r) => r.every((c) => c === ''))) return undefined;
  const firstRow = attr(child(tbl, 'a:tblPr'), 'firstRow') === '1';
  return firstRow && rows.length > 0
    ? { kind: 'table', header: rows[0]!, rows: rows.slice(1) }
    : { kind: 'table', rows };
}

// ---- charts and SmartArt ----

function cachePoints(ref: XNode | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (!ref) return out;
  const cache =
    child(child(ref, 'c:strRef'), 'c:strCache') ??
    child(child(ref, 'c:numRef'), 'c:numCache') ??
    child(ref, 'c:strLit') ??
    child(ref, 'c:numLit') ??
    child(child(ref, 'c:multiLvlStrRef'), 'c:multiLvlStrCache');
  const holder = cache && tagOf(cache) === 'c:multiLvlStrCache' ? child(cache, 'c:lvl') : cache;
  for (const pt of children(holder, 'c:pt')) {
    const idx = num(attr(pt, 'idx'));
    if (idx !== undefined) out.set(idx, cleanInline(leafText(child(pt, 'c:v'))));
  }
  return out;
}

/** Chart cached values as a table captioned "Chart: <title>" (04 §5.1 step 3.6). */
export function chartTable(xml: string): TableBlock | undefined {
  const space = rootEl(parseXml(xml), 'c:chartSpace');
  const chart = child(space, 'c:chart');
  const title = cleanInline(allText(child(chart, 'c:title'), 'a:t'));
  const plot = child(chart, 'c:plotArea');
  const series: Array<{ name: string; cats: Map<number, string>; vals: Map<number, string> }> = [];
  for (const group of kids(plot)) {
    if (!tagOf(group)?.endsWith('Chart')) continue;
    for (const ser of children(group, 'c:ser')) {
      const tx = child(ser, 'c:tx');
      const name =
        [...cachePoints(tx).values()][0] ?? cleanInline(leafText(child(tx, 'c:v'))) ?? `Series ${series.length + 1}`;
      series.push({
        name: name || `Series ${series.length + 1}`,
        cats: cachePoints(child(ser, 'c:cat') ?? child(ser, 'c:xVal')),
        vals: cachePoints(child(ser, 'c:val') ?? child(ser, 'c:yVal')),
      });
    }
  }
  if (!series.length) return undefined;
  const idxs = [...new Set(series.flatMap((s) => [...s.cats.keys(), ...s.vals.keys()]))].sort((a, b) => a - b);
  const rows = idxs.map((i) => [
    series.find((s) => s.cats.has(i))?.cats.get(i) ?? String(i + 1),
    ...series.map((s) => s.vals.get(i) ?? ''),
  ]);
  return {
    kind: 'table',
    caption: title ? `Chart: ${title}` : 'Chart',
    header: ['Category', ...series.map((s) => s.name)],
    rows,
  };
}

function smartArtList(xml: string): ContentBlock | undefined {
  const pts = rootEl(parseXml(xml), 'dgm:dataModel');
  const items: ListItem[] = [];
  for (const pt of children(child(pts, 'dgm:ptLst'), 'dgm:pt')) {
    const text = cleanInline(
      children(child(pt, 'dgm:t'), 'a:p')
        .map((p) => paragraphText(p))
        .join(' '),
    );
    if (text) items.push({ text });
  }
  return items.length ? { kind: 'list', ordered: false, items } : undefined;
}

// ---- per-slide processing ----

interface SlideCtx {
  zip: SafeZip;
  part: string;
  rels: Map<string, Relationship>;
  warnings: Set<string>;
  images: EmbeddedCandidate[];
  slideIndex: number;
  footerPlaceholders: { n: number };
  layoutCache: Map<string, Map<string, { x: number; y: number }>>;
}

function relTarget(sc: SlideCtx, rid: string | undefined, kind?: string): string | undefined {
  if (!rid) return undefined;
  const r = sc.rels.get(rid);
  if (!r || r.external || (kind && !r.type.endsWith(kind))) return undefined;
  const p = resolvePartPath(dirOf(sc.part), r.target);
  return sc.zip.has(p) ? p : undefined;
}

/** Placeholder positions from the slide layout, keyed by "idx:<n>" and "type:<t>". */
function layoutPositions(sc: SlideCtx): Map<string, { x: number; y: number }> {
  const rel = [...sc.rels.values()].find((r) => r.type.endsWith(REL.slideLayout));
  const out = new Map<string, { x: number; y: number }>();
  if (!rel) return out;
  const layoutPart = resolvePartPath(dirOf(sc.part), rel.target);
  const cached = sc.layoutCache.get(layoutPart);
  if (cached) return cached;
  sc.layoutCache.set(layoutPart, out);
  const xml = sc.zip.readText(layoutPart);
  if (!xml) return out;
  const tree = path(rootEl(parseXml(xml), 'p:sldLayout'), 'p:cSld', 'p:spTree');
  const shapes: RawShape[] = [];
  walkShapes(kids(tree), IDENTITY, shapes);
  for (const s of shapes) {
    if (!s.ph || !s.pos) continue;
    if (s.ph.idx !== undefined && !out.has(`idx:${s.ph.idx}`)) out.set(`idx:${s.ph.idx}`, s.pos);
    if (!out.has(`type:${s.ph.type}`)) out.set(`type:${s.ph.type}`, s.pos);
  }
  return out;
}

function slideContent(tree: XNode | undefined, sc: SlideCtx): { title?: string; blocks: ContentBlock[] } {
  const raw: RawShape[] = [];
  walkShapes(kids(tree), IDENTITY, raw);
  let layout: Map<string, { x: number; y: number }> | undefined;
  for (const s of raw) {
    if (s.pos || !s.ph) continue;
    layout ??= layoutPositions(sc);
    const inherited =
      (s.ph.idx !== undefined ? layout.get(`idx:${s.ph.idx}`) : undefined) ?? layout.get(`type:${s.ph.type}`);
    if (inherited) s.pos = inherited;
  }
  let title: string | undefined;
  const blocks: ContentBlock[] = [];
  for (const s of readingOrder(raw)) {
    if (s.ph && FOOTER_PH.has(s.ph.type)) {
      sc.footerPlaceholders.n++;
      continue;
    }
    if (s.tag === 'p:sp') {
      const txBody = child(s.node, 'p:txBody');
      if (s.ph && TITLE_PH.has(s.ph.type)) {
        const t = cleanInline(
          children(txBody, 'a:p')
            .map((p) => paragraphText(p))
            .join(' '),
        );
        if (title === undefined && t) title = t;
        else if (t) blocks.push({ kind: 'paragraph', text: t });
        continue;
      }
      blocks.push(...textBodyBlocks(txBody, s.ph));
    } else if (s.tag === 'p:graphicFrame') {
      const data = path(s.node, 'a:graphic', 'a:graphicData');
      const tbl = child(data, 'a:tbl');
      const chart = child(data, 'c:chart');
      const dgm = child(data, 'dgm:relIds');
      if (tbl) {
        const t = tableBlock(tbl);
        if (t) blocks.push(t);
      } else if (chart) {
        const part = relTarget(sc, attr(chart, 'r:id'), REL.chart);
        const xml = part ? sc.zip.readText(part) : undefined;
        if (!xml) sc.warnings.add('Some slides had broken links to charts or objects; skipped');
        else {
          const t = chartTable(xml);
          if (t) blocks.push(t);
        }
      } else if (dgm) {
        const part = relTarget(sc, attr(dgm, 'r:dm'), REL.diagramData);
        const xml = part ? sc.zip.readText(part) : undefined;
        const list = xml ? smartArtList(xml) : undefined;
        if (list) blocks.push(list);
      } else if (/\/ole$|oleObject/i.test(attr(data, 'uri') ?? '') || child(data, 'p:oleObj')) {
        sc.warnings.add('Embedded objects (OLE) were ignored');
      }
    } else if (s.tag === 'p:pic') {
      const blip = path(s.node, 'p:blipFill', 'a:blip');
      const part = relTarget(sc, attr(blip, 'r:embed'));
      const bytes = part ? sc.zip.read(part) : undefined;
      if (!bytes) {
        sc.warnings.add('Some slides had broken links to charts or objects; skipped');
        continue;
      }
      const key = `pptx-img:${sc.images.length}`;
      const alt = attr(path(s.node, 'p:nvPicPr', 'p:cNvPr'), 'descr');
      sc.images.push({ key, bytes, pageOrSlide: sc.slideIndex, containerChars: 0, ...(alt ? { alt } : {}) });
      blocks.push({ kind: 'image', imageId: key, origin: 'embedded', ...(alt ? { alt } : {}) });
    }
  }
  return { ...(title !== undefined ? { title } : {}), blocks };
}

function notesText(sc: SlideCtx): string | undefined {
  const rel = [...sc.rels.values()].find((r) => r.type.endsWith(REL.notesSlide));
  if (!rel) return undefined;
  const part = resolvePartPath(dirOf(sc.part), rel.target);
  const xml = sc.zip.readText(part);
  if (!xml) return undefined;
  const tree = path(rootEl(parseXml(xml), 'p:notes'), 'p:cSld', 'p:spTree');
  const shapes: RawShape[] = [];
  walkShapes(kids(tree), IDENTITY, shapes);
  const lines: string[] = [];
  for (const s of shapes) {
    if (s.tag !== 'p:sp' || s.ph?.type !== 'body') continue;
    for (const p of children(child(s.node, 'p:txBody'), 'a:p')) lines.push(paragraphText(p, { notes: true }));
  }
  const text = cleanMultiline(lines.join('\n'));
  return text || undefined;
}

// ---- repeated footer lines ----

function linesOf(blocks: readonly ContentBlock[], out: Set<string>): void {
  const items = (its: readonly ListItem[]): void => {
    for (const it of its) {
      out.add(it.text);
      if (it.children) items(it.children);
    }
  };
  for (const b of blocks) {
    if (b.kind === 'paragraph') out.add(b.text);
    else if (b.kind === 'list') items(b.items);
  }
}

function removeLines(blocks: ContentBlock[], drop: ReadonlySet<string>): { blocks: ContentBlock[]; removed: number } {
  let removed = 0;
  const filterItems = (its: readonly ListItem[]): ListItem[] => {
    const out: ListItem[] = [];
    for (const it of its) {
      const kidsKept = it.children ? filterItems(it.children) : undefined;
      if (drop.has(it.text)) {
        removed++;
        if (kidsKept?.length) out.push(...kidsKept);
        continue;
      }
      out.push(kidsKept?.length ? { ...it, children: kidsKept } : { text: it.text });
    }
    return out;
  };
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    if (b.kind === 'paragraph' && drop.has(b.text)) {
      removed++;
      continue;
    }
    if (b.kind === 'list') {
      const items = filterItems(b.items);
      if (items.length) out.push({ ...b, items });
      continue;
    }
    out.push(b);
  }
  return { blocks: out, removed };
}

/** Removes lines on more than 60% of slides and on at least 3 slides (04 §5.1 edge cases). */
export function removeRepeatedLines(slides: SlideBlock[]): number {
  const counts = new Map<string, number>();
  for (const s of slides) {
    const set = new Set<string>();
    linesOf(s.blocks, set);
    for (const l of set) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const drop = new Set([...counts].filter(([, n]) => n >= 3 && n > 0.6 * slides.length).map(([l]) => l));
  if (!drop.size) return 0;
  let removed = 0;
  for (const s of slides) {
    const r = removeLines(s.blocks, drop);
    s.blocks = r.blocks;
    removed += r.removed;
  }
  return removed;
}

function replaceImages(blocks: ContentBlock[], map: ReadonlyMap<string, ContentBlock[]>): ContentBlock[] {
  return blocks.flatMap((b) => (b.kind === 'image' && map.has(b.imageId) ? map.get(b.imageId)! : [b]));
}

// ---- extractor ----

export function createPptxExtractor(deps: { sips?: SipsConverter } = {}): Extractor {
  return {
    id: 'pptx',
    formats: ['pptx'],
    canHandle: (s) => s.format === 'pptx',
    extract: (source, ctx) => extractPptx(source, ctx, deps.sips),
  };
}

async function extractPptx(source: ResolvedSource, ctx: ExtractContext, sips?: SipsConverter): Promise<ExtractResult> {
  const zip = SafeZip.open(await readSourceBytes(source));
  const presXml = zip.readText('ppt/presentation.xml');
  if (presXml === undefined) throw new ExtractError('corrupt', 'pptx: no presentation part');
  const pres = rootEl(parseXml(presXml), 'p:presentation');
  const presRels = parseRels(zip.readText(relsPathFor('ppt/presentation.xml')));
  const sldIds = children(child(pres, 'p:sldIdLst'), 'p:sldId');

  const warnings = new Set<string>();
  const content = newContent(source);
  const limit = ctx.limits.pptx.maxSlides;
  const slides: SlideBlock[] = [];
  const images: EmbeddedCandidate[] = [];
  const footerPlaceholders = { n: 0 };
  const layoutCache = new Map<string, Map<string, { x: number; y: number }>>();
  let hiddenSkipped = 0;
  let untitled = 0;
  let processed = 0;

  for (const [i, sldId] of sldIds.entries()) {
    if (i >= limit) break;
    if (ctx.signal.aborted) {
      if (!slides.length) throw new ExtractError('timeout', 'pptx: aborted');
      warnings.add(`Stopped after ${processed} of ${Math.min(sldIds.length, limit)} slides (timeout)`);
      content.truncated = true;
      break;
    }
    processed++;
    const rel = presRels.get(attr(sldId, 'r:id') ?? '');
    const part = rel ? resolvePartPath('ppt', rel.target) : undefined;
    const xml = part ? zip.readText(part) : undefined;
    if (!part || xml === undefined) {
      warnings.add('Some slides had broken links to charts or objects; skipped');
      continue;
    }
    const sld = rootEl(parseXml(xml), 'p:sld');
    const hidden = attr(sld, 'show') === '0' || attr(sld, 'show') === 'false';
    if (hidden && !ctx.limits.pptx.includeHidden) {
      hiddenSkipped++;
      continue;
    }
    const sc: SlideCtx = {
      zip,
      part,
      rels: parseRels(zip.readText(relsPathFor(part))),
      warnings,
      images,
      slideIndex: i + 1,
      footerPlaceholders,
      layoutCache,
    };
    const firstImage = images.length;
    const { title, blocks } = slideContent(path(sld, 'p:cSld', 'p:spTree'), sc);
    const slide: SlideBlock = { kind: 'slide', index: i + 1, blocks };
    if (title) slide.title = title;
    else untitled++;
    if (hidden) slide.hidden = true;
    const notes = notesText(sc);
    if (notes) slide.notes = { kind: 'notes', text: notes };
    const chars = countChars(blocks) + (title?.length ?? 0);
    for (let k = firstImage; k < images.length; k++) images[k]!.containerChars = chars;
    slides.push(slide);
  }
  if (sldIds.length > limit) {
    warnings.add(`Kept the first ${limit} of ${sldIds.length} slides`);
    content.truncated = true;
  }

  const removed = removeRepeatedLines(slides);
  if (removed) warnings.add(`Removed ${plural(removed, 'repeated footer line')}`);
  if (untitled) warnings.add(`${plural(untitled, 'slide')} had no title`);
  if (hiddenSkipped) warnings.add(`${plural(hiddenSkipped, 'hidden slide')} skipped`);

  const emb = await processEmbeddedImages(images, ctx, imageIdGen(source), sips);
  for (const s of slides) s.blocks = replaceImages(s.blocks, emb.blocks);
  for (const w of emb.warnings) warnings.add(w);

  const core = coreTitle(zip.readText('docProps/core.xml'));
  const title = core && !DEFAULT_TITLES.test(core) ? cleanInline(core) : slides[0]?.title;
  content.blocks = slides;
  content.images = emb.images;
  if (title) content.title = title;
  content.warnings = [...warnings];
  content.stats.slides = slides.length;
  content.stats.imagesKept = emb.kept;
  content.stats.imagesDropped = emb.dropped;
  return { ok: true, content };
}
