import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LibraryError } from '../../../../src/main/library';
import { PipelineFailure, PipelineRequestError, type Job, type SectionJobPayload } from '../../../../src/main/pipeline';
import { validateDocument } from '../../../helpers/doc-validity';
import { defaultScript, fileInput, harness, urlInput } from './harness';

const opts = { clarifyingInput: 'I run a small widget shop', glossary: true };
const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );
const jobsDir = (userData: string): string => path.join(userData, 'jobs');

describe('enqueue (06 §5.1)', () => {
  it('rejects zero sources with E_BAD_REQUEST and persists a job before returning', async () => {
    const h = await harness();
    await expect(h.queue.start({ inputs: [], options: opts })).rejects.toMatchObject({
      code: 'E_BAD_REQUEST',
      message: 'Add at least one source',
    });
    await expect(h.queue.start({ inputs: [], options: opts })).rejects.toBeInstanceOf(PipelineRequestError);
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    const rec = JSON.parse(await readFile(path.join(jobsDir(h.userData), `${jobId}.json`), 'utf8')) as Job;
    expect(rec).toMatchObject({ id: jobId, kind: 'create', attempt: 1 });
    expect(h.events[0]).toMatchObject({ id: jobId, status: 'queued', statusLine: 'Queued' });
    await h.finished(jobId);
  });

  it('snapshots dropped files into jobs/<jobId>/inputs/ (06 §9.2)', async () => {
    const hang = (i: { signal: AbortSignal }): Promise<never> =>
      new Promise((_, reject) => i.signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError'))));
    const h = await harness({ tasks: (t) => ({ ...t, prepareContent: hang }) });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    const job = h.queue.get(jobId);
    const input = job?.inputs[0];
    expect(input?.kind === 'file' && input.snapshot?.copyPath).toBe(
      path.join(jobsDir(h.userData), jobId, 'inputs', '0-notes.md'),
    );
    expect(await exists(path.join(jobsDir(h.userData), jobId, 'inputs', '0-notes.md'))).toBe(true);
    await h.reached(jobId, 'generating');
    await h.queue.cancel(jobId);
    await h.finished(jobId);
  });

  it('refuses new jobs while the library is read-only', async () => {
    const h = await harness({ libraryOver: { readOnly: true } });
    await expect(
      h.queue.start({ inputs: [urlInput('https://example.com/widgets')], options: opts }),
    ).rejects.toMatchObject({ code: 'E_LIBRARY_READ_ONLY' });
  });
});

describe('a create job end to end (06 §3.2, §5, §6)', () => {
  it('walks queued -> reading -> extracting -> generating -> saving -> done with the §6 lines', async () => {
    const h = await harness();
    const { jobId } = await h.queue.start({
      inputs: [fileInput('sources/text/notes.md'), urlInput('https://example.com/widgets')],
      options: opts,
    });
    const job = await h.finished(jobId);
    expect(job.status).toBe('done');
    const statuses = h.events.filter((e) => e.id === jobId).map((e) => e.status);
    expect([...new Set(statuses)]).toEqual(['queued', 'reading', 'extracting', 'generating', 'saving', 'done']);
    const lines = h.lines(jobId);
    expect(lines).toContain('Reading sources (0 of 2)');
    expect(lines).toContain('Extracting content');
    expect(lines).toContain('Generating document (in-depth and ELI5)');
    expect(lines).toContain('Generating document (glossary notes)');
    expect(lines).toContain('Generating document (finishing up)');
    expect(lines).toContain('Saving');
    expect(lines.at(-1)).toBe('Done: How Example Widgets Inc. Plans Its Widget Supply');
    // Library: folder + catalog entry; meta records the job.
    const slug = job.result?.topicSlug ?? '';
    expect(slug).toBe('widget-supply-planning');
    const entry = h.lib.getEntry(slug);
    expect(entry).toMatchObject({ title: job.result?.title, summarySource: 'llm', tabCount: 2 });
    const meta = await h.lib.getMeta(slug);
    expect(meta).toMatchObject({
      jobId,
      clarifyingInput: opts.clarifyingInput,
      glossaryEnabled: true,
      summary: 'A synthetic explainer on how a widget maker forecasts demand by channel and sizes its safety stock.',
      generation: { provider: 'claude', model: 'fake-model' },
      sourcesUsed: [
        { ref: 'notes.md', kind: 'file' },
        { ref: 'https://example.com/widgets', kind: 'url' },
      ],
      sourcesSkipped: [],
      warnings: [],
    });
    expect(meta.generation.prompts).toEqual(
      expect.arrayContaining(['in-depth@1', 'eli5@1', 'glossary@1', 'summary@1']),
    );
    const html = await readFile(h.lib.docPath(slug), 'utf8');
    expect(validateDocument(html, meta).errors).toEqual([]);
    // Staging removed at done (06 §9.5); library staging too.
    expect(await exists(path.join(jobsDir(h.userData), jobId))).toBe(false);
    expect(await readdir(path.join(h.lib.root, '.staging'))).toEqual([]);
    // done event once; merge check after the catalog entry exists (06 §10).
    expect(h.done).toEqual([{ jobId, kind: 'create', slug, docId: entry?.id, title: job.result?.title }]);
    expect(h.mergeChecks).toEqual([entry?.id]);
    // Power save held while running, released when drained (06 §4.3).
    expect(h.power).toEqual({ started: 1, stopped: 1 });
  });

  it('runs one create job at a time by default; the next shows Queued and runs after (06 §4.1)', async () => {
    const h = await harness();
    const a = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    const b = await h.queue.start({ inputs: [fileInput('sources/text/plain.txt')], options: opts });
    const c = await h.queue.start({ inputs: [fileInput('sources/text/plain.txt')], options: opts });
    expect(h.queue.list().find((s) => s.id === c.jobId)?.statusLine).toBe('Queued (2 ahead)');
    const [ja, jb, jc] = await Promise.all([h.finished(a.jobId), h.finished(b.jobId), h.finished(c.jobId)]);
    expect([ja.status, jb.status, jc.status]).toEqual(['done', 'done', 'done']);
    const order = h.events.filter((e) => e.status === 'reading').map((e) => e.id);
    expect([...new Set(order)]).toEqual([a.jobId, b.jobId, c.jobId]);
    // Distinct slugs for the same title (09 §6.2).
    const slugs = [ja, jb, jc].map((j) => j.result?.topicSlug);
    expect(new Set(slugs).size).toBe(3);
    expect(h.done.map((d) => d.jobId)).toEqual([a.jobId, b.jobId, c.jobId]);
  });

  it('clamps pipeline.maxConcurrentJobs to the policy ceiling', async () => {
    const h = await harness({
      settings: { maxConcurrentJobs: 3 },
      deps: { policy: { ...(await import('../../../../src/main/pipeline')).defaultPipelinePolicy, maxCreateSlots: 2 } },
    });
    expect(h.queue.createSlots()).toBe(2);
  });

  it('with the glossary off no glossary call is made (06 acceptance)', async () => {
    const h = await harness();
    const { jobId } = await h.queue.start({
      inputs: [fileInput('sources/text/notes.md')],
      options: { clarifyingInput: '', glossary: false },
    });
    expect((await h.finished(jobId)).status).toBe('done');
    expect(h.fake.calls.map((c) => c.taskId)).not.toContain('glossary');
    expect(h.lines(jobId)).not.toContain('Generating document (glossary notes)');
  });
});

describe('partial and total failure (06 §7)', () => {
  it('a skipped source still produces a document, listed with its reason', async () => {
    const h = await harness();
    const { jobId } = await h.queue.start({
      inputs: [
        fileInput('sources/text/notes.md'),
        urlInput('https://example.com/login'),
        fileInput('sources/text/does-not-exist.txt'),
      ],
      options: opts,
    });
    const job = await h.finished(jobId);
    expect(job.status).toBe('done');
    expect(job.skipped.map((s) => s.ref).sort()).toEqual(['does-not-exist.txt', 'https://example.com/login']);
    expect(h.lines(jobId).at(-1)).toBe('Done: How Example Widgets Inc. Plans Its Widget Supply · 2 source(s) skipped');
    const meta = await h.lib.getMeta(job.result?.topicSlug ?? '');
    expect(meta.sourcesSkipped.map((s) => s.ref).sort()).toEqual(['does-not-exist.txt', 'https://example.com/login']);
    expect(meta.warnings.filter((w) => w.kind === 'source-skipped')).toHaveLength(2);
    const html = await readFile(h.lib.docPath(job.result?.topicSlug ?? ''), 'utf8');
    expect(html).toContain('Page required login');
  });

  it('no usable content fails with NO_USABLE_CONTENT and leaves no Library entry', async () => {
    const h = await harness();
    const { jobId } = await h.queue.start({
      inputs: [fileInput('sources/text/empty.txt'), urlInput('https://example.com/login')],
      options: opts,
    });
    const job = await h.finished(jobId);
    expect(job.failure?.code).toBe('NO_USABLE_CONTENT');
    expect(h.lines(jobId).at(-1)).toBe('Failed: no usable content in 2 source(s)');
    expect(h.lib.list()).toEqual([]);
    expect(h.fake.calls).toEqual([]);
    // Staging kept for Retry (06 §7.2); no done event.
    expect(await exists(path.join(jobsDir(h.userData), jobId))).toBe(true);
    expect(h.done).toEqual([]);
  });

  it('an invalid API key fails LLM_AUTH without retries; a missing key fails before any call', async () => {
    const h = await harness({ script: defaultScript({ errors: { 'in-depth': 'auth' } }) });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    const job = await h.finished(jobId);
    expect(job.failure?.code).toBe('LLM_AUTH');
    expect(h.lines(jobId).at(-1)).toBe('Failed: API key rejected. Check Settings');
    expect(h.fake.calls.filter((c) => c.taskId === 'in-depth')).toHaveLength(1);

    const k = await harness({ deps: { hasApiKey: async () => false } });
    const r = await k.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    expect((await k.finished(r.jobId)).failure?.code).toBe('LLM_AUTH');
    expect(k.fake.calls).toEqual([]);
  });

  it('maps LLMError kinds (06 §5.4 rule 2)', async () => {
    const cases = [
      ['server', 'LLM_UNAVAILABLE'],
      ['invalid_output', 'LLM_UNAVAILABLE'],
      ['bad_request', 'INTERNAL'],
    ] as const;
    for (const [kind, code] of cases) {
      const h = await harness({ script: defaultScript({ errors: { 'in-depth': kind } }) });
      const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
      const job = await h.finished(jobId);
      expect(job.failure?.code, kind).toBe(code);
      if (kind === 'invalid_output') expect(job.failure?.detail).toContain('invalid_output');
    }
  });

  it('degrades ELI5, glossary and summary failures into warnings (06 §7.1)', async () => {
    const h = await harness({
      script: defaultScript({ errors: { eli5: 'server', glossary: 'overloaded', summary: 'auth' } }),
    });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    const job = await h.finished(jobId);
    expect(job.status).toBe('done');
    expect(job.warnings.map((w) => w.kind).sort()).toEqual([
      'eli5-placeholder',
      'glossary-omitted',
      'summary-fallback',
    ]);
    expect(h.lines(jobId).at(-1)).toBe('Done: How Example Widgets Inc. Plans Its Widget Supply · with notes');
    const meta = await h.lib.getMeta(job.result?.topicSlug ?? '');
    expect(meta.summarySource).toBe('fallback');
    expect(meta.summary.length).toBeLessThanOrEqual(300);
    expect(meta.summary).toContain('Example Widgets Inc. sells');
    // No hint: the slug comes from the title (06 §5.5).
    expect(job.result?.topicSlug).toBe('how-example-widgets-inc-plans-its-widget-supply');
    const html = await readFile(h.lib.docPath(job.result?.topicSlug ?? ''), 'utf8');
    expect(html).toContain('The ELI5 version could not be generated.');
    expect(validateDocument(html, meta).errors).toEqual([]);
  });
});

describe('cancellation (06 §8.1)', () => {
  it('a queued job is removed at once, goes Cancelled and deletes its staging', async () => {
    const h = await harness({ script: defaultScript({ latencyMs: 60_000 }) });
    const a = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    const b = await h.queue.start({ inputs: [fileInput('sources/text/plain.txt')], options: opts });
    await h.queue.cancel(b.jobId);
    const jb = await h.finished(b.jobId);
    expect(jb.failure?.code).toBe('CANCELLED');
    expect(h.lines(b.jobId).at(-1)).toBe('Cancelled');
    expect(await exists(path.join(jobsDir(h.userData), b.jobId))).toBe(false);
    await expect(h.queue.cancel(b.jobId)).rejects.toMatchObject({ code: 'E_CONFLICT' });
    await expect(h.queue.cancel('01JNOPE')).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    await h.queue.cancel(a.jobId);
    await h.finished(a.jobId);
  });

  it('a running job stops within 2 s and leaves no folder, catalog entry or staging', async () => {
    const h = await harness({ script: defaultScript({ latencyMs: 60_000 }) });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    await h.reached(jobId, 'generating');
    const t0 = Date.now();
    await h.queue.cancel(jobId);
    const job = await h.finished(jobId);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(job.failure?.code).toBe('CANCELLED');
    expect(job.cancelRequested).toBe(true);
    expect(h.lib.list()).toEqual([]);
    expect(await exists(path.join(jobsDir(h.userData), jobId))).toBe(false);
    expect(await readdir(path.join(h.lib.root, '.staging'))).toEqual([]);
    expect(h.done).toEqual([]);
    expect(h.power).toEqual({ started: 1, stopped: 1 });
  });

  it('refuses cancel once commitDocument has been called (06 §8.1)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = await harness({
      libraryOver: (lib) => ({
        commitDocument: async (r, d, m) => {
          await gate;
          return lib.commitDocument(r, d, m);
        },
      }),
    });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    await new Promise<void>((resolve) => {
      const off = h.queue.on('changed', (s) => {
        if (s.id === jobId && s.status === 'saving' && !s.canCancel) {
          off();
          resolve();
        }
      });
    });
    await expect(h.queue.cancel(jobId)).rejects.toMatchObject({ code: 'E_CONFLICT' });
    release();
    expect((await h.finished(jobId)).failure).toBeUndefined();
  });
});

