/**
 * Images (04 §7): header checks, sips pre-conversion, tall-screenshot tiling plan, the job-wide
 * ImageBudget, the embedded-image policy, and the standalone image extractor.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedSource, SourceFormat } from '../sources';
import { DEFAULT_IMAGE_BUDGET, EXTRACT_TIMEOUTS_MS } from './limits';
import { MEDIA_TYPE, readImageHeader, type ImageHeader } from './image-header';
import { readSourceBytes } from './payload';
import { ExtractError, skip } from './skip';
import { newContent, plural } from './text-util';
import type {
  ContentBlock,
  ExtractContext,
  ExtractResult,
  Extractor,
  ImageAsset,
  ImageBlock,
  ImageBudget,
  ParagraphBlock,
} from './types';

// ---- §7.4 job-wide budget ----

export type BudgetPriority = 'standalone' | 'page-render' | 'embedded';

export interface BudgetState {
  maxImages: number;
  maxTotalBytes: number;
  usedImages: number;
  usedBytes: number;
  /** Standalone images announced by the pipeline but not reserved yet (§7.4). */
  pendingStandalone: number;
}

/** Bytes held back per announced standalone image until it reserves its real size. */
export const STANDALONE_BYTES_ESTIMATE = 1_000_000;

/**
 * The shared budget for one job. Standalone images get priority: the pipeline announces how many
 * it will extract (reserveStandalone), and other images cannot eat into those slots.
 * snapshot()/apply() let the extract worker hold a local copy while one source runs (04 §10.4).
 */
export class JobImageBudget implements ImageBudget {
  private s: BudgetState;

  constructor(opts: Partial<Pick<BudgetState, 'maxImages' | 'maxTotalBytes' | 'pendingStandalone'>> = {}) {
    this.s = {
      maxImages: opts.maxImages ?? DEFAULT_IMAGE_BUDGET.maxImages,
      maxTotalBytes: opts.maxTotalBytes ?? DEFAULT_IMAGE_BUDGET.maxTotalBytes,
      usedImages: 0,
      usedBytes: 0,
      pendingStandalone: opts.pendingStandalone ?? 0,
    };
  }

  static fromState(state: BudgetState): JobImageBudget {
    const b = new JobImageBudget();
    b.s = { ...state };
    return b;
  }

  get maxImages(): number {
    return this.s.maxImages;
  }
  get maxTotalBytes(): number {
    return this.s.maxTotalBytes;
  }

  /** Announces standalone images the pipeline will extract later in this job. */
  reserveStandalone(n: number): void {
    this.s.pendingStandalone += n;
  }

  tryReserve(bytes: number, priority: BudgetPriority): boolean {
    const s = this.s;
    if (priority === 'standalone') {
      if (s.usedImages + 1 > s.maxImages || s.usedBytes + bytes > s.maxTotalBytes) return false;
      s.usedImages++;
      s.usedBytes += bytes;
      if (s.pendingStandalone > 0) s.pendingStandalone--;
      return true;
    }
    const heldImages = s.pendingStandalone;
    const heldBytes = s.pendingStandalone * STANDALONE_BYTES_ESTIMATE;
    if (s.usedImages + heldImages + 1 > s.maxImages) return false;
    if (s.usedBytes + heldBytes + bytes > s.maxTotalBytes) return false;
    s.usedImages++;
    s.usedBytes += bytes;
    return true;
  }

  snapshot(): BudgetState {
    return { ...this.s };
  }

  /** Adopts the state a worker reports after one source (sources run one at a time per job). */
  apply(state: BudgetState): void {
    this.s = { ...state };
  }
}

// ---- §7.2 tall screenshots ----

export interface TilePlan {
  tiles: Array<{ y: number; height: number }>;
  dropped: number;
}

/** Tiles of height 1.4 × width with 5% overlap, at most 6; null when the aspect is within maxAspect. */
export function planTiles(width: number, height: number, maxAspect: number, maxTiles = 6): TilePlan | null {
  if (width <= 0 || height / width <= maxAspect) return null;
  const tileH = Math.round(1.4 * width);
  const step = Math.max(1, Math.round(tileH * 0.95));
  const all: Array<{ y: number; height: number }> = [];
  for (let y = 0; y < height; y += step) {
    all.push({ y, height: Math.min(tileH, height - y) });
    if (y + tileH >= height) break;
  }
  return { tiles: all.slice(0, maxTiles), dropped: Math.max(0, all.length - maxTiles) };
}

// ---- §7.1 sips pre-conversion for HEIC/TIFF ----

/** Runs `/usr/bin/sips` (no shell); injectable for tests. Resolves with the JPEG bytes. */
export type SipsConverter = (bytes: Uint8Array, ext: 'heic' | 'tiff', signal: AbortSignal) => Promise<Uint8Array>;

