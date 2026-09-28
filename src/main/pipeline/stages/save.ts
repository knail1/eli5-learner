// Saving stage (06 §5.5, §5.7): build and render the document, stage it, commit through the library.
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  bundledDocRuntime,
  buildDocumentModel,
  checkDocumentHtml,
  renderDocument,
  type DocumentModel,
} from '../../document';
import {
  LibraryError,
  META_SCHEMA_VERSION,
  STAGING_DIR,
  type CatalogEntry,
  type DocumentMeta,
  type SourceRecord,
  type TabRecord,
} from '../../library';
import { deserializePrepared, type PreparedContentJson } from '../../llm';
import type { ResolvedSource } from '../../sources';
import { PipelineFailure } from '../errors';
import type { Job, JobWarning } from '../types';
import { addWarning, throwIfAborted, type StageContext } from './context';
import {
  GEN,
  decodePhotos,
  loadContents,
  type DocumentStepOutput,
  type GlossaryStepOutput,
  type PhotosStepOutput,
  type SummaryStepOutput,
} from './generate';

/** 06 §5.7: saving failures get one retry after 2 s. */
export const SAVE_RETRY_DELAY_MS = 2000;

/** `<library-root>/.staging/<jobId>/` (06 §5.7 step 2). */
export function libraryStagingDir(root: string, jobId: string): string {
  return path.join(root, STAGING_DIR, jobId);
}

function sourceKind(r: ResolvedSource): SourceRecord['kind'] {
  if (r.lane === 'mcp') return 'mcp';
  if (r.resolverId === 'clipboard') return 'clipboard';
  if (r.lane === 'web' || r.resolverId === 'url') return 'url';
  return 'file';
}

/** 09 §5.2 SourceRecord: display reference only; the library strips URL fragments. */
export function sourceRecord(r: ResolvedSource): SourceRecord {
  const kind = sourceKind(r);
  return {
    ref: r.ref,
    kind,
    mimeType: r.mediaType,
    ...(kind === 'file' || kind === 'clipboard' ? { sha256: r.sha256 } : {}),
  };
}

function tabRecords(model: DocumentModel, now: string): TabRecord[] {
  return model.tabs.map((t) => ({
    key: t.key,
    kind: t.kind,
    label: t.label,
    sectionCount: t.sections.length,
    createdAt: now,
  }));
}

/** 06 §5.5: in-depth title, else the first heading of the first source, else a dated fallback. */
async function chooseTitle(ctx: StageContext, doc: DocumentStepOutput, now: Date): Promise<string> {
  const t = doc.indepth.title.replace(/\s+/g, ' ').trim();
  if (t) return t;
  const first = (await loadContents(ctx).catch(() => []))[0];
  const heading = first?.title?.trim() || firstHeading(first?.blocks ?? []);
  if (heading) return heading;
  return `Untitled learning, ${now.toISOString().slice(0, 10)}`;
}

function firstHeading(blocks: readonly { kind: string; text?: string; blocks?: unknown }[]): string {
  for (const b of blocks) {
    if (b.kind === 'heading' && typeof b.text === 'string' && b.text.trim()) return b.text.trim();
    if (Array.isArray(b.blocks)) {
      const inner = firstHeading(b.blocks as { kind: string; text?: string }[]);
      if (inner) return inner;
    }
  }
  return '';
}

function uniq(xs: readonly (string | undefined)[]): string[] {
  return [...new Set(xs.filter((x): x is string => !!x))];
}

/** Skipped sources become `source-skipped` warnings in meta.json (06 §7.1). */
function skippedWarnings(job: Job): void {
  for (const s of job.skipped)
    addWarning(job, { kind: 'source-skipped', message: `${s.ref}: ${s.reason}` } satisfies JobWarning);
}

