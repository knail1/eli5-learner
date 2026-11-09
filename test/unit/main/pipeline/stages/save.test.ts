/**
 * The saving stage's rebuild branch (design §5, D19-D20): a rebuild job regenerates an existing
 * document and saves it as a new version of the same document, never a new one. Real JobQueue,
 * stages and library (harness), FakeProvider. Offline.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from '../../../../../src/main/document';
import type { DocumentMeta, SectionId } from '../../../../../src/main/library';
import { snapshotOf, type Job, type RebuildTarget } from '../../../../../src/main/pipeline';
import { SeededIdSource } from '../../../../helpers/ids';
import { fileInput, harness, type Harness } from '../harness';

const opts = { clarifyingInput: '', glossary: true };
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const sectionIds = (html: string): string[] =>
  parseDocument(html).model.tabs.flatMap((t) => t.sections.map((s) => s.id));

const TS = '2026-03-01T00:00:00.000Z';

/** A finished create job, then asks, merges and publications added the way 08-10 would. */
async function created(h: Harness): Promise<{ slug: string; meta: DocumentMeta; html: string }> {
  const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
  const job = await h.finished(jobId);
  const slug = job.result?.topicSlug ?? '';
  const html0 = await readFile(h.lib.docPath(slug), 'utf8');
  const firstSection = (sectionIds(html0)[0] ?? '') as SectionId;
  await h.lib.withDocLock(slug, () =>
    h.lib.updateDocument(slug, {
      meta: (m) => ({
        ...m,
        retiredIds: ['sec-indepth-0badc0de' as SectionId],
        asks: [
          { at: TS, sectionId: firstSection, tabKey: 'indepth', question: 'Why?', qaId: 'q-0a1b2c3d', jobId: 'j9' },
        ],
        actions: [{ at: TS, action: 'expand', sectionId: firstSection, tabKey: 'indepth', jobId: 'j8' }],
        merges: [
          {
            suggestionId: 's1',
            sourceDocId: 'other',
            sourceTitle: 'Other',
            sourceSlug: 'other',
            sourceSummary: 'x',
            mergedAt: TS,
            anchorSectionIds: [firstSection],
          },
        ],
        publications: [
          { targetId: 'local', kind: 'local', publishedAt: TS, primaryUrl: 'file:///tmp/x', contentSha256: sha('x') },
        ],
      }),
    }),
  );
  const meta = JSON.parse(await readFile(h.lib.docPath(slug, 'meta.json'), 'utf8')) as DocumentMeta;
  return { slug, meta, html: await readFile(h.lib.docPath(slug), 'utf8') };
}

/** Replays the same id stream after reset(), so only the reserved set can stop a collision. */
class ReplayIdSource {
  private src = new SeededIdSource(5);
  reset(): void {
    this.src = new SeededIdSource(5);
  }
  hex(chars: number): string {
    return this.src.hex(chars);
  }
}

async function target(h: Harness, slug: string, over: Partial<RebuildTarget> = {}): Promise<RebuildTarget> {
  const view = await h.lib.versions(slug);
  return {
    slug,
    docId: (await h.lib.getMeta(slug)).id,
    baseVersionId: view.tree.currentId,
    baseHtmlSha256: sha(await readFile(h.lib.docPath(slug))),
    promptSet: 'default',
    ...over,
  };
}

async function rebuild(h: Harness, t: RebuildTarget): Promise<Job> {
  const { jobId } = await h.queue.startRebuild({ inputs: [fileInput('sources/text/notes.md')], options: opts }, t);
  return h.finished(jobId);
}

