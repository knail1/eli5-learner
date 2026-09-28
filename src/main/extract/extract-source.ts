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
import { ExtractError, skip } from './skip';
import { textExtractor } from './text';
import { countChars } from './text-util';
import type { ContentBlock, ExtractContext, ExtractedContent, ExtractResult, Extractor } from './types';
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
    createHtmlExtractor(deps.readable ? { readable: deps.readable } : {}),
  ];
}

let defaultExtractors: Extractor[] | undefined;

/** Time an extractor gets after its signal fires to hand back partial output (04 §10.2). */
const ABORT_GRACE_MS = 250;

// ---- §10.1 maxCharsPerSource ----

function capBlocks(blocks: readonly ContentBlock[], budget: { left: number }): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    const n = countChars([b]);
    if (n <= budget.left) {
      out.push(b);
      budget.left -= n;
      continue;
    }
    if ((b.kind === 'slide' || b.kind === 'page') && budget.left > 0) {
      const inner = capBlocks(b.blocks, budget);
      if (inner.length) out.push({ ...b, blocks: inner, ...(b.kind === 'slide' ? { notes: undefined } : {}) });
    } else if (out.length === 0 && b.kind === 'paragraph' && budget.left > 0) {
      // A single oversized paragraph (e.g. a text file with no blank lines) is cut, not dropped.
      out.push({ ...b, text: b.text.slice(0, budget.left) });
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

// ---- error mapping ----

function mapError(err: unknown, source: ResolvedSource, ctx: ExtractContext, timeoutMs: number): ExtractResult {
  if (err instanceof ExtractError) {
    ctx.log(`extract: ${err.code}`);
    if (err.code === 'timeout') return skip(source, 'timeout', { seconds: Math.round(timeoutMs / 1000) });
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

  const timeoutMs = timeoutFor(source.format, ctx.limits);
  const ac = new AbortController();
  let timedOut = false;
  const onOuterAbort = (): void => ac.abort();
  if (ctx.signal.aborted) ac.abort();
  else ctx.signal.addEventListener('abort', onOuterAbort, { once: true });
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
      ctx.log(`extract: timeout`);
      return skip(source, 'timeout', { seconds: Math.round(timeoutMs / 1000) });
    }
    result = r;
  } catch (err) {
    if (ac.signal.aborted && !(err instanceof ExtractError && err.code !== 'timeout')) {
      ctx.log(timedOut ? 'extract: timeout' : 'extract: aborted');
      return skip(source, 'timeout', { seconds: Math.round(timeoutMs / 1000) });
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
