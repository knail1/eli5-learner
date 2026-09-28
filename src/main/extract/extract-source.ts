/**
 * extractSource (04 §3): dispatch on ResolvedSource.format (no re-sniffing), per-format input cap,
 * timeout, error mapping, character cap, invariant check, and stats. Never throws.
 */
import type { ResolvedSource } from '../sources';
import { createDocxExtractor } from './docx';
import { createHtmlExtractor, type ReadableHtml } from './html';
import { createImageExtractor, type SipsConverter } from './images';
import { checkInvariants } from './invariants';
import { inputCapFor, timeoutFor } from './limits';
import { markdownExtractor } from './markdown';
import { payloadSize } from './payload';
import { createPdfExtractor } from './pdf';
import { createPptxExtractor } from './pptx';
import { readableHtml } from './readable';
import { ExtractError, skip } from './skip';
import { textExtractor } from './text';
import { countChars } from './text-util';
import type {
  ContentBlock,
  ExtractContext,
  ExtractedContent,
  ExtractResult,
  Extractor,
  ImageAsset,
  ImageBudget,
  ListItem,
  TableBlock,
} from './types';
import { csvExtractor, xlsxExtractor } from './xlsx';

export interface PublicExtractorDeps {
  sips?: SipsConverter;
  readable?: ReadableHtml;
}

/** The static registry in its fixed order (04 §3): pptx, docx, pdf, xlsx, csv, image, markdown, text, html. */
export function createPublicExtractors(deps: PublicExtractorDeps = {}): Extractor[] {
  return [
    createPptxExtractor(deps.sips ? { sips: deps.sips } : {}),
    createDocxExtractor(deps.sips ? { sips: deps.sips } : {}),
    createPdfExtractor(),
    xlsxExtractor,
    csvExtractor,
    createImageExtractor(deps.sips ? { sips: deps.sips } : {}),
    markdownExtractor,
    textExtractor,
    createHtmlExtractor({ readable: deps.readable ?? readableHtml }),
  ];
}

let defaultExtractors: Extractor[] | undefined;

/** Time an extractor gets after its signal fires to hand back partial output (04 §10.2). */
const ABORT_GRACE_MS = 250;

// ---- §10.1 maxCharsPerSource ----

/** Keeps leading list items (depth first) within `budget.left` characters. */
function capItems(items: readonly ListItem[], budget: { left: number }): ListItem[] {
  const out: ListItem[] = [];
  for (const it of items) {
    if (it.text.length > budget.left) {
      if (out.length === 0 && budget.left > 0) out.push({ text: it.text.slice(0, budget.left) });
      budget.left = 0;
      break;
    }
    budget.left -= it.text.length;
    const kept: ListItem = { text: it.text };
    if (it.children?.length) {
      const children = capItems(it.children, budget);
      if (children.length) kept.children = children;
    }
    out.push(kept);
    if (budget.left <= 0) break;
  }
  return out;
}

/** Keeps a table's caption, header and leading rows within the budget; records dropped rows. */
function capTable(b: TableBlock, budget: { left: number }): TableBlock | undefined {
  const fixed = (b.caption?.length ?? 0) + (b.header ?? []).reduce((a, c) => a + c.length, 0);
  if (fixed > budget.left) return undefined;
  budget.left -= fixed;
  const rows: string[][] = [];
  for (const r of b.rows) {
    const n = r.reduce((a, c) => a + c.length, 0);
    if (n > budget.left) break;
    rows.push(r);
    budget.left -= n;
  }
  if (!rows.length && !fixed) return undefined;
  const dropped = b.rows.length - rows.length + (b.truncated?.rows ?? 0);
  return { ...b, rows, truncated: { ...b.truncated, rows: dropped } };
}

/**
 * Oversized block when the cap is reached. Lists and tables are cut at an item or row boundary;
 * a heading or paragraph is cut only when nothing else was kept, so the cap never turns non-empty
 * content into zero blocks ("Truncation is never a skip", 04 §8.2).
 */
