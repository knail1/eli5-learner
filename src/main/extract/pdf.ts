/**
 * PDF (04 §6): text extraction with page order through pdf.js, scanned-page detection (§6.2), and
 * rendering of image-only pages through the injected PdfPageRenderer (§6.3). No OCR anywhere.
 */
import type { ResolvedSource } from '../sources';
import { imageIdGen } from './images';
import { EXTRACT_TIMEOUTS_MS } from './limits';
import { readSourceBytes } from './payload';
import {
  assembleLines,
  headingLevels,
  linesToBlocks,
  median,
  orderLines,
  removeRunningLines,
  type PageGeom,
  type PItem,
  type PLine,
} from './pdf-layout';
import { ExtractError } from './skip';
import { cleanInline, plural, newContent } from './text-util';
import type { ContentBlock, ExtractContext, ExtractResult, Extractor, ImageAsset, PageBlock } from './types';

// ---- minimal structural view of pdf.js (pdfjs-dist v6 legacy build) ----

interface PdfTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}
interface PdfPage {
  getViewport(o: { scale: number }): { viewBox: number[]; width: number; height: number };
  getTextContent(o: { includeMarkedContent: boolean }): Promise<{ items: PdfTextItem[] }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  cleanup(): void;
}
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  getMetadata(): Promise<{ info?: Record<string, unknown>; metadata?: { get(k: string): unknown } | null }>;
}
interface PdfJs {
  getDocument(o: Record<string, unknown>): { promise: Promise<PdfDoc>; destroy(): Promise<void> };
  GlobalWorkerOptions: { workerSrc: string };
  OPS: Record<string, number>;
  VerbosityLevel: { ERRORS: number };
}

let pdfjsPromise: Promise<PdfJs> | undefined;
let workerSrcOverride: string | undefined;

/** The extract worker points pdf.js at the copied pdf.worker.mjs in packaged builds (04 §6). */
export function setPdfWorkerSrc(url: string): void {
  workerSrcOverride = url;
}

async function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => m as unknown as PdfJs);
  const lib = await pdfjsPromise;
  if (workerSrcOverride) lib.GlobalWorkerOptions.workerSrc = workerSrcOverride;
  return lib;
}

// ---- §6.2 image coverage from the operator list ----

type M6 = [number, number, number, number, number, number];

function mul(m: readonly number[], ctm: M6): M6 {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m;
  const [A, B, C, D, E, F] = ctm;
  return [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
}

/** Largest single image area as a fraction of the page area (current transform matrix applied). */
export function maxImageCoverage(
  ops: { fnArray: number[]; argsArray: unknown[] },
  OPS: Record<string, number>,
  pageArea: number,
): number {
  const paint = new Set(
    [
      'paintImageXObject',
      'paintInlineImageXObject',
      'paintImageMaskXObject',
      'paintImageXObjectRepeat',
      'paintJpegXObject',
    ]
      .map((k) => OPS[k])
      .filter((v): v is number => v !== undefined),
  );
  let ctm: M6 = [1, 0, 0, 1, 0, 0];
  const stack: M6[] = [];
  let best = 0;
  ops.fnArray.forEach((fn, i) => {
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform && Array.isArray(args)) ctm = mul(args as number[], ctm);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = Array.isArray(args) ? args[0] : undefined;
      if (Array.isArray(m) || ArrayBuffer.isView(m)) ctm = mul(Array.from(m as ArrayLike<number>), ctm);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (paint.has(fn)) {
      const area = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
      best = Math.max(best, pageArea > 0 ? area / pageArea : 0);
    }
  });
  return best;
}

/** More than 30% Private Use Area or U+FFFD characters: a broken font encoding (§6.2). */
export function isGarbageText(s: string): boolean {
  const chars = [...s.replace(/\s/g, '')];
  if (!chars.length) return false;
  const bad = chars.filter((c) => c === '�' || (c >= '' && c <= '')).length;
  return bad / chars.length > 0.3;
}

function looksLikeFileName(t: string, source: ResolvedSource): boolean {
  const base = source.ref.replace(/\.[^.]+$/, '').toLowerCase();
  const low = t.toLowerCase();
  return (
    /\.(pdf|docx?|pptx?|xlsx?|txt|indd|tex|html?)$/i.test(t) ||
    low === base ||
    /^untitled/i.test(t) ||
    /^microsoft (word|powerpoint) - /i.test(t)
  );
}

