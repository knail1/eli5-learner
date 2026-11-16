/**
 * The saving stage keeps each document's extracted source text in `<slug>/.sources/` (09 §4.4,
 * 06 §5.7): best effort for a new document, an upsert for a rebuild, never in the document files.
 * Real JobQueue, stages and library (harness), FakeProvider. Offline.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  SourceSidecarManifestSchema,
  defaultLibraryPolicy,
  type SourceSidecarManifest,
} from '../../../../../src/main/library';
import type { Job, RebuildTarget } from '../../../../../src/main/pipeline';
import { createLogger, MemorySink } from '../../../../../src/main/security';
import type { SourceInput } from '../../../../../src/main/sources';
import { fileInput, harness, type Harness, type HarnessOptions } from '../harness';

const CANARY = 'CANARYq7widgetledger';
const opts = { clarifyingInput: '', glossary: true };
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

let seq = 0;
/** A source file in the test's userData with the canary in its body (never in a heading). */
async function canaryInput(h: Harness, name = 'ledger.md', extra = ''): Promise<SourceInput> {
  const dir = path.join(h.userData, 'src-files');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fsp.writeFile(
    file,
    `# Widget ledger\n\nExample Widgets Inc. keeps a ledger of widget sales. ${CANARY} ${extra}\n\n- One\n- Two\n`,
  );
  return { id: `in-c${(++seq).toString(16).padStart(7, '0')}`, kind: 'file', origin: 'drop', path: file };
}

const manifestOf = async (h: Harness, slug: string): Promise<SourceSidecarManifest | undefined> => {
  const raw = await fsp
    .readFile(path.join(h.lib.root, slug, '.sources', 'manifest.json'), 'utf8')
    .catch(() => undefined);
  return raw === undefined ? undefined : SourceSidecarManifestSchema.parse(JSON.parse(raw));
};

async function run(h: Harness, inputs: SourceInput[]): Promise<Job> {
  const { jobId } = await h.queue.start({ inputs, options: opts });
  return h.finished(jobId);
}

async function withSink(o: HarnessOptions = {}): Promise<{ h: Harness; sink: MemorySink }> {
  const sink = new MemorySink();
  const h = await harness({ ...o, deps: { log: createLogger({ sink, level: () => 'debug' }), ...o.deps } });
  return { h, sink };
}

/** Every file under `dir`, gunzipped when it is a version blob. */
async function allTexts(dir: string): Promise<{ file: string; text: string }[]> {
  const out: { file: string; text: string }[] = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const file = path.join(e.parentPath, e.name);
    let buf = await fsp.readFile(file);
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
    out.push({ file, text: buf.toString('utf8') });
  }
  return out;
}