function cutBlock(b: ContentBlock, budget: { left: number }, nothingKept: boolean): ContentBlock | undefined {
  switch (b.kind) {
    case 'slide':
    case 'page': {
      const inner = capBlocks(b.blocks, budget);
      if (!inner.length) return undefined;
      return b.kind === 'slide' ? { ...b, blocks: inner, notes: undefined } : { ...b, blocks: inner };
    }
    case 'list': {
      const items = capItems(b.items, budget);
      return items.length ? { ...b, items } : undefined;
    }
    case 'table':
      return capTable(b, budget);
    case 'heading':
    case 'paragraph':
      return nothingKept ? { ...b, text: b.text.slice(0, budget.left) } : undefined;
    default:
      return undefined;
  }
}

function capBlocks(blocks: readonly ContentBlock[], budget: { left: number }): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    const n = countChars([b]);
    if (n <= budget.left) {
      out.push(b);
      budget.left -= n;
      continue;
    }
    if (budget.left > 0) {
      const cut = cutBlock(b, budget, out.length === 0);
      if (cut) out.push(cut);
    }
    budget.left = 0;
    break;
  }
  return out;
}

function stripUndefinedNotes(blocks: ContentBlock[]): void {
  for (const b of blocks) if (b.kind === 'slide' && b.notes === undefined) delete b.notes;
}

function referencedImages(blocks: readonly ContentBlock[], out: Set<string>): Set<string> {
  for (const b of blocks) {
    if (b.kind === 'image') out.add(b.imageId);
    else if (b.kind === 'slide' || b.kind === 'page') referencedImages(b.blocks, out);
  }
  return out;
}

export function applyCharCap(c: ExtractedContent, max: number): void {
  if (countChars(c.blocks) <= max) return;
  c.blocks = capBlocks(c.blocks, { left: max });
  stripUndefinedNotes(c.blocks);
  const refs = referencedImages(c.blocks, new Set());
  const before = c.images.length;
  c.images = c.images.filter((i) => refs.has(i.id));
  c.stats.imagesKept -= before - c.images.length;
  c.stats.imagesDropped += before - c.images.length;
  c.truncated = true;
  c.warnings.push(`Text cut at ${max.toLocaleString('en-US')} characters`);
}

// ---- §7.4 budget reservations per source ----

/**
 * Tracks what one source reserves from the job budget, so reservations for images that are never
 * sent (cut by the char cap, or the source skipped) go back to the job (§7.4). After close(), a
 * still-running extractor (late after a timeout) cannot reserve any more.
 */
class SourceBudget implements ImageBudget {
  private images = 0;
  private bytes = 0;
  private closed = false;
  constructor(private readonly inner: ImageBudget) {}
  get maxImages(): number {
    return this.inner.maxImages;
  }
  get maxTotalBytes(): number {
    return this.inner.maxTotalBytes;
  }
  tryReserve(bytes: number, priority: 'standalone' | 'page-render' | 'embedded'): boolean {
    if (this.closed || !this.inner.tryReserve(bytes, priority)) return false;
    this.images++;
    this.bytes += bytes;
    return true;
  }
  /** Keeps the reservations of `sent` and releases the rest. */
  close(sent: readonly ImageAsset[]): void {
    this.closed = true;
    const images = this.images - sent.length;
    const bytes = this.bytes - sent.reduce((a, i) => a + i.byteLength, 0);
    if (images > 0 || bytes > 0) this.inner.release?.(Math.max(0, images), Math.max(0, bytes));
    this.images = sent.length;
    this.bytes -= Math.max(0, bytes);
  }
}

// ---- error mapping ----

function mapError(err: unknown, source: ResolvedSource, ctx: ExtractContext, timeoutMs: number): ExtractResult {
  if (err instanceof ExtractError) {
    ctx.log(`extract: ${err.code}`);
    if (err.code === 'timeout') {
      // Report the deadline that actually fired (pdf.ts has its own, §10.2).
      return skip(source, 'timeout', { seconds: err.params.seconds ?? Math.round(timeoutMs / 1000) });
    }
    return skip(source, err.code, err.params);
  }
  const name = err instanceof Error ? err.name : typeof err;
  const msg = err instanceof Error ? err.message : '';
  if (err instanceof RangeError && /allocation|array length|too large|memory/i.test(msg)) {
    ctx.log(`extract: too-large (${name})`);
    return skip(source, 'too-large');
  }
  ctx.log(`extract: internal-error (${name})`);
  return skip(source, 'internal-error');
}