interface PageData {
  number: number;
  geom: PageGeom;
  items: PItem[];
  lines: PLine[];
  imageOnly: boolean;
}

function toItems(items: readonly PdfTextItem[]): PItem[] {
  const out: PItem[] = [];
  for (const it of items) {
    if (typeof it.str !== 'string' || !it.transform) continue;
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = it.transform;
    const h = it.height || Math.hypot(c, d) || Math.hypot(a, b) || 0;
    out.push({ str: it.str, x: e, y: f, w: it.width ?? 0, h });
  }
  return out;
}

export function createPdfExtractor(): Extractor {
  return {
    id: 'pdf',
    formats: ['pdf'],
    canHandle: (s) => s.format === 'pdf',
    extract: (source, ctx) => extractPdf(source, ctx),
  };
}

async function extractPdf(source: ResolvedSource, ctx: ExtractContext): Promise<ExtractResult> {
  const bytes = await readSourceBytes(source);
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    data: bytes.slice(), // pdf.js may transfer the buffer; keep ours for rendering
    password: '',
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    disableAutoFetch: true,
    disableStream: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  let doc: PdfDoc;
  try {
    doc = await task.promise;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'PasswordException') throw new ExtractError('encrypted', 'pdf: password required');
    throw new ExtractError('corrupt', `pdf: ${name ?? 'load error'}`);
  }
  try {
    return await readDocument(doc, pdfjs, source, bytes, ctx);
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

async function readDocument(
  doc: PdfDoc,
  pdfjs: PdfJs,
  source: ResolvedSource,
  bytes: Uint8Array,
  ctx: ExtractContext,
): Promise<ExtractResult> {
  const { limits } = ctx;
  const warnings: string[] = [];
  const content = newContent(source);
  const total = Math.min(doc.numPages, limits.pdf.maxPages);
  if (doc.numPages > limits.pdf.maxPages) {
    warnings.push(`Read the first ${limits.pdf.maxPages} of ${doc.numPages} pages`);
    content.truncated = true;
  }
  const started = Date.now();
  const pages: PageData[] = [];
  for (let p = 1; p <= total; p++) {
    if (ctx.signal.aborted || Date.now() - started > EXTRACT_TIMEOUTS_MS.pdfText) {
      if (!pages.length) throw new ExtractError('timeout', 'pdf: text pass');
      warnings.push(`Stopped after ${pages.length} of ${total} pages (timeout)`);
      content.truncated = true;
      break;
    }
    let page: PdfPage;
    let text: { items: PdfTextItem[] };
    try {
      page = await doc.getPage(p);
      text = await page.getTextContent({ includeMarkedContent: false });
    } catch {
      throw new ExtractError('corrupt', 'pdf: page read');
    }
    const vb = page.getViewport({ scale: 1 }).viewBox;
    const geom: PageGeom = {
      x0: Math.min(vb[0] ?? 0, vb[2] ?? 0),
      y0: Math.min(vb[1] ?? 0, vb[3] ?? 0),
      width: Math.abs((vb[2] ?? 0) - (vb[0] ?? 0)),
      height: Math.abs((vb[3] ?? 0) - (vb[1] ?? 0)),
    };
    const items = toItems(text.items);
    const all = items.map((i) => i.str).join('');
    const nonWs = all.replace(/\s/g, '').length;
    let imageOnly = isGarbageText(all);
    if (!imageOnly && nonWs < limits.pdf.minCharsPerPage) {
      try {
        const ops = await page.getOperatorList();
        imageOnly = maxImageCoverage(ops, pdfjs.OPS, geom.width * geom.height) >= 0.5;
      } catch {
        imageOnly = false;
      }
    }
    pages.push({
      number: p,
      geom,
      items,
      lines: imageOnly && isGarbageText(all) ? [] : assembleLines(items),
      imageOnly,
    });
    page.cleanup();
  }

  // Running headers and footers, then per-page blocks.
  const textPages = pages.filter((p) => !p.imageOnly);
  const removed = removeRunningLines(textPages);
  if (removed) warnings.push(`Removed ${plural(removed, 'running header or footer line')}`);
  const bodyH =
    median(
      pages.flatMap((p) =>
        p.items.filter((i) => i.str.trim()).flatMap((i) => Array<number>(Math.min(i.str.length, 50)).fill(i.h)),
      ),
    ) || 10;
  const levels = headingLevels(
    pages.flatMap((p) => p.lines.map((l) => l.h)),
    bodyH,
  );
  const pageBlocks = new Map<number, ContentBlock[]>();
  for (const p of pages) pageBlocks.set(p.number, linesToBlocks(orderLines(p.lines, p.geom), bodyH, levels));

  // §6.2 classification and §6.3 rendering.
  const imageOnly = pages.filter((p) => p.imageOnly).map((p) => p.number);
  const images: ImageAsset[] = [];
  let kept = 0;
  let dropped = 0;
  if (imageOnly.length) {
    content.stats.scannedPages = imageOnly.length;
    const cap = limits.pdf.maxRenderedPages;
    const toRender = imageOnly.slice(0, cap);
    if (imageOnly.length > cap) {
      warnings.push(`Rendered first ${cap} of ${imageOnly.length} scanned pages`);
      content.truncated = true;
    }
    const rendered = await ctx.renderPdfPages(bytes, toRender, {
      targetLongEdgePx: limits.images.targetLongEdgePx,
      signal: ctx.signal,
    });
    const nextId = imageIdGen(source);
    let renderedOk = 0;
    let budgetDrops = 0;
    for (const r of [...rendered].sort((a, b) => a.page - b.page)) {
      if (!('png' in r)) {
        ctx.log(`pdf: page render failed`);
        dropped++;
        continue;
      }
      renderedOk++;
      const norm = await ctx.normalizeImage(r.png, 'image/png', { origin: 'page-render', signal: ctx.signal });
      if (!norm.ok || !norm.assets.length) {
        dropped++;
        continue;
      }
      const blocks = pageBlocks.get(r.page) ?? [];
      const n = norm.assets.length;
      for (const [k, a] of norm.assets.entries()) {
        if (!ctx.imageBudget.tryReserve(a.byteLength, 'page-render')) {
          budgetDrops++;
          dropped++;
          break;
        }
        const id = nextId();
        images.push({ ...a, id, origin: 'page-render', pageOrSlide: r.page });
        blocks.push({
          kind: 'image',
          imageId: id,
          origin: 'page-render',
          alt: n > 1 ? `Scanned page ${r.page}, part ${k + 1} of ${n}` : `Scanned page ${r.page}`,
        });
        kept++;
      }
      pageBlocks.set(r.page, blocks);
    }
    if (renderedOk === 0 && toRender.length) {
      if (textPages.length === 0) throw new ExtractError('scan-render-failed', 'pdf: no page rendered');
      warnings.push('Scanned PDF pages could not be rendered');
    }
    if (budgetDrops) warnings.push(`${plural(budgetDrops, 'scanned page')} not sent: job image budget reached`);
  }

  const out: PageBlock[] = [];
  for (const p of pages) {
    const blocks = pageBlocks.get(p.number) ?? [];
    if (blocks.length) out.push({ kind: 'page', number: p.number, blocks });
  }
  content.blocks = out;
  content.images = images;
  content.warnings = warnings;
  content.stats.pages = pages.length;
  content.stats.imagesKept = kept;
  content.stats.imagesDropped = dropped;
  if (pages.length > 0 && imageOnly.length === pages.length) content.format = 'pdf-scanned';
  if (kept === 0 && imageOnly.length && textPages.length === 0) {
    throw new ExtractError('image-budget-exceeded', 'pdf: no scanned page fit the budget', {
      maxImages: ctx.imageBudget.maxImages,
    });
  }

  // Title: info dictionary or XMP if meaningful, else the first heading on page 1 (§6.1 step 5).
  let title: string | undefined;
  try {
    const meta = await doc.getMetadata();
    const cand = [meta.info?.Title, meta.metadata?.get('dc:title')]
      .map((v) => (typeof v === 'string' ? cleanInline(v) : ''))
      .find((v) => v && !looksLikeFileName(v, source));
    title = cand || undefined;
  } catch {
    title = undefined;
  }
  if (!title) {
    const first = out.find((b) => b.number === 1)?.blocks.find((b) => b.kind === 'heading');
    if (first?.kind === 'heading') title = first.text;
  }
  if (title) content.title = title;
  return { ok: true, content };
}
