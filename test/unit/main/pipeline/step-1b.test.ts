import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DocumentDraftTab, LlmTasks } from '../../../../src/main/llm';
import type { Job } from '../../../../src/main/pipeline';
import type { Logger, LogFields } from '../../../../src/main/security';
import { validateDocument } from '../../../helpers/doc-validity';
import { defaultScript, fileInput, harness } from './harness';

/**
 * Step 1b of the generating stage (06 §5.4): the ASD-STE100 tab and the ELI5 critique run after
 * step 1 and concurrently; both degrade without failing the job; checkpoints gen/ste.json and
 * gen/eli5-critique.json; per-step usage logging (D25).
 */

const opts = { clarifyingInput: '', glossary: true };
const jobsDir = (userData: string): string => path.join(userData, 'jobs');

function recordingLog(): Logger & { lines: { level: string; event: string; fields?: LogFields }[] } {
  const lines: { level: string; event: string; fields?: LogFields }[] = [];
  const at =
    (level: string) =>
    (event: string, fields?: LogFields): void => {
      lines.push({ level, event, ...(fields ? { fields } : {}) });
    };
  return { lines, info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
}

describe('generating step 1b (06 §5.4)', () => {
  it('runs after step 1, the STE and critique calls overlap, and the glossary follows both', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    const both = (): void => {
      if (++started === 2) release();
    };
    const wrap = (t: LlmTasks): LlmTasks => ({
      ...t,
      generateIndepth: async (...a) => {
        const r = await t.generateIndepth(...a);
        order.push('indepth:end');
        return r;
      },
      generateSte: async (...a) => {
        order.push('ste:start');
        both();
        await gate; // finishes only once the critique has started too
        const r = await t.generateSte(...a);
        order.push('ste:end');
        return r;
      },
      critiqueEli5: async (...a) => {
        order.push('critique:start');
        both();
        await gate;
        const r = await t.critiqueEli5(...a);
        order.push('critique:end');
        return r;
      },
      generateGlossary: async (...a) => {
        order.push('glossary:start');
        return t.generateGlossary(...a);
      },
    });
    const h = await harness({ tasks: wrap });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    const job = await h.finished(jobId);
    expect(job.status).toBe('done');
    expect(order[0]).toBe('indepth:end');
    expect(order.slice(1, 3).sort()).toEqual(['critique:start', 'ste:start']);
    expect(order.slice(3, 5).sort()).toEqual(['critique:end', 'ste:end']);
    expect(order[5]).toBe('glossary:start');
    expect(h.lines(jobId)).toContain('Generating document (ASD-STE100 version, simplifying the ELI5 version)');
    // The STE call sees the final In depth draft; the critique sees the ELI5 draft and the outline.
    const taskOrder = h.fake.calls.map((c) => c.taskId);
    expect(taskOrder.indexOf('ste')).toBeGreaterThan(taskOrder.indexOf('in-depth'));
    expect(taskOrder.indexOf('eli5-critique')).toBeGreaterThan(taskOrder.indexOf('eli5'));

    const slug = job.result?.topicSlug ?? '';
    const meta = await h.lib.getMeta(slug);
    expect(meta.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5', 'ste']);
    expect(meta.generation.prompts).toEqual(expect.arrayContaining(['ste@1', 'eli5-critique@1']));
    expect(meta.warnings).toEqual([]);
    const html = await readFile(h.lib.docPath(slug), 'utf8');
    expect(validateDocument(html, meta).errors).toEqual([]);
    expect(html).toContain('The team makes the forecast in four steps'); // STE text
    expect(html).toContain('Why the pile grows'); // the accepted critique revision
    expect(html).toContain('id="tab-hint-ste"');
  });

  it('an STE failure finishes the job with two tabs and the ste-omitted note', async () => {
    const log = recordingLog();
    const h = await harness({ script: defaultScript({ errors: { ste: 'server' } }), deps: { log } });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    const job = await h.finished(jobId);
    expect(job.status).toBe('done');
    expect(job.warnings.map((w) => w.kind)).toEqual(['ste-omitted']);
    expect(h.lines(jobId).at(-1)).toBe('Done: How Example Widgets Inc. Plans Its Widget Supply · with notes');
    const meta = await h.lib.getMeta(job.result?.topicSlug ?? '');
    expect(meta.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5']);
    expect(meta.warnings.map((w) => w.kind)).toEqual(['ste-omitted']);
    expect(meta.generation.prompts).not.toContain('ste@1');
    expect(log.lines).toContainEqual({
      level: 'warn',
      event: 'pipeline.step-degraded',
      fields: { jobId, step: 'ste', errorKind: 'server' },
    });
    const html = await readFile(h.lib.docPath(job.result?.topicSlug ?? ''), 'utf8');
    expect(validateDocument(html, meta).errors).toEqual([]);
    expect(html).not.toContain('id="tab-ste"');
  });

  it('a failed or rejected critique keeps the first ELI5 draft, with no user-facing note', async () => {
    for (const variant of ['failed', 'rejected'] as const) {
      const log = recordingLog();
      const s = defaultScript();
      const weak = structuredClone(s.responses['eli5-critique']) as DocumentDraftTab;
      weak.sections.push(...structuredClone(weak.sections), ...structuredClone(weak.sections)); // 9 sections
      const script =
        variant === 'failed'
          ? defaultScript({ errors: { 'eli5-critique': 'invalid_output' } })
          : { ...s, responses: { ...s.responses, 'eli5-critique': weak as never } };
      const h = await harness({ script, deps: { log } });
      const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
      const job = await h.finished(jobId);
      expect(job.status, variant).toBe('done');
      expect(job.warnings, variant).toEqual([]);
      const meta = await h.lib.getMeta(job.result?.topicSlug ?? '');
      expect(meta.generation.prompts, variant).not.toContain('eli5-critique@1');
      expect(meta.tabs.find((t) => t.key === 'eli5')?.sectionCount, variant).toBe(2);
      const html = await readFile(h.lib.docPath(job.result?.topicSlug ?? ''), 'utf8');
      expect(html, variant).toContain('before they buy them.');
      expect(html, variant).not.toContain('Why the pile grows');
      const event = variant === 'failed' ? 'pipeline.step-degraded' : 'pipeline.eli5-critique-rejected';
      expect(
        log.lines.some((l) => l.event === event && (variant === 'rejected' || l.fields?.step === 'eli5-critique')),
        variant,
      ).toBe(true);
    }
  });

  it('skips the critique when the ELI5 draft is a placeholder', async () => {
    const h = await harness({ script: defaultScript({ errors: { eli5: 'server' } }) });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    const job = await h.finished(jobId);
    expect(job.status).toBe('done');
    expect(h.fake.calls.map((c) => c.taskId)).not.toContain('eli5-critique');
    expect(job.warnings.map((w) => w.kind)).toEqual(['eli5-placeholder']);
    const meta = await h.lib.getMeta(job.result?.topicSlug ?? '');
    expect(meta.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5', 'ste']);
  });

  it('logs token usage for every LLM step (D25)', async () => {
    const log = recordingLog();
    const h = await harness({ deps: { log } });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    expect((await h.finished(jobId)).status).toBe('done');
    const usage = log.lines.filter((l) => l.event === 'pipeline.usage');
    expect(usage.map((l) => l.fields?.step).sort()).toEqual(
      ['eli5', 'eli5-critique', 'glossary', 'indepth', 'ste', 'summary'].sort(),
    );
    for (const l of usage) {
      expect(Object.keys(l.fields ?? {}).sort()).toEqual(['cacheRead', 'inputTokens', 'jobId', 'outputTokens', 'step']);
      expect(l.fields?.inputTokens).toBeGreaterThan(0);
    }
  });

  it('logs the tokens of a failed step that already got a response (D25)', async () => {
    const log = recordingLog();
    // Every STE call overflows: the retry runs, then the step fails and the tab is omitted.
    const h = await harness({ script: defaultScript({ truncateTask: 'ste' }), deps: { log } });
    const { jobId } = await h.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    const job = await h.finished(jobId);
    expect(job.warnings.map((w) => w.kind)).toEqual(['ste-omitted']);
    const ste = log.lines.find((l) => l.event === 'pipeline.usage' && l.fields?.step === 'ste');
    expect(ste?.fields?.outputTokens).toBeGreaterThan(0);
  });

  it('a resumed record from before step 1b plans and runs the new steps', async () => {
    const a = await harness({ tasks: (t) => ({ ...t, summarize: () => new Promise(() => {}) }) });
    const { jobId } = await a.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    await new Promise<void>((resolve) => {
      const off = a.queue.on('changed', (s) => {
        if (s.id === jobId && s.statusLine === 'Generating document (finishing up)') {
          off();
          resolve();
        }
      });
    });
    await a.queue.close();
    // Rewrite the record as an older build wrote it: no 'ste' or 'eli5-critique' anywhere.
    const recPath = path.join(jobsDir(a.userData), `${jobId}.json`);
    const rec = JSON.parse(await readFile(recPath, 'utf8')) as Job;
    const old = (xs: string[]): string[] => xs.filter((x) => x !== 'ste' && x !== 'eli5-critique');
    rec.progress.stepsPlanned = old(rec.progress.stepsPlanned) as Job['progress']['stepsPlanned'];
    if (rec.checkpoint)
      rec.checkpoint.completedSteps = old(rec.checkpoint.completedSteps) as Job['progress']['stepsPlanned'];
    await writeFile(recPath, JSON.stringify(rec));
    await rm(path.join(jobsDir(a.userData), jobId, 'gen', 'ste.json'));
    await rm(path.join(jobsDir(a.userData), jobId, 'gen', 'eli5-critique.json'));

    const b = await harness({ from: a });
    const job = await b.finished(jobId);
    expect(job.status).toBe('done');
    expect(b.fake.calls.map((c) => c.taskId).sort()).toEqual(['eli5-critique', 'ste', 'summary']);
    expect(job.progress.stepsPlanned).toEqual(['indepth', 'eli5', 'ste', 'eli5-critique', 'glossary', 'summary']);
    const meta = await b.lib.getMeta(job.result?.topicSlug ?? '');
    expect(meta.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5', 'ste']);
  });

  it('a resumed job with step 1b checkpointed does not call it again', async () => {
    const a = await harness({ tasks: (t) => ({ ...t, summarize: () => new Promise(() => {}) }) });
    const { jobId } = await a.queue.start({ inputs: [fileInput('sources/text/notes.md')], options: opts });
    await new Promise<void>((resolve) => {
      const off = a.queue.on('changed', (s) => {
        if (s.id === jobId && s.statusLine === 'Generating document (finishing up)') {
          off();
          resolve();
        }
      });
    });
    await a.queue.close();
    // The persisted record checkpoints both step 1b steps (gen/ste.json, gen/eli5-critique.json).
    const rec = JSON.parse(await readFile(path.join(jobsDir(a.userData), `${jobId}.json`), 'utf8')) as Job;
    expect(rec.checkpoint?.completedSteps).toEqual(expect.arrayContaining(['ste', 'eli5-critique']));
    const b = await harness({ from: a });
    const job = await b.finished(jobId);
    expect(job.status).toBe('done');
    expect(b.fake.calls.map((c) => c.taskId)).toEqual(['summary']);
    const meta = await b.lib.getMeta(job.result?.topicSlug ?? '');
    expect(meta.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5', 'ste']);
  });
});