describe('a new document keeps its source text (09 §4.4)', { timeout: 20_000 }, () => {
  it('writes the sidecar from the extracted contents, and source text is nowhere else', async () => {
    const { h, sink } = await withSink();
    const job = await run(h, [await canaryInput(h), fileInput('sources/images/diagram.png')]);
    expect(job.status).toBe('done');
    const slug = job.result?.topicSlug ?? '';
    const m = await manifestOf(h, slug);
    expect(m?.sources.map((s) => [s.id, s.ref, s.kind, s.stored])).toEqual([
      ['src-01', 'ledger.md', 'file', 'text'],
      ['src-02', 'diagram.png', 'file', 'image'],
    ]);
    expect(m?.sources[0]?.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    const sc = await h.lib.readSources(slug);
    expect(sc?.texts['src-01']).toContain(CANARY);
    expect(sc?.texts['src-01']).toContain('- One\n- Two');

    // A rebuild adds versions; the canary must stay out of every document file and blob.
    const view = await h.lib.versions(slug);
    const t: RebuildTarget = {
      slug,
      docId: (await h.lib.getMeta(slug)).id,
      baseVersionId: view.tree.currentId,
      baseHtmlSha256: sha(await fsp.readFile(h.lib.docPath(slug))),
      promptSet: 'default',
    };
    const { jobId } = await h.queue.startRebuild({ inputs: [await canaryInput(h)], options: opts }, t);
    expect((await h.finished(jobId)).status).toBe('done');
    const leaks = (await allTexts(h.lib.root))
      .filter((f) => !f.file.includes(`${path.sep}.sources${path.sep}`))
      .filter((f) => f.text.includes(CANARY))
      .map((f) => path.relative(h.lib.root, f.file));
    expect(leaks).toEqual([]);
    expect(sink.lines.join('\n')).not.toContain(CANARY);
  });

  it('a sidecar failure still saves the document, logs a warning and leaves no partial sidecar', async () => {
    const { h, sink } = await withSink({
      libraryOver: () => ({
        writeSourcesToStaging: async (dir) => {
          await fsp.mkdir(path.join(dir, '.sources'));
          await fsp.writeFile(path.join(dir, '.sources', 'src-01.md'), 'partial');
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        },
      }),
    });
    const job = await run(h, [await canaryInput(h)]);
    expect(job.status).toBe('done');
    const slug = job.result?.topicSlug ?? '';
    expect(await fsp.readdir(path.join(h.lib.root, slug))).not.toContain('.sources');
    expect(sink.entries().find((e) => e.event === 'pipeline.sources-not-kept')).toMatchObject({
      jobId: job.id,
      code: 'ENOSPC',
    });
  });

  it('a missing extracted artifact gives no sidecar and still saves', async () => {
    const { h, sink } = await withSink({
      libraryOver: (lib) => ({
        allocateSlug: async (title, hint) => {
          const jobs = path.join(h.userData, 'jobs');
          for (const d of await fsp.readdir(jobs).catch(() => [] as string[]))
            await fsp.rm(path.join(jobs, d, 'extracted'), { recursive: true, force: true }).catch(() => {});
          return lib.allocateSlug(title, hint);
        },
      }),
    });
    const job = await run(h, [await canaryInput(h)]);
    expect(job.failure).toBeUndefined();
    expect(job.status).toBe('done');
    expect(await manifestOf(h, job.result?.topicSlug ?? '')).toBeUndefined();
    expect(sink.entries().find((e) => e.event === 'pipeline.sources-not-kept')).toMatchObject({
      code: 'extracted-missing',
    });
  });

  it('a save that finally fails removes the library staging dir', async () => {
    const { h } = await withSink({
      libraryOver: () => ({
        commitDocument: async () => {
          throw new Error('commit failed');
        },
      }),
    });
    const job = await run(h, [await canaryInput(h)]);
    expect(job.status).toBe('failed');
    expect(await fsp.readdir(path.join(h.lib.root, '.staging'))).toEqual([]);
  });

  it('writes nothing with the policy off or with a library that lacks the optional members', async () => {
    const off = await harness({ library: { policy: { ...defaultLibraryPolicy, retainSourceText: false } } });
    const a = await run(off, [await canaryInput(off)]);
    expect(a.status).toBe('done');
    expect(await manifestOf(off, a.result?.topicSlug ?? '')).toBeUndefined();

    const bare = await harness({
      libraryOver: { retainsSourceText: undefined, writeSourcesToStaging: undefined, upsertSources: undefined },
    });
    const b = await run(bare, [await canaryInput(bare)]);
    expect(b.status).toBe('done');
    expect(await manifestOf(bare, b.result?.topicSlug ?? '')).toBeUndefined();
  });
});

describe('a rebuild upserts its source text (design §5)', { timeout: 20_000 }, () => {
  const target = async (h: Harness, slug: string): Promise<RebuildTarget> => {
    const view = await h.lib.versions(slug);
    return {
      slug,
      docId: (await h.lib.getMeta(slug)).id,
      baseVersionId: view.tree.currentId,
      baseHtmlSha256: sha(await fsp.readFile(h.lib.docPath(slug))),
      promptSet: 'default',
    };
  };

  it('adds the new texts with a rebuild origin; an old document without a sidecar gets one', async () => {
    const h = await harness({
      libraryOver: { writeSourcesToStaging: undefined }, // the "old" document is saved without one
    });
    const job = await run(h, [fileInput('sources/text/notes.md')]);
    const slug = job.result?.topicSlug ?? '';
    expect(await manifestOf(h, slug)).toBeUndefined();
    const { jobId } = await h.queue.startRebuild(
      { inputs: [fileInput('sources/text/notes.md'), await canaryInput(h)], options: opts },
      await target(h, slug),
    );
    expect((await h.finished(jobId)).status).toBe('done');
    const m = await manifestOf(h, slug);
    expect(m?.sources.map((s) => [s.ref, s.origin])).toEqual([
      ['notes.md', `rebuild:${jobId}`],
      ['ledger.md', `rebuild:${jobId}`],
    ]);
  });

  it('a crash between the commit and the upsert: the relaunch finishes the rebuild and upserts once', async () => {
    let backup = '';
    // Run 1: the upsert never happens (the crash point); keep a copy of the job staging as it was.
    const a = await harness({
      libraryOver: {
        upsertSources: async () => {
          backup = path.join(a.userData, 'jobs-backup');
          await fsp.cp(path.join(a.userData, 'jobs'), backup, { recursive: true });
        },
      },
    });
    const created = await run(a, [fileInput('sources/text/notes.md')]);
    const slug = created.result?.topicSlug ?? '';
    const before = await manifestOf(a, slug);
    const { jobId } = await a.queue.startRebuild(
      { inputs: [fileInput('sources/text/notes.md'), await canaryInput(a, 'resumed.md')], options: opts },
      await target(a, slug),
    );
    const job = await a.finished(jobId);
    expect(job.status).toBe('done');
    const nodes = (await a.lib.versions(slug)).tree.nodes.length;
    expect(await manifestOf(a, slug)).toEqual(before);
    // Rewind to "saving" with the job staging still present, as a crash before done leaves it.
    await fsp.cp(path.join(backup, jobId), path.join(a.userData, 'jobs', jobId), { recursive: true });
    const rec = { ...job, status: 'saving', checkpoint: { ...job.checkpoint, stage: 'saving' } };
    delete (rec as Partial<Job>).result;
    delete (rec as Partial<Job>).finishedAt;
    await fsp.writeFile(path.join(a.userData, 'jobs', `${jobId}.json`), JSON.stringify(rec));

    const b = await harness({ from: a });
    expect((await b.finished(jobId)).status).toBe('done');
    expect((await b.lib.versions(slug)).tree.nodes).toHaveLength(nodes);
    expect(b.fake.calls).toEqual([]);
    const m = await manifestOf(b, slug);
    const resumed = m?.sources.filter((s) => s.origin === `rebuild:${jobId}`) ?? [];
    expect(resumed.map((s) => s.ref)).toContain('resumed.md');
    expect(m?.sources.filter((s) => s.ref === 'resumed.md')).toHaveLength(1);
  });

  it('a failing upsert never fails the rebuild: the version commits and a warning is logged', async () => {
    const { h, sink } = await withSink({
      libraryOver: {
        upsertSources: async () => {
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        },
      },
    });
    const created = await run(h, [fileInput('sources/text/notes.md')]);
    const slug = created.result?.topicSlug ?? '';
    const before = await manifestOf(h, slug);
    const nodes = (await h.lib.versions(slug)).tree.nodes.length;
    const { jobId } = await h.queue.startRebuild(
      { inputs: [fileInput('sources/text/notes.md'), await canaryInput(h, 'later.md')], options: opts },
      await target(h, slug),
    );
    expect((await h.finished(jobId)).status).toBe('done');
    expect((await h.lib.versions(slug)).tree.nodes.length).toBe(nodes + 1);
    expect(await manifestOf(h, slug)).toEqual(before);
    expect(sink.entries().find((e) => e.event === 'pipeline.sources-not-kept')).toMatchObject({
      jobId,
      code: 'ENOSPC',
    });
  });
});
