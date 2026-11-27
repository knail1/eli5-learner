import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeadpanSource } from '../../../../src/main/llm';
import type { Job } from '../../../../src/main/pipeline';
import { validateDocument } from '../../../helpers/doc-validity';
import { defaultScript, fileInput, harness, type Harness } from './harness';

/**
 * Step 1c of the generating stage (06 §5.4): the optional Deadpan tab, after step 1b and before the
 * glossary, built from the STE tab (In depth when STE was omitted). It degrades with
 * `deadpan-omitted`; checkpoints gen/deadpan.json; a redone STE step makes it stale on resume.
 */

const on = { clarifyingInput: '', glossary: true, deadpan: true };
const jobsDir = (userData: string): string => path.join(userData, 'jobs');
const genFile = (h: Harness, jobId: string, name: string): string => path.join(jobsDir(h.userData), jobId, 'gen', name);

/** Starts a job whose summary never returns, waits for that step, then closes the queue. */
async function stopAtSummary(over: Parameters<typeof harness>[0] = {}): Promise<{ a: Harness; jobId: string }> {
  const a = await harness({
    ...over,
    tasks: (t) => ({ ...(over.tasks ? over.tasks(t) : t), summarize: () => new Promise(() => {}) }),
  });
  const { jobId } = await a.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: on });
  await new Promise<void>((resolve) => {
    const off = a.queue.on('changed', (s) => {
      if (s.id === jobId && s.statusLine === 'Generating document (finishing up)') {
        off();
        resolve();
      }
    });
  });
  await a.queue.close();
  return { a, jobId };
}

