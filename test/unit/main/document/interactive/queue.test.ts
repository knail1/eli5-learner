import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createInteractiveReading,
  mirrorTabs,
  parseDocument,
  replaceSection,
  type InteractiveReading,
} from '../../../../../src/main/document';
import type { DocumentDraftTab, SectionDraft } from '../../../../../src/main/llm';
import type { SectionBusyEvent } from '../../../../../src/preload/contract';
import { makeMeta } from '../../library/fixtures';
import { harness } from '../../pipeline/harness';
import { FakeViewer, NEW_SECTION, NEW_TAB, fixture, render, sec } from './harness';

/** 08 end to end through the real JobQueue (06 §8.2) and a real library, with a fake model. */

async function wired() {
  const ref: { ir?: InteractiveReading } = {};
  const h = await harness({
    deps: {
      sectionRunner: (ctx) => {
        if (!ref.ir) throw new Error('not wired');
        return ref.ir.runner(ctx);
      },
    },
  });
  const r = await h.lib.allocateSlug('Example Widgets');
  const staging = await h.lib.stagingDir('job-seed');
  await writeFile(path.join(staging, 'index.html'), render(fixture.model));
  const meta = makeMeta({ title: 'Example Widgets', topicSlug: r.slug, tabs: mirrorTabs(fixture.model.tabs) });
  await writeFile(path.join(staging, 'meta.json'), JSON.stringify(meta));
  await h.lib.commitDocument(r, staging, meta);
  const viewer = new FakeViewer(r.slug);
  const runSectionAction = vi.fn(async (i: { action: string }): Promise<SectionDraft | DocumentDraftTab> =>
    i.action === 'eli5-tab' ? NEW_TAB : NEW_SECTION,
  );
  const ir = createInteractiveReading({
    library: h.lib,
    tasks: { runSectionAction },
    viewer,
    clock: h.clock,
    sectionIds: h.deps.sectionIds,
  });
  ref.ir = ir;
  ir.attachJobs(h.queue);
  const busy: SectionBusyEvent[] = [];
  ir.actions.onSectionBusy((e) => busy.push(e));
  return { h, ir, slug: r.slug, viewer, busy, runSectionAction };
}

describe('section jobs through the JobQueue (06 §8.2, 08 §6)', () => {
  it('regenerates in place with the status lines of 06 §6 and clears the busy state', async () => {
    const w = await wired();
    const id = sec(fixture.model, 0, 0);
    const heading = fixture.model.tabs[0]?.sections[0]?.heading ?? '';
    const { jobId } = await w.ir.actions.regenerateSection({
      slug: w.slug,
      tabKey: 'indepth',
      sectionId: id,
      action: 'expand',
      selectionText: 'judges every channel',
    });
    const job = await w.h.finished(jobId);
    expect(job.status).toBe('done');
    expect(w.h.lines(jobId).at(-1)).toBe(`Updated: ${heading}`);
    const { model } = parseDocument(await readFile(w.h.lib.docPath(w.slug), 'utf8'));
    expect(model.tabs[0]?.sections[0]).toMatchObject({ id, lastAction: 'expand' });
    expect(w.busy.at(-1)).toEqual({ busy: [] });
  });

  it('adds a section ELI5 tab and reports its label', async () => {
    const w = await wired();
    const { jobId } = await w.ir.actions.createSectionEli5({
      slug: w.slug,
      tabKey: 'indepth',
      sectionId: sec(fixture.model, 0, 1),
      selectionText: 'judges every channel',
    });
    const job = await w.h.finished(jobId);
    expect(job.status).toBe('done');
    expect(job.tabLabel).toBe('ELI5: How the budget moved');
  });

  it('fails SECTION_CHANGED after a hand edit, leaves the file alone and sends the notice', async () => {
    const w = await wired();
    const id = sec(fixture.model, 0, 0);
    w.runSectionAction.mockImplementationOnce(async () => {
      const edited = replaceSection(fixture.model, id, NEW_SECTION, undefined, '2026-03-01T00:00:00.000Z').model;
      await writeFile(w.h.lib.docPath(w.slug), render(edited));
      return NEW_SECTION;
    });
    const { jobId } = await w.ir.actions.regenerateSection({
      slug: w.slug,
      tabKey: 'indepth',
      sectionId: id,
      action: 'reexplain',
      selectionText: 'judges every channel',
    });
    const job = await w.h.finished(jobId);
    expect(job.failure?.code).toBe('SECTION_CHANGED');
    expect(w.h.lines(jobId).at(-1)).toBe('Failed: section changed, try again');
    expect(w.busy.at(-1)).toEqual({
      busy: [],
      notices: [{ sectionId: id, message: 'This section changed. Try again' }],
    });
  });

  it('retries a SECTION_CHANGED job from the status line with a fresh baseHash (08 §9)', async () => {
    const w = await wired();
    const id = sec(fixture.model, 0, 0);
    w.runSectionAction.mockImplementationOnce(async () => {
      const edited = replaceSection(fixture.model, id, NEW_SECTION, undefined, '2026-03-01T00:00:00.000Z').model;
      await writeFile(w.h.lib.docPath(w.slug), render(edited));
      return NEW_SECTION;
    });
    const { jobId } = await w.ir.actions.regenerateSection({
      slug: w.slug,
      tabKey: 'indepth',
      sectionId: id,
      action: 'reexplain',
      selectionText: 'judges every channel',
    });
    expect((await w.h.finished(jobId)).failure?.code).toBe('SECTION_CHANGED');
    expect(w.h.queue.list().find((j) => j.id === jobId)?.canRetry).toBe(true);
    await w.h.queue.retry(jobId);
    const job = await w.h.finished(jobId);
    expect(job.status).toBe('done');
    const { model } = parseDocument(await readFile(w.h.lib.docPath(w.slug), 'utf8'));
    expect(model.tabs[0]?.sections[0]).toMatchObject({ id, lastAction: 'reexplain' });
    expect(w.busy.at(-1)).toEqual({ busy: [] });
  });

  it('a retried job fails fast while another action holds its section, and never frees that hold (08 §8.1)', async () => {
    const w = await wired();
    const id = sec(fixture.model, 0, 0);
    const base = { slug: w.slug, tabKey: 'indepth', sectionId: id, selectionText: 'judges every channel' };
    w.runSectionAction.mockRejectedValueOnce(new Error('boom'));
    const x = await w.ir.actions.regenerateSection({ ...base, action: 'expand' });
    expect((await w.h.finished(x.jobId)).status).toBe('failed');
    // Y takes the section and is held in generating until released.
    let releaseY: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseY = r));
    w.runSectionAction.mockImplementationOnce(async () => {
      await gate;
      return NEW_SECTION;
    });
    const y = await w.ir.actions.regenerateSection({ ...base, action: 'analogy' });
    await w.h.queue.retry(x.jobId);
    expect(w.busy.at(-1)?.busy).toEqual([{ sectionId: id, action: 'analogy' }]);
    releaseY();
    expect((await w.h.finished(y.jobId)).status).toBe('done');
    const xs = await w.h.finished(x.jobId);
    expect(xs.status).toBe('failed');
    expect(w.runSectionAction).toHaveBeenCalledTimes(2);
    const { model } = parseDocument(await readFile(w.h.lib.docPath(w.slug), 'utf8'));
    expect(model.tabs[0]?.sections[0]).toMatchObject({ id, lastAction: 'analogy' });
    expect(w.busy.at(-1)?.busy).toEqual([]);
  });
});
