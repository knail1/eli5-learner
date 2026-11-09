// Saving stage (06 §5.5, §5.7): build and render the document, stage it, commit through the library.
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  bundledDocRuntime,
  buildDocumentModel,
  checkDocumentHtml,
  INDEPTH_TAB_KEY,
  parseDocument,
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
import type { Job, JobWarning, PipelineLibrary, RebuildTarget } from '../types';
import { addWarning, throwIfAborted, type StageContext } from './context';
import {
  GEN,
  decodePhotos,
  finalEli5,
  loadContents,
  stepWarning,
  type DocumentStepOutput,
  type Eli5CritiqueStepOutput,
  type GlossaryStepOutput,
  type PhotosStepOutput,
  type SteStepOutput,
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
  // Step 1b (06 §5.4): absent in jobs that predate it, or when the steps failed.
  const steOut = (await store.readJson(job.id, GEN.ste)) as SteStepOutput | null;
  const critique = (await store.readJson(job.id, GEN.eli5Critique)) as Eli5CritiqueStepOutput | null;
  if (!doc || !summary || !prepJson) throw new PipelineFailure('INTERNAL', 'generation-artifact-missing');
  const prep = deserializePrepared(prepJson);
  skippedWarnings(job);

  const nowDate = deps.clock.now();
  const now = nowDate.toISOString();
  const title = await chooseTitle(ctx, doc, nowDate);
  // §5.5: when the summary fell back, the hint is omitted and 09 slugifies the title.
  const hint = summary.source === 'llm' ? summary.topicSlugHint : undefined;
  const docId = job.rebuild ? job.rebuild.docId : deps.ids.docId();
  const { theme, source: themeSource } = deps.docTheme();
  const runtime = deps.docRuntime ?? bundledDocRuntime();
  const lib = deps.library;
  const stagingDir = libraryStagingDir(lib.root, job.id);

  const ste = steOut?.ste ?? null;
  const eli5 = finalEli5(doc, critique);
  // Tags of the prompts whose output the document uses (a rejected critique is not one).
  const prompts = uniq([
    ...prep.prompts,
    ...doc.prompts,
    ste ? steOut?.prompt : undefined,
    critique?.eli5 ? critique.prompt : undefined,
    glossary?.prompt,
    summary.prompt,
    photosOut?.prompt,
  ]);
  const build = (o: {
    docId: string;
    slug: string;
    createdAt?: string;
    reservedIds?: Iterable<string>;
  }): { html: string; tabs: TabRecord[]; title: string } => {
    const built = buildDocumentModel({
      docId: o.docId,
      slug: o.slug,
      now,
      ...(o.createdAt !== undefined ? { createdAt: o.createdAt } : {}),
      ...(o.reservedIds !== undefined ? { reservedIds: o.reservedIds } : {}),
      indepth: { ...doc.indepth, title },
      eli5,
      ste: ste ? { tab: ste.tab, origins: ste.origins } : null,
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
    // An STE draft that converted to no sections leaves no tab (07 §5): say so like a failed step.
    if (ste && !built.model.tabs.some((t) => t.kind === 'ste')) addWarning(job, stepWarning('ste-omitted'));
    const html = renderDocument(built.model, built.assets, { runtime, theme });
    return { html, tabs: tabRecords(built.model, now), title: built.model.title };
  };
  const generation = (): DocumentMeta['generation'] => ({
    provider: doc.provider.id,
    model: doc.provider.model,
    prompts,
    ...(deps.promptProvenance ? deps.promptProvenance(prompts) : {}),
  });
  /** Writers run the validity checks before every save (13 §7); a failure is a programming error. */
  const assertValid = (html: string, meta: DocumentMeta): void => {
    const report = checkDocumentHtml(html, meta);
    if (!report.ok) {
      throw new PipelineFailure('INTERNAL', `validity:${[...new Set(report.errors.map((e) => e.rule))].join(',')}`);
    }
  };

  if (job.rebuild) {
    job.rebuild.report = {
      steLint: ste ? { ...ste.lint.final } : null,
      eli5Critique: critique?.outcome ?? null,
    };
    return saveRebuild(ctx, job.rebuild, { build, generation, assertValid, summary });
  }

  const render = (slug: string): { html: string; meta: DocumentMeta } => {
    const built = build({ docId, slug });
    const meta: DocumentMeta = {
      schemaVersion: META_SCHEMA_VERSION,
      id: docId,
      topicSlug: slug,
      title: built.title,
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
      tabs: built.tabs,
      retiredIds: [],
      generation: generation(),
      warnings: job.warnings,
      merges: [],
      publications: [],
    };
    assertValid(built.html, meta);
    return { html: built.html, meta };
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

// ---- rebuild (design §5, D19-D20) ----

/** "Rebuilt with prompt set <set> (<digest8>)": the version label History shows for a rebuild. */
export function rebuildLabel(promptSet: string, promptDigest: string | undefined): string {
  return `Rebuilt with prompt set ${promptSet} (${(promptDigest ?? '').slice(0, 8) || 'unknown'})`;
}

const sha256Hex = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

/** Section IDs of a stored document; none when it cannot be parsed (it is then replaced whole). */
function liveSectionIds(html: string): string[] {
  try {
    return parseDocument(html).model.tabs.flatMap((t) => t.sections.map((s) => s.id));
  } catch {
    return [];
  }
}

/**
 * The rebuild by `jobId` already committed (design §5 step 5): a version node carries the job's id
 * (normally the current one; a later edit may have moved past it). Returns the catalog entry, else
 * undefined.
 */
export async function rebuildCommitted(
  lib: Pick<PipelineLibrary, 'versions' | 'getEntry' | 'hasSlug'>,
  slug: string,
  jobId: string,
): Promise<CatalogEntry | undefined> {
  if (!lib.hasSlug(slug)) return undefined;
  const view = await lib.versions(slug);
  if (!view.tree.nodes.some((n) => n.jobId === jobId)) return undefined;
  return lib.getEntry(slug);
}

interface RebuildParts {
  build(o: { docId: string; slug: string; createdAt?: string; reservedIds?: Iterable<string> }): {
    html: string;
    tabs: TabRecord[];
    title: string;
  };
  generation(): DocumentMeta['generation'];
  assertValid(html: string, meta: DocumentMeta): void;
  summary: SummaryStepOutput;
}

/**
 * Design §5: the regenerated document becomes a new version of the existing one through
 * library.updateDocument (kind `outside`, label "Rebuilt with prompt set ..."), under the doc lock
 * and only while the live version is still the base the driver captured. Keeps id, slug,
 * createdAt, merges and publications; drops asks and actions (they stay in older versions); every
 * section ID of the replaced version is retired. No slug allocation, no commitDocument.
 */
async function saveRebuild(ctx: StageContext, r: RebuildTarget, parts: RebuildParts): Promise<CatalogEntry> {
  const { job, deps } = ctx;
  const lib = deps.library;
  const already = await rebuildCommitted(lib, r.slug, job.id).catch(() => undefined);
  if (already) return already;
  if (!lib.hasSlug(r.slug)) throw new PipelineFailure('DOC_GONE', 'rebuild-slug-missing');
  const live = await lib.getMeta(r.slug);
  if (live.id !== r.docId) throw new PipelineFailure('SAVE_FAILED', 'REBUILD_DOC_MISMATCH');
  const liveIds = liveSectionIds(await readFile(lib.docPath(r.slug), 'utf8'));
  // IDs no new section may take: the live ones, and every ID any version retired.
  const reserved = new Set<string>([...liveIds, ...live.retiredIds]);
  const view = await lib.versions(r.slug);
  for (const n of view.tree.nodes) {
    if (!n.sha256) continue;
    const v = await lib.readVersion(r.slug, n.id).catch(() => undefined);
    for (const id of v?.meta.retiredIds ?? []) reserved.add(id);
  }

  const built = parts.build({ docId: live.id, slug: r.slug, createdAt: live.createdAt, reservedIds: reserved });
  const generation = parts.generation();
  const label = rebuildLabel(generation.promptSet ?? r.promptSet, generation.promptDigest);
  const patchMeta = (m: DocumentMeta): DocumentMeta => {
    const { asks: _asks, actions: _actions, ...rest } = m;
    return {
      ...rest,
      title: built.title,
      summary: parts.summary.summary,
      summarySource: parts.summary.source,
      sourcesUsed: job.resolved.map(sourceRecord),
      sourcesSkipped: job.skipped,
      tabs: built.tabs,
      warnings: job.warnings,
      generation,
      retiredIds: uniq([...m.retiredIds, ...liveIds]) as DocumentMeta['retiredIds'],
      asks: [],
      actions: [],
    };
  };
  parts.assertValid(built.html, patchMeta(structuredClone(live)));
  await ctx.persist(); // job.rebuild.report

  throwIfAborted(ctx.signal);
  ctx.setCommitStarted(true);
  try {
    return await lib.withDocLock(r.slug, async () => {
      const cur = await lib.versions(r.slug);
      const html = await readFile(lib.docPath(r.slug));
      const moved =
        (r.baseVersionId !== null && (cur.detached || cur.tree.currentId !== r.baseVersionId)) ||
        sha256Hex(html) !== r.baseHtmlSha256;
      if (moved) throw new PipelineFailure('SAVE_FAILED', 'REBUILD_BASE_MOVED');
      return lib.updateDocument(r.slug, {
        html: built.html,
        label,
        change: {
          kind: 'outside',
          topic: `Rebuilt (${r.promptSet})`,
          jobId: job.id,
          target: { tabKey: INDEPTH_TAB_KEY },
        },
        meta: patchMeta,
      });
    });
  } catch (err) {
    ctx.setCommitStarted(false);
    if (err instanceof PipelineFailure) throw err;
    throw new PipelineFailure('SAVE_FAILED', err instanceof LibraryError ? `library:${err.code}` : 'io');
  }
}