describe('generating step 1c (06 §5.4)', () => {
  it('runs after step 1b from the STE tab and adds a Deadpan tab after it', async () => {
    const sources: DeadpanSource['kind'][] = [];
    const h = await harness({
      tasks: (t) => ({
        ...t,
        generateDeadpan: (source, ctx) => {
          sources.push(source.kind);
          return t.generateDeadpan(source, ctx);
        },
      }),
    });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: on });
    const job = await h.finished(jobId);
    expect(job.status).toBe('done');
    expect(job.warnings).toEqual([]);
    expect(job.progress.stepsPlanned).toEqual([
      'indepth',
      'eli5',
      'ste',
      'eli5-critique',
      'deadpan',
      'glossary',
      'summary',
    ]);
    expect(sources).toEqual(['ste']);
    const calls = h.fake.calls.map((c) => c.taskId);
    expect(calls.indexOf('deadpan')).toBeGreaterThan(calls.indexOf('ste'));
    expect(calls.indexOf('deadpan')).toBeGreaterThan(calls.indexOf('eli5-critique'));
    expect(calls.indexOf('deadpan')).toBeLessThan(calls.indexOf('glossary'));
    expect(h.lines(jobId)).toContain('Generating document (Deadpan version)');

    const slug = job.result?.topicSlug ?? '';
    const meta = await h.lib.getMeta(slug);
    expect(meta.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5', 'ste', 'deadpan']);
    expect(meta.tabs.find((t) => t.key === 'deadpan')?.kind).toBe('deadpan');
    expect(meta.deadpanEnabled).toBe(true);
    expect(meta.generation.prompts.some((p) => p.startsWith('deadpan@'))).toBe(true);
    const html = await readFile(h.lib.docPath(slug), 'utf8');
    expect(validateDocument(html, meta).errors).toEqual([]);
    expect(html).toContain('id="tab-deadpan"');
  });

  it('is not planned or called when the job does not ask for it', async () => {
    const h = await harness();
    const { jobId } = await h.queue.start({
      inputs: [fileInput('sources/text/notes.md')],
      options: { clarifyingInput: '', glossary: true },
    });
    const job = await h.finished(jobId);
    expect(job.status).toBe('done');
    expect(job.progress.stepsPlanned).not.toContain('deadpan');
    expect(h.fake.calls.map((c) => c.taskId)).not.toContain('deadpan');
    const meta = await h.lib.getMeta(job.result?.topicSlug ?? '');
    expect(meta.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5', 'ste']);
    expect(meta.deadpanEnabled).toBeUndefined();
  });

  it('falls back to the In depth draft when the STE step was omitted', async () => {
    const sources: DeadpanSource['kind'][] = [];
    const h = await harness({
      script: defaultScript({ errors: { ste: 'server' } }),
      tasks: (t) => ({
        ...t,
        generateDeadpan: (source, ctx) => {
          sources.push(source.kind);
          return t.generateDeadpan(source, ctx);
        },
      }),
    });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: on });
    const job = await h.finished(jobId);
    expect(job.status).toBe('done');
    expect(sources).toEqual(['indepth']);
    expect(job.warnings.map((w) => w.kind)).toEqual(['ste-omitted']);
    const meta = await h.lib.getMeta(job.result?.topicSlug ?? '');
    expect(meta.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5', 'deadpan']);
    const html = await readFile(h.lib.docPath(job.result?.topicSlug ?? ''), 'utf8');
    expect(validateDocument(html, meta).errors).toEqual([]);
  });

  it('a failed Deadpan step finishes the job with the deadpan-omitted note', async () => {
    const h = await harness({ script: defaultScript({ errors: { deadpan: 'server' } }) });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: on });
    const job = await h.finished(jobId);
    expect(job.status).toBe('done');
    expect(job.warnings).toEqual([{ kind: 'deadpan-omitted', message: 'The Deadpan tab could not be generated' }]);
    expect(h.lines(jobId).at(-1)).toMatch(/ · with notes$/);
    const meta = await h.lib.getMeta(job.result?.topicSlug ?? '');
    expect(meta.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5', 'ste']);
    expect(meta.deadpanEnabled).toBe(true);
    expect(meta.generation.prompts.some((p) => p.startsWith('deadpan@'))).toBe(false);
    expect(meta.warnings.map((w) => w.kind)).toEqual(['deadpan-omitted']);
  });

  it('a resumed job with step 1c checkpointed does not call it again', async () => {
    const { a, jobId } = await stopAtSummary();
    const rec = JSON.parse(await readFile(path.join(jobsDir(a.userData), `${jobId}.json`), 'utf8')) as Job;
    expect(rec.checkpoint?.completedSteps).toEqual(expect.arrayContaining(['ste', 'deadpan']));
    const b = await harness({ from: a });
    const job = await b.finished(jobId);
    expect(job.status).toBe('done');
    expect(b.fake.calls.map((c) => c.taskId)).toEqual(['summary']);
    const meta = await b.lib.getMeta(job.result?.topicSlug ?? '');
    expect(meta.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5', 'ste', 'deadpan']);
  });

  it('a resume that redoes the STE step redoes Deadpan too (its draft was built from the old STE)', async () => {
    const { a, jobId } = await stopAtSummary();
    await rm(genFile(a, jobId, 'ste.json'));
    const b = await harness({ from: a });
    const job = await b.finished(jobId);
    expect(job.status).toBe('done');
    expect(b.fake.calls.map((c) => c.taskId).sort()).toEqual(['deadpan', 'ste', 'summary']);
    const meta = await b.lib.getMeta(job.result?.topicSlug ?? '');
    expect(meta.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5', 'ste', 'deadpan']);
  });

  it('a resume that lost gen/deadpan.json runs only step 1c again', async () => {
    const { a, jobId } = await stopAtSummary();
    await rm(genFile(a, jobId, 'deadpan.json'));
    const b = await harness({ from: a });
    const job = await b.finished(jobId);
    expect(job.status).toBe('done');
    expect(b.fake.calls.map((c) => c.taskId).sort()).toEqual(['deadpan', 'summary']);
  });

  it('a re-run Deadpan step that succeeds clears the earlier deadpan-omitted warning', async () => {
    const { a, jobId } = await stopAtSummary({ script: defaultScript({ errors: { deadpan: 'server' } }) });
    const rec = JSON.parse(await readFile(path.join(jobsDir(a.userData), `${jobId}.json`), 'utf8')) as Job;
    expect(rec.warnings.map((w) => w.kind)).toEqual(['deadpan-omitted']);
    await rm(genFile(a, jobId, 'deadpan.json'));
    const b = await harness({ from: a });
    const job = await b.finished(jobId);
    expect(job.status).toBe('done');
    expect(job.warnings).toEqual([]);
    const meta = await b.lib.getMeta(job.result?.topicSlug ?? '');
    expect(meta.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5', 'ste', 'deadpan']);
  });
});
