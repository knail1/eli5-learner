import { constants as fsConst } from 'node:fs';
import { copyFile, readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LibraryError } from '../../../../src/main/library';
import { draftDir, stageText } from '../../../../src/main/sources';
import type { Logger, LogFields } from '../../../../src/main/security';
import {
  PipelineFailure,
  PipelineRequestError,
  type Job,
  type PipelineDeps,
  type SectionJobPayload,
} from '../../../../src/main/pipeline';
import { validateDocument } from '../../../helpers/doc-validity';
import { defaultScript, fileInput, harness, urlInput } from './harness';

const opts = { clarifyingInput: 'I run a small widget shop', glossary: true };
const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );
const jobsDir = (userData: string): string => path.join(userData, 'jobs');

/** Records warn events; everything else is dropped. */
function recordingLog(): Logger & { warns: { event: string; fields?: LogFields }[] } {
  const warns: { event: string; fields?: LogFields }[] = [];
  return {
    warns,
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (event, fields) => warns.push({ event, ...(fields ? { fields } : {}) }),
  };
}

/** Every file under `dir`, recursively, as [path, contents]. */
async function allFiles(dir: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await allFiles(p)));
    else out.push([p, await readFile(p, 'latin1')]);
  }
  return out;
}

/**
 * A copy function whose forced clone always fails and whose other copies wait for `release()`. Use
 * with `snapshotInlineCopyMaxBytes: 0` so every unclonable file is copied in the background.
 */