export const sipsConvert: SipsConverter = async (bytes, ext, signal) => {
  // 04 §7.1 puts the temp files under the job staging dir; ExtractContext has no staging dir, so
  // a private temp dir is used and always removed.
  const dir = await mkdtemp(join(tmpdir(), 'eli5-sips-'));
  try {
    const input = join(dir, `in.${ext}`);
    const output = join(dir, 'out.jpg');
    await writeFile(input, bytes);
    await new Promise<void>((resolve, reject) => {
      execFile(
        '/usr/bin/sips',
        ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', input, '--out', output],
        { timeout: EXTRACT_TIMEOUTS_MS.sips, signal, windowsHide: true },
        (err) => (err ? reject(new ExtractError('corrupt', 'sips failed')) : resolve()),
      );
    });
    try {
      return new Uint8Array(await readFile(output));
    } catch {
      throw new ExtractError('corrupt', 'sips produced no output');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

// ---- ids ----

/** "<sourceHash8>-img-<n>" (04 §2). */
export function imageIdGen(source: Pick<ResolvedSource, 'sha256' | 'id'>): () => string {
  const hash8 = (source.sha256 || createHash('sha256').update(source.id).digest('hex')).slice(0, 8);
  let n = 0;
  return () => `${hash8}-img-${++n}`;
}

/** Normalizes bytes (with sips first for HEIC/TIFF) and re-ids the assets for this source. */
async function normalizeFor(
  bytes: Uint8Array,
  header: ImageHeader,
  origin: ImageBlock['origin'],
  ctx: ExtractContext,
  sips: SipsConverter,
): Promise<{ ok: true; assets: ImageAsset[] } | { ok: false; code: 'image-too-large' | 'corrupt' }> {
  let input = bytes;
  let mediaType = header.kind === 'emf' || header.kind === 'wmf' ? '' : MEDIA_TYPE[header.kind];
  if (header.kind === 'heic' || header.kind === 'tiff') {
    input = await sips(bytes, header.kind, ctx.signal);
    mediaType = 'image/jpeg';
  }
  return ctx.normalizeImage(input, mediaType, { origin, signal: ctx.signal });
}

// ---- §7.3 embedded images (pptx, docx) ----

export interface EmbeddedCandidate {
  /** Placeholder key the extractor put in its block tree. */
  key: string;
  bytes: Uint8Array;
  alt?: string;
  /** Slide number (pptx); undefined for docx. */
  pageOrSlide?: number;
  /** Text characters on the same slide or page (diagram slides rank first). */
  containerChars: number;
}

export interface EmbeddedOutcome {
  /** Replacement blocks for each candidate key (ImageBlocks or an "[image omitted]" paragraph). */
  blocks: Map<string, ContentBlock[]>;
  images: ImageAsset[];
  kept: number;
  dropped: number;
  warnings: string[];
}

export function omittedParagraph(alt: string | undefined): ParagraphBlock {
  return { kind: 'paragraph', text: `[image omitted: ${alt?.trim() || 'figure'}]` };
}

export async function processEmbeddedImages(
  cands: readonly EmbeddedCandidate[],
  ctx: ExtractContext,
  nextId: () => string,
  sips: SipsConverter = sipsConvert,
): Promise<EmbeddedOutcome> {
  const out: EmbeddedOutcome = { blocks: new Map(), images: [], kept: 0, dropped: 0, warnings: [] };
  const drop = (c: EmbeddedCandidate): void => {
    out.blocks.set(c.key, [omittedParagraph(c.alt)]);
    out.dropped++;
  };
  let vector = 0;
  let budgetDrops = 0;
  const hashCount = new Map<string, number>();
  const hashes = cands.map((c) => createHash('sha1').update(c.bytes).digest('hex'));
  for (const h of hashes) hashCount.set(h, (hashCount.get(h) ?? 0) + 1);

  const eligible: Array<{ c: EmbeddedCandidate; h: ImageHeader; order: number }> = [];
  cands.forEach((c, order) => {
    const h = readImageHeader(c.bytes);
    if (h && (h.kind === 'emf' || h.kind === 'wmf')) {
      vector++;
      return drop(c);
    }
    if (!h || h.width < 64 || h.height < 64) return drop(c);
    if ((hashCount.get(hashes[order]!) ?? 0) > 2) return drop(c); // logos, template art
    if (c.bytes.byteLength > ctx.limits.images.maxInputBytes) return drop(c);
    if (h.width * h.height > ctx.limits.images.maxInputPixels) return drop(c);
    eligible.push({ c, h, order });
  });

  eligible.sort((a, b) => {
    const da = a.c.containerChars < 80 ? 0 : 1;
    const db = b.c.containerChars < 80 ? 0 : 1;
    if (da !== db) return da - db;
    const area = b.h.width * b.h.height - a.h.width * a.h.height;
    return area !== 0 ? area : a.order - b.order;
  });

  const limit = ctx.limits.embeddedImagesPerSource;
  const processed: Array<{ order: number; key: string; blocks: ContentBlock[]; assets: ImageAsset[] }> = [];
  for (const [rank, e] of eligible.entries()) {
    if (rank >= limit || ctx.signal.aborted) {
      drop(e.c);
      continue;
    }
    let res: Awaited<ReturnType<typeof normalizeFor>>;
    try {
      res = await normalizeFor(e.c.bytes, e.h, 'embedded', ctx, sips);
    } catch {
      drop(e.c);
      continue;
    }
    if (!res.ok || res.assets.length === 0) {
      drop(e.c);
      continue;
    }
    const assets: ImageAsset[] = [];
    for (const a of res.assets) {
      if (!ctx.imageBudget.tryReserve(a.byteLength, 'embedded')) break;
      assets.push({
        ...a,
        id: '',
        origin: 'embedded',
        ...(e.c.pageOrSlide !== undefined ? { pageOrSlide: e.c.pageOrSlide } : {}),
      });
    }
    if (assets.length === 0) {
      budgetDrops++;
      drop(e.c);
      continue;
    }
    processed.push({ order: e.order, key: e.c.key, blocks: [], assets });
    out.kept++;
  }
  // Ids are assigned in document order so output is stable regardless of ranking.
  processed.sort((a, b) => a.order - b.order);
  for (const p of processed) {
    const n = p.assets.length;
    const alt = cands[p.order]?.alt?.trim();
    p.assets.forEach((a, k) => {
      a.id = nextId();
      out.images.push(a);
      const partAlt = n > 1 ? `${alt ? `${alt}, ` : ''}part ${k + 1} of ${n}` : alt;
      p.blocks.push({ kind: 'image', imageId: a.id, origin: 'embedded', ...(partAlt ? { alt: partAlt } : {}) });
    });
    out.blocks.set(p.key, p.blocks);
  }
  if (vector) out.warnings.push(`${plural(vector, 'embedded vector image')} (EMF/WMF) omitted`);
  if (budgetDrops) out.warnings.push(`${plural(budgetDrops, 'embedded image')} dropped: job image budget reached`);
  return out;
}

// ---- §7.5 standalone image extractor ----

const IMAGE_SOURCE_FORMATS: readonly SourceFormat[] = ['png', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'tiff'];

export function createImageExtractor(deps: { sips?: SipsConverter } = {}): Extractor {
  const sips = deps.sips ?? sipsConvert;
  return {
    id: 'image',
    formats: IMAGE_SOURCE_FORMATS,
    canHandle: (s) => IMAGE_SOURCE_FORMATS.includes(s.format),
    async extract(source: ResolvedSource, ctx: ExtractContext): Promise<ExtractResult> {
      const bytes = await readSourceBytes(source);
      if (bytes.byteLength > ctx.limits.images.maxInputBytes) return skip(source, 'image-too-large');
      const header = readImageHeader(bytes);
      if (!header || header.kind === 'emf' || header.kind === 'wmf' || header.width <= 0 || header.height <= 0) {
        return skip(source, 'corrupt');
      }
      // Decompression-bomb guard from the header alone, before any decode (§7.1 step 1).
      if (header.width * header.height > ctx.limits.images.maxInputPixels) return skip(source, 'image-too-large');
      const res = await normalizeFor(bytes, header, 'standalone', ctx, sips);
      if (!res.ok) return skip(source, res.code);
      if (res.assets.length === 0) return skip(source, 'corrupt');

      const warnings: string[] = [];
      const plan = planTiles(header.width, header.height, ctx.limits.images.maxAspect);
      if (plan?.dropped) warnings.push(`Tall image: ${plural(plan.dropped, 'part')} past the first 6 not sent`);

      const nextId = imageIdGen(source);
      const images: ImageAsset[] = [];
      const blocks: ImageBlock[] = [];
      const n = res.assets.length;
      for (const [k, a] of res.assets.entries()) {
        if (!ctx.imageBudget.tryReserve(a.byteLength, 'standalone')) {
          if (images.length === 0)
            return skip(source, 'image-budget-exceeded', { maxImages: ctx.imageBudget.maxImages });
          warnings.push(`${plural(n - k, 'image part')} dropped: job image budget reached`);
          break;
        }
        const id = nextId();
        images.push({ ...a, id, origin: 'standalone' });
        blocks.push({
          kind: 'image',
          imageId: id,
          origin: 'standalone',
          ...(n > 1 ? { alt: `part ${k + 1} of ${n}` } : {}),
        });
      }
      const content = newContent(source, { blocks, images, warnings });
      content.stats.imagesKept = images.length;
      content.stats.imagesDropped = n - images.length;
      return { ok: true, content };
    },
  };
}