// Real queue, stages and library per test: allow for a loaded machine (the full suite runs in parallel).
describe('saving a rebuild as a new version (design §5)', { timeout: 20_000 }, () => {
  it('keeps id, slug, createdAt, merges and publications; drops asks and actions; no merge check', async () => {
    const h = await harness();
    const before = await created(h);
    const entryBefore = h.lib.getEntry(before.slug);
    const checksBefore = [...h.mergeChecks];
    const t = await target(h, before.slug);
    const job = await rebuild(h, t);

    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ docId: before.meta.id, topicSlug: before.slug });
    expect(h.mergeChecks).toEqual(checksBefore);
    expect(h.lib.list()).toHaveLength(1);
    expect(h.lib.getEntry(before.slug)).toMatchObject({ id: entryBefore?.id, createdAt: entryBefore?.createdAt });

    const after = JSON.parse(await readFile(h.lib.docPath(before.slug, 'meta.json'), 'utf8')) as DocumentMeta;
    expect(after).toMatchObject({
      id: before.meta.id,
      topicSlug: before.slug,
      createdAt: before.meta.createdAt,
      merges: before.meta.merges,
      publications: before.meta.publications,
      glossaryEnabled: before.meta.glossaryEnabled,
      clarifyingInput: before.meta.clarifyingInput,
    });
    expect(after.asks ?? []).toEqual([]);
    expect(after.actions ?? []).toEqual([]);
    expect(after.tabs.map((x) => x.key)).toEqual(['indepth', 'eli5', 'ste']);
    expect(after.generation.promptSet).toBe('default');

    // retiredIds: the old ones plus every section ID of the version it replaced; none is re-minted.
    const oldIds = sectionIds(before.html);
    expect(after.retiredIds).toEqual(expect.arrayContaining(['sec-indepth-0badc0de', ...oldIds]));
    const html = await readFile(h.lib.docPath(before.slug), 'utf8');
    const newIds = sectionIds(html);
    expect(newIds.filter((id) => oldIds.includes(id) || id === 'sec-indepth-0badc0de')).toEqual([]);
    // The model keeps the document's id and original date.
    const model = parseDocument(html).model;
    expect(model.docId).toBe(before.meta.id);
    expect(model.createdAt).toBe(before.meta.createdAt);

    // Rebuild report kept on the job for the driver's summary.
    expect(job.rebuild?.report).toMatchObject({ eli5Critique: expect.any(String) as string });
    expect(job.rebuild?.report?.steLint).toMatchObject({ sentences: expect.any(Number) as number });
  });

  it('never re-mints a live id or an id an older version retired, even from a replayed id stream (audit round 3)', async () => {
    const ids = new ReplayIdSource();
    let stripLiveRetired = false;
    const h = await harness({
      deps: { sectionIds: ids },
      libraryOver: (lib) => ({
        getMeta: async (slug) => {
          const m = await lib.getMeta(slug);
          return stripLiveRetired ? { ...m, retiredIds: [] } : m;
        },
      }),
    });
    const before = await created(h);
    const createIds = sectionIds(before.html);

    // Rebuild 1 replays the create's stream: the live ids are reserved, so none comes back.
    ids.reset();
    const first = await rebuild(h, await target(h, before.slug));
    expect(first.status).toBe('done');
    const firstIds = sectionIds(await readFile(h.lib.docPath(before.slug), 'utf8'));
    expect(firstIds.filter((id) => createIds.includes(id))).toEqual([]);

    // Rebuild 2 replays it again with the live retiredIds hidden: only the versions' own retiredIds
    // (which name the create's ids) stop the create's ids from coming back.
    ids.reset();
    stripLiveRetired = true;
    const second = await rebuild(h, await target(h, before.slug));
    expect(second.status).toBe('done');
    const secondIds = sectionIds(await readFile(h.lib.docPath(before.slug), 'utf8'));
    expect(secondIds.filter((id) => createIds.includes(id) || firstIds.includes(id))).toEqual([]);
  });

  it('a rebuild whose STE draft builds to no tab reports no STE lint and no ste prompt (audit round 3)', async () => {
    let emptySte = false;
    const h = await harness({
      tasks: (t) => ({
        ...t,
        generateSte: async (...a) => {
          const r = await t.generateSte(...a);
          if (!emptySte) return r;
          const sections = [{ heading: 'Empty', blocks: [{ type: 'paragraph' as const, md: '   ' }] }];
          return { ...r, draft: { ...r.draft, tab: { ...r.draft.tab, sections }, origins: [[null]] } };
        },
      }),
    });
    const before = await created(h);
    emptySte = true;
    const job = await rebuild(h, await target(h, before.slug));
    expect(job.status).toBe('done');
    expect(job.rebuild?.report?.steLint).toBeNull();
    const after = JSON.parse(await readFile(h.lib.docPath(before.slug, 'meta.json'), 'utf8')) as DocumentMeta;
    expect(after.tabs.map((x) => x.key)).toEqual(['indepth', 'eli5']);
    expect(after.generation.prompts.some((p) => p.startsWith('ste@'))).toBe(false);
  });

  it('seeds the initial node for an unversioned document and makes the rebuild its child (kind outside, Rebuilt label)', async () => {
    const h = await harness();
    const before = await created(h);
    const t = await target(h, before.slug);
    const job = await rebuild(h, t);
    const view = await h.lib.versions(before.slug);
    const current = view.tree.nodes.find((n) => n.id === view.tree.currentId);
    const parent = view.tree.nodes.find((n) => n.id === current?.parentId);
    expect(current).toMatchObject({ kind: 'outside', topic: 'Rebuilt (default)', jobId: job.id });
    expect(current?.label).toMatch(/^Rebuilt with prompt set default \([0-9a-f]{8}\)$/);
    const after = JSON.parse(await readFile(h.lib.docPath(before.slug, 'meta.json'), 'utf8')) as DocumentMeta;
    expect(current?.label).toBe(`Rebuilt with prompt set default (${after.generation.promptDigest?.slice(0, 8)})`);
    expect(parent).toMatchObject({ id: t.baseVersionId, kind: 'initial', parentId: null });
    const old = await h.lib.readVersion(before.slug, parent?.id ?? '');
    expect(sha(old.html)).toBe(t.baseHtmlSha256);
  });

  it('a second rebuild hangs off the first (parent is the captured base version)', async () => {
    const h = await harness();
    const before = await created(h);
    await rebuild(h, await target(h, before.slug));
    const t2 = await target(h, before.slug);
    const job = await rebuild(h, t2);
    expect(job.status).toBe('done');
    const view = await h.lib.versions(before.slug);
    const current = view.tree.nodes.find((n) => n.id === view.tree.currentId);
    expect(current?.parentId).toBe(t2.baseVersionId);
  });

  it('aborts without writing when the base moved (other version or other html)', async () => {
    const h = await harness();
    const before = await created(h);
    for (const over of [{ baseHtmlSha256: sha('something else') }, { baseVersionId: 'v-000000000000' }]) {
      const job = await rebuild(h, await target(h, before.slug, over));
      expect(job.status).toBe('failed');
      expect(job.failure).toMatchObject({ code: 'SAVE_FAILED', detail: 'REBUILD_BASE_MOVED' });
      expect(await readFile(h.lib.docPath(before.slug), 'utf8')).toBe(before.html);
    }
    expect(h.lib.list()).toHaveLength(1);
  });

  it('refuses a document whose id does not match the target', async () => {
    const h = await harness();
    const before = await created(h);
    const job = await rebuild(h, await target(h, before.slug, { docId: '00000000-0000-4000-8000-00000000ffff' }));
    expect(job.status).toBe('failed');
    expect(job.failure?.code).toBe('SAVE_FAILED');
    expect(await readFile(h.lib.docPath(before.slug), 'utf8')).toBe(before.html);
  });

  it('startRebuild refuses a read-only library and an unknown slug', async () => {
    const ro = await harness({ libraryOver: { readOnly: true } });
    await expect(
      ro.queue.startRebuild(
        { inputs: [fileInput('sources/text/notes.md')], options: opts },
        { slug: 'x', docId: 'd', baseVersionId: null, baseHtmlSha256: sha('x'), promptSet: 'default' },
      ),
    ).rejects.toMatchObject({ code: 'E_LIBRARY_READ_ONLY' });
    const h = await harness();
    await expect(
      h.queue.startRebuild(
        { inputs: [fileInput('sources/text/notes.md')], options: opts },
        { slug: 'not-there', docId: 'd', baseVersionId: null, baseHtmlSha256: sha('x'), promptSet: 'default' },
      ),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });

  it('persists job.rebuild and, after a crash past the commit, finishes done without a second version', async () => {
    const a = await harness();
    const before = await created(a);
    const job = await rebuild(a, await target(a, before.slug));
    const nodes = (await a.lib.versions(before.slug)).tree.nodes.length;
    // Rewind the record to "saving": the commit happened, the done transition did not.
    const rec = { ...job, status: 'saving', checkpoint: { ...job.checkpoint, stage: 'saving' } };
    delete (rec as Partial<Job>).result;
    delete (rec as Partial<Job>).finishedAt;
    await writeFile(path.join(a.userData, 'jobs', `${job.id}.json`), JSON.stringify(rec));
    const b = await harness({ from: a });
    const resumed = await b.finished(job.id);
    expect(resumed.status).toBe('done');
    expect(resumed.rebuild).toMatchObject({ slug: before.slug, docId: before.meta.id });
    expect(resumed.result).toMatchObject({ topicSlug: before.slug, docId: before.meta.id });
    expect((await b.lib.versions(before.slug)).tree.nodes).toHaveLength(nodes);
    expect(b.fake.calls).toEqual([]);
  });

  it('finishes done after a crash past the commit even when a later checkout moved the current version', async () => {
    const a = await harness();
    const before = await created(a);
    const t = await target(a, before.slug);
    const job = await rebuild(a, t);
    const meta = await a.lib.getMeta(before.slug);
    await a.lib.withDocLock(before.slug, () =>
      a.lib.checkout(before.slug, t.baseVersionId ?? '', { retiredIds: meta.retiredIds }),
    );
    const nodes = (await a.lib.versions(before.slug)).tree.nodes.length;
    const rec = { ...job, status: 'saving', checkpoint: { ...job.checkpoint, stage: 'saving' } };
    delete (rec as Partial<Job>).result;
    delete (rec as Partial<Job>).finishedAt;
    await writeFile(path.join(a.userData, 'jobs', `${job.id}.json`), JSON.stringify(rec));
    const b = await harness({ from: a });
    const resumed = await b.finished(job.id);
    expect(resumed.status).toBe('done');
    expect((await b.lib.versions(before.slug)).tree.nodes).toHaveLength(nodes);
    expect(b.fake.calls).toEqual([]);
  });

  it.each(['generating', 'queued'] as const)(
    'never resumes a rebuild interrupted while %s: it fails INTERRUPTED with no call and no write',
    async (status) => {
      const a = await harness();
      const before = await created(a);
      const job = await rebuild(a, await target(a, before.slug));
      const nodes = (await a.lib.versions(before.slug)).tree.nodes.length;
      const html = await readFile(a.lib.docPath(before.slug));
      // A second rebuild job's record as a crash would leave it (no commit happened).
      const rec = { ...job, id: `${job.id.slice(0, -1)}Z`, status, resuming: status === 'generating' };
      delete (rec as Partial<Job>).result;
      delete (rec as Partial<Job>).finishedAt;
      await writeFile(path.join(a.userData, 'jobs', `${rec.id}.json`), JSON.stringify(rec));
      const b = await harness({ from: a });
      const out = await b.finished(rec.id);
      expect(out.status).toBe('failed');
      expect(out.failure).toMatchObject({ code: 'INTERRUPTED', detail: 'rebuild-not-resumed' });
      expect(b.fake.calls).toEqual([]);
      expect((await b.lib.versions(before.slug)).tree.nodes).toHaveLength(nodes);
      expect(await readFile(b.lib.docPath(before.slug))).toEqual(html);
    },
  );

  it('never retries a failed rebuild from the queue: no Retry button, E_CONFLICT, no call', async () => {
    const a = await harness();
    const before = await created(a);
    const job = await rebuild(a, await target(a, before.slug));
    const rec = { ...job, id: `${job.id.slice(0, -1)}Y`, status: 'generating', resuming: true };
    delete (rec as Partial<Job>).result;
    delete (rec as Partial<Job>).finishedAt;
    await writeFile(path.join(a.userData, 'jobs', `${rec.id}.json`), JSON.stringify(rec));
    const b = await harness({ from: a });
    const out = await b.finished(rec.id);
    expect(out.failure?.code).toBe('INTERRUPTED');
    expect(snapshotOf(out, {}).canRetry).toBe(false);
    const calls = b.fake.calls.length;
    await expect(b.queue.retry(rec.id as Job['id'])).rejects.toMatchObject({ code: 'E_CONFLICT' });
    await b.queue.idle();
    expect(b.queue.get(rec.id as Job['id'])?.status).toBe('failed');
    expect(b.fake.calls).toHaveLength(calls);
  });

  it('a headless session holds leftover normal jobs: no recovery, no call, record untouched', async () => {
    const a = await harness();
    const { jobId } = await a.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    const done = await a.finished(jobId);
    const rec = { ...done, id: `${done.id.slice(0, -1)}X`, status: 'queued' };
    delete (rec as Partial<Job>).result;
    delete (rec as Partial<Job>).finishedAt;
    const file = path.join(a.userData, 'jobs', `${rec.id}.json`);
    await writeFile(file, JSON.stringify(rec));
    const raw = await readFile(file, 'utf8');
    const b = await harness({ from: a, init: false });
    await b.queue.init({ holdLeftovers: true });
    await b.queue.idle();
    expect(b.fake.calls).toEqual([]);
    expect(b.queue.get(rec.id as Job['id'])?.status).toBe('queued');
    await b.queue.close();
    expect(await readFile(file, 'utf8')).toBe(raw);
    // The next normal launch recovers and runs it (its copied record has no snapshots left, so it
    // ends at reading; what matters is that it is no longer held).
    const c = await harness({ from: a });
    const out = await c.finished(rec.id);
    expect(out.failure?.code).toBe('NO_USABLE_CONTENT');
  });
});