function slowCopy(fail = false): {
  copyFile: NonNullable<PipelineDeps['copyFile']>;
  release: () => void;
  plain: number;
} {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const state = {
    plain: 0,
    release: () => release(),
    copyFile: async (src: string, dst: string, mode?: number): Promise<void> => {
      if (mode !== undefined && (mode & fsConst.COPYFILE_FICLONE_FORCE) !== 0) {
        throw Object.assign(new Error('clone not supported'), { code: 'ENOTSUP' });
      }
      state.plain++;
      await gate;
      if (fail) throw Object.assign(new Error('copy failed'), { code: 'EIO' });
      await copyFile(src, dst);
    },
  };
  return state;
}

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

  it('copies staged pastes into each job and keeps the draft, so the same draft can start again (03 §13)', async () => {
    const h = await harness();
    const draftId = 'draft-0000000a';
    const pasted = await stageText(h.userData, { draftId, text: 'Widget margins rose in Q3.', markup: 'plain' });
    const req = { inputs: [pasted], options: opts, draftId };
    const first = await h.queue.start(req);
    const second = await h.queue.start(req);
    for (const { jobId } of [first, second]) {
      const input = h.queue.get(jobId)?.inputs[0];
      const copy = path.join(jobsDir(h.userData), jobId, 'inputs', `0-${path.basename(pasted.stagedPath)}`);
      expect(input?.kind === 'text' && input.stagedPath).toBe(copy);
      expect(await readFile(copy, 'utf8')).toBe('Widget margins rose in Q3.');
    }
    // The draft's own staged file is untouched; it goes when the chip is removed or the draft cleared.
    expect(await readFile(pasted.stagedPath, 'utf8')).toBe('Widget margins rose in Q3.');
    expect(await exists(draftDir(h.userData, draftId))).toBe(true);
    expect((await h.finished(first.jobId)).status).toBe('done');
    expect((await h.finished(second.jobId)).status).toBe('done');
    expect(await exists(pasted.stagedPath)).toBe(true);
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

  it('returns before a copy that cannot be cloned finishes; reading waits for it (06 §5.1 step 2, §9.2)', async () => {
    const copy = slowCopy();
    const h = await harness({ deps: { copyFile: copy.copyFile, snapshotInlineCopyMaxBytes: 0 } });
    const t0 = Date.now();
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    expect(Date.now() - t0).toBeLessThan(1000);
    // Persisted before the copy finished, without a copyPath yet.
    const rec = JSON.parse(await readFile(path.join(jobsDir(h.userData), `${jobId}.json`), 'utf8')) as Job;
    const first = rec.inputs[0];
    expect(first?.kind === 'file' && first.snapshot?.copyPath).toBeFalsy();
    await h.reached(jobId, 'reading');
    await new Promise((r) => setTimeout(r, 50));
    expect(h.queue.get(jobId)?.status).toBe('reading');
    expect(h.extractCalls).toEqual([]);
    copy.release();
    const job = await h.finished(jobId);
    expect(job.status).toBe('done');
    expect(copy.plain).toBe(1);
    const input = job.inputs[0];
    expect(input?.kind === 'file' && input.snapshot?.copyPath).toBe(
      path.join(jobsDir(h.userData), jobId, 'inputs', '0-notes.md'),
    );
    expect(job.resolved.map((r) => r.ref)).toEqual(['notes.md']);
  });

  it('a background copy that fails skips the file with "file changed or moved" (06 §9.2)', async () => {
    const copy = slowCopy(true);
    const h = await harness({ deps: { copyFile: copy.copyFile, snapshotInlineCopyMaxBytes: 0 } });
    const { jobId } = await h.queue.start({
      inputs: [fileInput('sources/text/notes.md'), urlInput('https://example.com/widgets')],
      options: opts,
    });
    copy.release();
    const job = await h.finished(jobId);
    expect(job.status).toBe('done');
    expect(job.skipped).toEqual([expect.objectContaining({ ref: 'notes.md', code: 'file-changed' })]);
    expect(job.skipped[0]?.reason).toMatch(/changed or moved/i);
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
      expect.arrayContaining(['in-depth@3', 'eli5@4', 'glossary@2', 'summary@1']),
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

  it('never retries an LLM call itself: an exhausted retryable in-depth error ends LLM_UNAVAILABLE (06 §5.4)', async () => {
    for (const kind of ['server', 'overloaded'] as const) {
      const h = await harness({ script: defaultScript({ errors: { 'in-depth': kind } }) });
      const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
      const job = await h.finished(jobId);
      expect(job.failure?.code, kind).toBe('LLM_UNAVAILABLE');
      expect(
        h.fake.calls.filter((c) => c.taskId === 'in-depth'),
        kind,
      ).toHaveLength(1);
    }
  });

  it('a null ELI5 draft (02 threw after its retries) saves a regenerable placeholder tab (06 §7.1)', async () => {
    const h = await harness({ script: defaultScript({ errors: { eli5: 'timeout' } }) });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    const job = await h.finished(jobId);
    expect(job.status).toBe('done');
    expect(job.warnings.map((w) => w.kind)).toEqual(['eli5-placeholder']);
    const meta = await h.lib.getMeta(job.result?.topicSlug ?? '');
    expect(meta.warnings.map((w) => w.kind)).toContain('eli5-placeholder');
    // One placeholder section with a normal SectionId, so 08's regenerate-in-place can target it.
    expect(meta.tabs.find((t) => t.key === 'eli5')).toMatchObject({ kind: 'eli5', sectionCount: 1 });
    const html = await readFile(h.lib.docPath(job.result?.topicSlug ?? ''), 'utf8');
    expect(html).toContain('The ELI5 version could not be generated.');
    expect(new Set(html.match(/\bsec-eli5-[0-9a-f]{8}\b/g))).toHaveProperty('size', 1);
    expect(validateDocument(html, meta).errors).toEqual([]);
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

describe('image budget (06 §5.3 step 1)', () => {
  it('reserves every standalone image before any other source is extracted', async () => {
    const seen: { ref: string; images: number; ok: boolean; pendingAtStart: number; usedAtStart: number }[] = [];
    const base: { run?: PipelineDeps['createExtractRunner'] } = {};
    const h = await harness({
      deps: {
        createExtractRunner: (jobId) => {
          const r = (base.run as PipelineDeps['createExtractRunner'])(jobId);
          return {
            extract: async (s, x) => {
              // Shrink the budget to two images on the first call so the ordering decides who fits.
              if (!seen.length) x.budget.apply({ ...x.budget.snapshot(), maxImages: 2 });
              const at = x.budget.snapshot();
              const out = await r.extract(s, x);
              seen.push({
                ref: s.ref,
                ok: out.ok,
                images: out.ok ? out.content.images.length : 0,
                pendingAtStart: at.pendingStandalone,
                usedAtStart: at.usedImages,
              });
              return out;
            },
            dispose: () => r.dispose(),
          };
        },
      },
    });
    base.run = (await harness()).deps.createExtractRunner;
    const { jobId } = await h.queue.start({
      inputs: [
        fileInput('sources/docx/table-image.docx'),
        fileInput('sources/images/diagram.png'),
        fileInput('sources/images/photo.jpg'),
        fileInput('sources/images/screenshot-tall.png'),
      ],
      options: opts,
    });
    const job = await h.finished(jobId);
    expect(job.status).toBe('done');
    // Standalone images first; the docx only after all three were announced or reserved.
    expect(seen.map((s) => s.ref)).toEqual(['diagram.png', 'photo.jpg', 'screenshot-tall.png', 'table-image.docx']);
    expect(seen[0]?.pendingAtStart).toBe(3);
    // Two standalone images fit, the third is skipped, and the docx keeps its text but no images.
    expect(seen.slice(0, 2).map((s) => s.images)).toEqual([1, 1]);
    expect(job.skipped).toEqual([
      expect.objectContaining({ ref: 'screenshot-tall.png', code: 'image-budget-exceeded' }),
    ]);
    expect(seen[3]).toMatchObject({ ok: true, images: 0, usedAtStart: 2 });
  });
});

describe('merge check isolation (06 §10)', () => {
  it('a merge check that throws or rejects leaves the job done with one done event and a warning', async () => {
    for (const mode of ['throw', 'reject'] as const) {
      const log = recordingLog();
      const h = await harness({
        deps: {
          log,
          onMergeCheck:
            mode === 'throw'
              ? () => {
                  throw new Error('boom');
                }
              : () => Promise.reject(new Error('boom')),
        },
      });
      const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
      const job = await h.finished(jobId);
      await new Promise((r) => setTimeout(r, 10));
      expect(h.queue.get(jobId)?.status, mode).toBe('done');
      expect(job.failure).toBeUndefined();
      expect(
        h.done.filter((d) => d.jobId === jobId),
        mode,
      ).toHaveLength(1);
      expect(
        log.warns.map((w) => w.event),
        mode,
      ).toContain('pipeline.merge-check-failed');
      expect(h.lib.list()).toHaveLength(1);
    }
  });
});

describe('job storage (06 §9.1)', () => {
  it('keeps records and staging under <userData>/jobs/ with no credentials, and nothing job-related in the library', async () => {
    // Sentinel API key assembled at runtime (13: no secret-shaped literals in the repo).
    const sentinel = ['sk', 'ant', 'api03', 'SENTINEL', 'x'.repeat(24)].join('-');
    const keyStore = new Map([['claude', sentinel]]);
    let scanned: [string, string][] = [];
    const h = await harness({
      deps: { hasApiKey: async () => keyStore.has('claude') },
      tasks: (t) => ({
        ...t,
        summarize: async (d, s) => {
          scanned = await allFiles(path.join(h.userData, 'jobs'));
          return t.summarize(d, s);
        },
      }),
    });
    const prev = process.env.ELI5_TEST_SENTINEL_KEY;
    process.env.ELI5_TEST_SENTINEL_KEY = sentinel;
    try {
      const { jobId } = await h.queue.start({
        inputs: [fileInput('sources/text/notes.md'), urlInput('https://example.com/widgets')],
        options: opts,
      });
      const job = await h.finished(jobId);
      expect(job.status).toBe('done');
      // Mid-run: the record, inputs, extracted and gen artifacts all live under jobs/.
      const names = scanned.map(([p]) => path.relative(path.join(h.userData, 'jobs'), p));
      expect(names).toContain(`${jobId}.json`);
      expect(names.some((n) => n.startsWith(`${jobId}/inputs/`))).toBe(true);
      expect(names.some((n) => n.startsWith(`${jobId}/extracted/`))).toBe(true);
      expect(names.some((n) => n.startsWith(`${jobId}/gen/`))).toBe(true);
      const after = await allFiles(path.join(h.userData, 'jobs'));
      for (const [p, text] of [...scanned, ...after]) expect(text.includes(sentinel), p).toBe(false);
      // The library holds only the document folder, the catalog and its own staging root.
      const lib = await allFiles(h.lib.root);
      expect(lib.some(([p]) => path.basename(p) === `${jobId}.json`)).toBe(false);
      expect(lib.some(([p]) => /[\\/](jobs|inputs|extracted|gen)[\\/]/.test(path.relative(h.lib.root, p)))).toBe(false);
      for (const [p, text] of lib) expect(text.includes(sentinel), p).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ELI5_TEST_SENTINEL_KEY;
      else process.env.ELI5_TEST_SENTINEL_KEY = prev;
    }
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