describe('saving failures and Retry (06 §5.7, §7.3)', () => {
  it('SAVE_FAILED after one retry releases the slug; Retry skips straight to saving', async () => {
    let failures = 2;
    const sleeps: number[] = [];
    const h = await harness({
      deps: {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      libraryOver: (lib) => ({
        commitDocument: async (r, d, m) => {
          if (failures-- > 0) throw new LibraryError('WRITE_FAILED', { slug: r.slug });
          return lib.commitDocument(r, d, m);
        },
      }),
    });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    const failed = await h.finished(jobId);
    expect(failed.failure).toMatchObject({ code: 'SAVE_FAILED' });
    expect(sleeps).toEqual([2000]);
    expect(h.lines(jobId).at(-1)).toBe('Failed: could not save the document');
    expect(h.queue.list().find((s) => s.id === jobId)).toMatchObject({ canRetry: true, canDismiss: true });
    const calls = h.fake.calls.length;
    const extracts = h.extractCalls.length;
    await h.queue.retry(jobId);
    const done = await h.finished(jobId);
    expect(done.failure).toBeUndefined();
    expect(done.attempt).toBe(2);
    expect(h.fake.calls.length).toBe(calls); // nothing regenerated
    expect(h.extractCalls.length).toBe(extracts);
    // The slug released on failure is reused.
    expect(done.result?.topicSlug).toBe('widget-supply-planning');
    await expect(h.queue.retry(jobId)).rejects.toMatchObject({ code: 'E_CONFLICT' });
  });

  it('Retry after an LLM failure regenerates without re-extracting file sources', async () => {
    const h = await harness({ script: defaultScript({ errors: { 'in-depth': ['server'] } }) });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    expect((await h.finished(jobId)).failure?.code).toBe('LLM_UNAVAILABLE');
    const extracts = h.extractCalls.length;
    await h.queue.retry(jobId);
    expect((await h.finished(jobId)).status).toBe('done');
    expect(h.extractCalls.length).toBe(extracts);
  });

  it('Retry refetches URL sources (06 §7.3)', async () => {
    const h = await harness({ script: defaultScript({ errors: { 'in-depth': ['server'] } }) });
    const { jobId } = await h.queue.start({ inputs: [urlInput('https://example.com/widgets')], options: opts });
    await h.finished(jobId);
    const extracts = h.extractCalls.length;
    await h.queue.retry(jobId);
    expect((await h.finished(jobId)).status).toBe('done');
    expect(h.extractCalls.length).toBe(extracts + 1);
  });

  it('dismiss hides a terminal line and frees staging; non-terminal is a conflict', async () => {
    const h = await harness({ script: defaultScript({ latencyMs: 60_000 }) });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/empty.txt')], options: opts });
    await h.finished(jobId);
    const running = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    await expect(h.queue.dismiss(running.jobId)).rejects.toMatchObject({ code: 'E_CONFLICT' });
    await h.queue.dismiss(jobId);
    expect(h.queue.list().map((s) => s.id)).toEqual([running.jobId]);
    expect(await exists(path.join(jobsDir(h.userData), jobId))).toBe(false);
    await expect(h.queue.dismiss('01JNOPE')).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    await h.queue.cancel(running.jobId);
    await h.finished(running.jobId);
  });
});

describe('crash recovery on launch (06 §9.4)', () => {
  it('resumes a job killed during generating without redoing reading, extraction or finished steps', async () => {
    const a = await harness({ tasks: (t) => ({ ...t, summarize: () => new Promise(() => {}) }) });
    const { jobId } = await a.queue.start({
      inputs: [fileInput('sources/text/notes.md'), urlInput('https://example.com/widgets')],
      options: opts,
    });
    await new Promise<void>((resolve) => {
      const off = a.queue.on('changed', (s) => {
        if (s.id === jobId && s.statusLine === 'Generating document (finishing up)') {
          off();
          resolve();
        }
      });
    });
    await a.queue.close();
    // Relaunch over the same userData and library.
    const b = await harness({ from: a });
    expect(b.events.find((e) => e.id === jobId)?.statusLine).toBe('Resuming');
    const job = await b.finished(jobId);
    expect(job.status).toBe('done');
    expect(job.attempt).toBe(2);
    expect(b.extractCalls).toEqual([]);
    expect(b.fake.calls.map((c) => c.taskId)).toEqual(['summary']);
    expect(b.lib.list()).toHaveLength(1);
  });

  it('finishes a commit interrupted between the folder rename and the catalog update', async () => {
    const a = await harness();
    const { jobId } = await a.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    const done = await a.finished(jobId);
    const slug = done.result?.topicSlug ?? '';
    // Rewind the record to "saving, slug reserved" and drop the catalog entry.
    const rec = { ...done, status: 'saving', checkpoint: { ...done.checkpoint, stage: 'saving', topicSlug: slug } };
    delete (rec as Partial<Job>).result;
    delete (rec as Partial<Job>).finishedAt;
    await writeFile(path.join(jobsDir(a.userData), `${jobId}.json`), JSON.stringify(rec));
    const catalog = path.join(a.lib.root, 'catalog.json');
    const cat = JSON.parse(await readFile(catalog, 'utf8')) as { entries: unknown[] };
    await writeFile(catalog, JSON.stringify({ ...cat, entries: [] }));
    const b = await harness({ from: a, library: { reconcile: false } });
    const job = await b.finished(jobId);
    expect(job.status).toBe('done');
    expect(job.result?.topicSlug).toBe(slug);
    expect(b.lib.getEntry(slug)).toBeDefined();
    expect(b.fake.calls).toEqual([]);
    expect(b.mergeChecks).toEqual([b.lib.getEntry(slug)?.id]);
  });

  it('applies cancelRequested, resumeAfterCrash, the attempt cap and the orphan sweep', async () => {
    const a = await harness({ init: false });
    await mkdir(jobsDir(a.userData), { recursive: true });
    const base = {
      kind: 'create',
      createdAt: '2026-03-01T00:00:00.000Z',
      inputs: [{ id: 'in-1', kind: 'url', origin: 'url-field', url: 'https://example.com/widgets' }],
      options: opts,
      progress: { sourcesTotal: 1, sourcesDone: 0, stepsPlanned: ['indepth', 'eli5', 'glossary', 'summary'] },
      resolved: [],
      skipped: [],
      warnings: [],
    };
    const write = (id: string, over: object): Promise<void> =>
      writeFile(path.join(jobsDir(a.userData), `${id}.json`), JSON.stringify({ ...base, id, ...over }));
    await write('01JREC0001', { status: 'reading', attempt: 1, cancelRequested: true });
    await write('01JREC0002', { status: 'generating', attempt: 3 });
    await write('01JREC0003', { status: 'extracting', attempt: 1, kind: 'section' });
    await mkdir(path.join(a.lib.root, '.staging', '01JORPHAN'), { recursive: true });
    const b = await harness({
      from: a,
      deps: {
        policy: {
          ...(await import('../../../../src/main/pipeline')).defaultPipelinePolicy,
          resumeAfterCrash: (j) => j.kind !== 'section',
        },
      },
    });
    expect(b.queue.get('01JREC0001')?.failure?.code).toBe('CANCELLED');
    expect(b.queue.get('01JREC0002')?.failure).toMatchObject({
      code: 'INTERNAL',
      message: 'stopped after repeated interruptions',
    });
    expect(b.queue.get('01JREC0003')?.failure?.code).toBe('INTERRUPTED');
    expect(await exists(path.join(b.lib.root, '.staging', '01JORPHAN'))).toBe(false);
  });
});

describe('retention (06 §9.5)', () => {
  it('drops done records after 30 days and failed staging after 7', async () => {
    const a = await harness({ init: false });
    await mkdir(path.join(jobsDir(a.userData), '01JOLD0002', 'inputs'), { recursive: true });
    const base = {
      kind: 'create',
      createdAt: '2026-01-01T00:00:00.000Z',
      inputs: [],
      options: opts,
      progress: { sourcesTotal: 0, sourcesDone: 0, stepsPlanned: [] },
      resolved: [],
      skipped: [],
      warnings: [],
      attempt: 1,
    };
    const write = (id: string, over: object): Promise<void> =>
      writeFile(path.join(jobsDir(a.userData), `${id}.json`), JSON.stringify({ ...base, id, ...over }));
    await write('01JOLD0001', { status: 'done', finishedAt: '2026-01-15T00:00:00.000Z' });
    await write('01JOLD0002', {
      status: 'failed',
      finishedAt: '2026-02-20T00:00:00.000Z',
      failure: { code: 'INTERNAL', message: 'x' },
    });
    await write('01JOLD0003', {
      status: 'failed',
      finishedAt: '2026-02-27T00:00:00.000Z',
      failure: { code: 'INTERNAL', message: 'x' },
    });
    const b = await harness({ from: a });
    expect(b.queue.get('01JOLD0001')).toBeUndefined();
    expect(await exists(path.join(jobsDir(a.userData), '01JOLD0001.json'))).toBe(false);
    expect(b.queue.get('01JOLD0002')?.stagingPurged).toBe(true);
    expect(await exists(path.join(jobsDir(a.userData), '01JOLD0002'))).toBe(false);
    expect(b.queue.get('01JOLD0003')?.stagingPurged).toBeUndefined();
    // Undismissed failed jobs are listed; done jobs older than 10 minutes are not.
    expect(b.queue.list().map((s) => s.id)).toEqual(['01JOLD0002', '01JOLD0003']);
  });
});

describe('section lane plumbing (06 §8.2)', () => {
  const payload: SectionJobPayload = {
    slug: 'widget-supply-planning',
    tabKey: 'indepth',
    sectionId: 'sec-indepth-0123abcd' as SectionJobPayload['sectionId'],
    action: 'expand',
    selectionText: 'safety stock',
    heading: 'How the forecast is built',
    baseHash: 'h',
  };

  it('runs in its own lane, not blocked by a running create job, and never merge-checks', async () => {
    const h = await harness({
      script: defaultScript({ latencyMs: 60_000 }),
      deps: {
        sectionRunner: async (ctx) => {
          expect(ctx.job.status).toBe('generating');
          await ctx.enterSaving();
          return { result: { docId: 'd-1', topicSlug: payload.slug, title: 'Doc' } };
        },
      },
    });
    const create = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    await h.reached(create.jobId, 'generating');
    const { jobId } = await h.queue.enqueueSection(payload);
    const job = await h.finished(jobId);
    expect(job.status).toBe('done');
    expect(h.lines(jobId)).toEqual([
      'Updating section: How the forecast is built',
      'Updating section: How the forecast is built',
      'Updating section: How the forecast is built',
      'Updated: How the forecast is built',
    ]);
    expect(h.events.filter((e) => e.id === jobId).map((e) => e.status)).toEqual([
      'queued',
      'generating',
      'saving',
      'done',
    ]);
    expect(h.mergeChecks).toEqual([]);
    expect(h.done).toEqual([{ jobId, kind: 'section', slug: payload.slug, docId: 'd-1', title: 'Doc' }]);
    await h.queue.cancel(create.jobId);
    await h.finished(create.jobId);
  });

  it('maps a section failure code and fails INTERNAL without a runner', async () => {
    const h = await harness({
      deps: {
        sectionRunner: async () => {
          throw new PipelineFailure('SECTION_GONE');
        },
      },
    });
    const { jobId } = await h.queue.enqueueSection(payload);
    const job = await h.finished(jobId);
    expect(job.failure?.code).toBe('SECTION_GONE');
    expect(h.lines(jobId).at(-1)).toBe('Failed: section no longer exists');
    expect(h.queue.list().find((s) => s.id === jobId)?.canRetry).toBe(false);

    const n = await harness();
    const r = await n.queue.enqueueSection(payload);
    expect((await n.finished(r.jobId)).failure?.code).toBe('INTERNAL');
  });
});