export async function saveStage(ctx: StageContext): Promise<CatalogEntry> {
  const { job, deps, store } = ctx;
  const doc = (await store.readJson(job.id, GEN.document)) as DocumentStepOutput | null;
  const summary = (await store.readJson(job.id, GEN.summary)) as SummaryStepOutput | null;
  const glossary = job.options.glossary
    ? ((await store.readJson(job.id, GEN.glossary)) as GlossaryStepOutput | null)
    : null;
  const prepJson = (await store.readJson(job.id, GEN.prepared)) as PreparedContentJson | null;
  // Optional (07 §7.4): absent when photos were off or the job predates them.
  const photosOut = (await store.readJson(job.id, GEN.photos)) as PhotosStepOutput | null;
  const photos = decodePhotos(photosOut);
  if (!doc || !summary || !prepJson) throw new PipelineFailure('INTERNAL', 'generation-artifact-missing');
  const prep = deserializePrepared(prepJson);
  skippedWarnings(job);

  const nowDate = deps.clock.now();
  const now = nowDate.toISOString();
  const title = await chooseTitle(ctx, doc, nowDate);
  // §5.5: when the summary fell back, the hint is omitted and 09 slugifies the title.
  const hint = summary.source === 'llm' ? summary.topicSlugHint : undefined;
  const docId = deps.ids.docId();
  const { theme, source: themeSource } = deps.docTheme();
  const runtime = deps.docRuntime ?? bundledDocRuntime();
  const lib = deps.library;
  const stagingDir = libraryStagingDir(lib.root, job.id);

  const render = (slug: string): { html: string; meta: DocumentMeta } => {
    const built = buildDocumentModel({
      docId,
      slug,
      now,
      indepth: { ...doc.indepth, title },
      eli5: doc.eli5,
      glossary: glossary?.draft ?? null,
      images: prep.images.map((i) => ({ label: i.label, mime: i.mediaType, bytes: new Uint8Array(i.data) })),
      photos,
      resolved: job.resolved,
      skipped: job.skipped,
      theme,
      themeSource,
      normalizeImage: deps.normalizeImage,
      ...(deps.sectionIds ? { idSource: deps.sectionIds } : {}),
      ...(deps.referenceFormatter ? { referenceFormatter: deps.referenceFormatter } : {}),
    });
    const html = renderDocument(built.model, built.assets, { runtime, theme });
    const meta: DocumentMeta = {
      schemaVersion: META_SCHEMA_VERSION,
      id: docId,
      topicSlug: slug,
      title: built.model.title,
      summary: summary.summary,
      summarySource: summary.source,
      createdAt: now,
      updatedAt: now,
      jobId: job.id,
      edition: deps.edition,
      clarifyingInput: job.options.clarifyingInput,
      glossaryEnabled: job.options.glossary,
      sourcesUsed: job.resolved.map(sourceRecord),
      sourcesSkipped: job.skipped,
      tabs: tabRecords(built.model, now),
      retiredIds: [],
      generation: {
        provider: doc.provider.id,
        model: doc.provider.model,
        prompts: uniq([...prep.prompts, ...doc.prompts, glossary?.prompt, summary.prompt, photosOut?.prompt]),
      },
      warnings: job.warnings,
      merges: [],
      publications: [],
    };
    // Writers run the validity checks before every save (13 §7); a failure is a programming error.
    const report = checkDocumentHtml(html, meta);
    if (!report.ok) {
      throw new PipelineFailure('INTERNAL', `validity:${[...new Set(report.errors.map((e) => e.rule))].join(',')}`);
    }
    return { html, meta };
  };

  const reserve = async (): Promise<void> => {
    ctx.reservation = await lib.allocateSlug(title, hint);
    job.checkpoint = {
      ...(job.checkpoint ?? { resolvedRefs: [], extractedIndexes: [], completedSteps: [] }),
      stage: 'saving',
      topicSlug: ctx.reservation.slug,
    };
    await ctx.persist();
  };
  await reserve();

  let slugRetried = false;
  let ioRetried = false;
  for (;;) {
    throwIfAborted(ctx.signal);
    const reservation = ctx.reservation;
    if (!reservation) throw new PipelineFailure('INTERNAL', 'no-reservation');
    const { html, meta } = render(reservation.slug);
    await rm(stagingDir, { recursive: true, force: true });
    const dir = await lib.stagingDir(job.id);
    await writeFile(path.join(dir, 'index.html'), html, { mode: 0o600 });
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
    throwIfAborted(ctx.signal);
    try {
      ctx.setCommitStarted(true);
      const entry = await lib.commitDocument(reservation, dir, meta);
      ctx.reservation = undefined; // released by the library on success (09 §8.2 step 5)
      return entry;
    } catch (err) {
      ctx.setCommitStarted(false);
      throwIfAborted(ctx.signal);
      if (err instanceof LibraryError && err.code === 'SLUG_TAKEN' && !slugRetried) {
        // 09 §8.2 step 2: re-allocate once.
        slugRetried = true;
        reservation.release();
        await reserve();
        continue;
      }
      if (!ioRetried) {
        ioRetried = true;
        deps.log.warn('pipeline.save-retry', { jobId: job.id, code: err instanceof LibraryError ? err.code : 'io' });
        await deps.sleep(SAVE_RETRY_DELAY_MS);
        continue;
      }
      throw new PipelineFailure('SAVE_FAILED', err instanceof LibraryError ? `library:${err.code}` : 'io');
    }
  }
}