/** 04 §3. `extractors` defaults to the public static registry. */
export async function extractSource(
  source: ResolvedSource,
  ctx: ExtractContext,
  extractors?: readonly Extractor[],
): Promise<ExtractResult> {
  const budget = new SourceBudget(ctx.imageBudget);
  const result = await runExtract(source, { ...ctx, imageBudget: budget }, extractors);
  budget.close(result.ok ? result.content.images : []);
  return result;
}

async function runExtract(
  source: ResolvedSource,
  ctx: ExtractContext,
  extractors?: readonly Extractor[],
): Promise<ExtractResult> {
  const started = Date.now();
  const list = extractors ?? (defaultExtractors ??= createPublicExtractors());
  const extractor = list.find((e) => e.canHandle(source));
  if (!extractor) {
    ctx.log('extract: no extractor for format');
    return skip(source, 'unsupported-type');
  }
  const cap = inputCapFor(source.format, ctx.limits);
  const size = payloadSize(source);
  if (size > cap) return skip(source, 'too-large', { size, limit: cap });

  if (ctx.signal.aborted) return skip(source, 'cancelled');

  const timeoutMs = timeoutFor(source.format, ctx.limits);
  const ac = new AbortController();
  let timedOut = false;
  const onOuterAbort = (): void => ac.abort();
  ctx.signal.addEventListener('abort', onOuterAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);

  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    const arm = (): void => {
      graceTimer = setTimeout(() => resolve('late'), ABORT_GRACE_MS);
    };
    if (ac.signal.aborted) arm();
    else ac.signal.addEventListener('abort', arm, { once: true });
  });

  let result: ExtractResult;
  try {
    const run = extractor.extract(source, { ...ctx, signal: ac.signal });
    run.catch(() => undefined); // a late rejection after the race is already settled
    const r = await Promise.race([run, late]);
    if (r === 'late') {
      ctx.log(timedOut ? 'extract: timeout' : 'extract: cancelled');
      return timedOut ? skip(source, 'timeout', { seconds: Math.round(timeoutMs / 1000) }) : skip(source, 'cancelled');
    }
    // pptx/pdf return a truncated ok result when aborted mid-way; after a job cancel (not our
    // deadline) that is still a cancel (03 §7.2).
    if (ctx.signal.aborted && !timedOut) {
      ctx.log('extract: cancelled');
      return skip(source, 'cancelled');
    }
    result = r;
  } catch (err) {
    if (ac.signal.aborted && !(err instanceof ExtractError && err.code !== 'timeout')) {
      ctx.log(timedOut ? 'extract: timeout' : 'extract: cancelled');
      // An abort without our deadline firing is the job cancel (03 §7.2), not a timeout.
      if (!timedOut) return skip(source, 'cancelled');
      const seconds = err instanceof ExtractError ? err.params.seconds : undefined;
      return skip(source, 'timeout', { seconds: seconds ?? Math.round(timeoutMs / 1000) });
    }
    return mapError(err, source, ctx, timeoutMs);
  } finally {
    clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
    ctx.signal.removeEventListener('abort', onOuterAbort);
  }
  if (!result.ok) return result;

  const content = result.content;
  applyCharCap(content, ctx.limits.maxCharsPerSource);
  content.stats.chars = countChars(content.blocks);
  content.stats.approxTokens = Math.ceil(content.stats.chars / 4);
  if (content.stats.chars === 0 && content.images.length === 0) return skip(source, 'empty');
  const violation = checkInvariants(content);
  if (violation) {
    ctx.log(`extract: invariant violated (${violation})`);
    return skip(source, 'internal-error');
  }
  content.stats.elapsedMs = Date.now() - started;
  return { ok: true, content };
}
