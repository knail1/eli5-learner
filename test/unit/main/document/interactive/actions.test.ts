import { describe, expect, it } from 'vitest';
import {
  MAX_SECTION_ELI5_TABS,
  addSectionEli5Tab,
  parseDocument,
  sectionHash,
  type DocumentModel,
} from '../../../../../src/main/document';
import { PipelineRequestError } from '../../../../../src/main/pipeline';
import { SeededIdSource } from '../../../../helpers/ids';
import { NEW_TAB, fixture, rejection, req, sec, setup } from './harness';

/** Request handling for `eli5:doc:regenerate-section` / `create-section-eli5` (08 §6.1). */

function withSxTabs(n: number): DocumentModel {
  let m = fixture.model;
  const ids = new SeededIdSource(7);
  while (m.tabs.filter((t) => t.kind === 'section-eli5').length < n) {
    m = addSectionEli5Tab(m, sec(m, 0, 0), 'Example Widgets', NEW_TAB, '2026-09-27T14:00:00.000Z', {
      idSource: ids,
    }).model;
  }
  return m;
}

describe('regenerateSection (08 §6.1)', () => {
  it('enqueues a SectionJobPayload with heading and baseHash and marks the section busy', async () => {
    const s = await setup();
    const section = s.model.tabs[0]?.sections[0];
    const r = await s.ir.actions.regenerateSection(req(s, { note: 'shorter please' }));
    expect(r).toEqual({ jobId: 'job-s1' });
    expect(s.jobs.enqueueSection).toHaveBeenCalledWith({
      slug: s.slug,
      tabKey: 'indepth',
      sectionId: section?.id,
      action: 'expand',
      selectionText: 'judges every channel',
      note: 'shorter please',
      heading: section?.heading,
      baseHash: section && sectionHash(section),
    });
    expect(s.events.busy.at(-1)).toEqual({ busy: [{ sectionId: section?.id, action: 'expand' }] });
  });

  it('computes baseHash from the model on disk, not from the request', async () => {
    const s = await setup();
    await s.ir.actions.regenerateSection(req(s));
    const parsed = parseDocument(await s.read()).model.tabs[0]?.sections[0];
    expect(s.jobs.enqueueSection.mock.calls[0]?.[0].baseHash).toBe(parsed && sectionHash(parsed));
  });

  it('refuses a slug other than the viewer document with E_FORBIDDEN', async () => {
    const s = await setup();
    s.viewer.slug = 'other-doc';
    expect(await rejection(s.ir.actions.regenerateSection(req(s)))).toMatchObject({ code: 'E_FORBIDDEN' });
    expect(s.jobs.enqueueSection).not.toHaveBeenCalled();
  });

  it('refuses the 11th action on one document within 60 s with E_RATE_LIMITED', async () => {
    const s = await setup();
    for (let i = 0; i < 10; i++) {
      const { jobId } = await s.ir.actions.regenerateSection(req(s));
      s.jobs.emit(jobId, 'done');
      s.clock.advance(1000);
    }
    expect(await rejection(s.ir.actions.regenerateSection(req(s)))).toMatchObject({
      code: 'E_RATE_LIMITED',
      message: 'Too many requests; wait a moment',
    });
    s.clock.advance(51_000);
    expect(await s.ir.actions.regenerateSection(req(s))).toMatchObject({ jobId: 'job-s11' });
  });

  it('counts only accepted requests towards the rate limit', async () => {
    const s = await setup();
    s.hasApiKey.mockResolvedValue(false);
    for (let i = 0; i < 12; i++) await rejection(s.ir.actions.regenerateSection(req(s)));
    s.hasApiKey.mockResolvedValue(true);
    expect(await s.ir.actions.regenerateSection(req(s))).toMatchObject({ jobId: 'job-s1' });
  });

  it('returns E_NOT_FOUND "This document no longer exists" for an uncatalogued document', async () => {
    const s = await setup();
    await s.lib.trashDocument(s.slug);
    expect(await rejection(s.ir.actions.regenerateSection(req(s)))).toMatchObject({
      code: 'E_NOT_FOUND',
      message: 'This document no longer exists',
    });
  });

  it('refuses a second action on a busy section; other sections still queue', async () => {
    const s = await setup();
    await s.ir.actions.regenerateSection(req(s));
    expect(await rejection(s.ir.actions.createSectionEli5(req(s, { action: undefined })))).toMatchObject({
      code: 'E_CONFLICT',
      message: 'This section is already being updated',
    });
    const other = sec(s.model, 0, 1);
    expect(await s.ir.actions.regenerateSection(req(s, { sectionId: other, action: 'deeper' }))).toEqual({
      jobId: 'job-s2',
    });
    expect(s.events.busy.at(-1)).toEqual({
      busy: [
        { sectionId: sec(s.model, 0, 0), action: 'expand' },
        { sectionId: other, action: 'deeper' },
      ],
    });
  });

  it('returns E_NO_API_KEY when no key is configured, before queuing', async () => {
    const s = await setup();
    s.hasApiKey.mockResolvedValue(false);
    expect(await rejection(s.ir.actions.regenerateSection(req(s)))).toMatchObject({
      code: 'E_NO_API_KEY',
      message: 'Add an API key in Settings',
    });
    expect(s.jobs.enqueueSection).not.toHaveBeenCalled();
  });

  it('refuses a document whose embedded model is invalid: "This document can\'t be edited"', async () => {
    const s = await setup();
    await s.write(s.html.replace(/(<script type="application\/json" id="eli5-model">)/, '$1{broken'));
    expect(await rejection(s.ir.actions.regenerateSection(req(s)))).toMatchObject({
      code: 'E_CONFLICT',
      message: "This document can't be edited",
    });
  });

  it('returns E_NOT_FOUND "This section changed. Reload and try again" for an unknown section', async () => {
    const s = await setup();
    expect(
      await rejection(s.ir.actions.regenerateSection(req(s, { sectionId: 'sec-indepth-00000000' }))),
    ).toMatchObject({ code: 'E_NOT_FOUND', message: 'This section changed. Reload and try again' });
  });

  it('refuses the references section with E_BAD_REQUEST', async () => {
    const s = await setup();
    const refs = s.model.tabs[0]?.sections.find((x) => x.kind === 'references');
    expect(await rejection(s.ir.actions.regenerateSection(req(s, { sectionId: refs?.id })))).toMatchObject({
      code: 'E_BAD_REQUEST',
    });
  });

  it('refuses a section outside the named tab with E_BAD_REQUEST', async () => {
    const s = await setup();
    expect(
      await rejection(s.ir.actions.regenerateSection(req(s, { tabKey: 'eli5', sectionId: sec(s.model, 0, 0) }))),
    ).toMatchObject({ code: 'E_BAD_REQUEST' });
  });

  it('passes the queue refusal through (read-only library) and frees the busy key', async () => {
    const s = await setup();
    s.jobs.enqueueError = new PipelineRequestError('E_LIBRARY_READ_ONLY', 'The Library is read-only');
    expect(await rejection(s.ir.actions.regenerateSection(req(s)))).toMatchObject({ code: 'E_LIBRARY_READ_ONLY' });
    s.jobs.enqueueError = undefined;
    expect(await s.ir.actions.regenerateSection(req(s))).toEqual({ jobId: 'job-s1' });
  });
});

describe('createSectionEli5 (08 §6.1 step 7)', () => {
  it('enqueues an eli5-tab job', async () => {
    const s = await setup();
    const { action: _a, ...r } = req(s);
    await s.ir.actions.createSectionEli5(r);
    expect(s.jobs.enqueueSection.mock.calls[0]?.[0]).toMatchObject({ action: 'eli5-tab', sectionId: r.sectionId });
    expect(s.events.busy.at(-1)).toEqual({ busy: [{ sectionId: r.sectionId, action: 'eli5-tab' }] });
  });

  it(`refuses when ${String(MAX_SECTION_ELI5_TABS)} section ELI5 tabs exist`, async () => {
    const s = await setup({ model: withSxTabs(MAX_SECTION_ELI5_TABS) });
    const { action: _a, ...r } = req(s);
    expect(await rejection(s.ir.actions.createSectionEli5(r))).toMatchObject({
      code: 'E_CONFLICT',
      message: 'Close a section ELI5 tab before adding another',
    });
  });
});

describe('busy tracking (08 §8)', () => {
  it('clears the busy key when the job ends and sends the failure notice (08 §9)', async () => {
    const s = await setup();
    const { jobId } = await s.ir.actions.regenerateSection(req(s));
    s.jobs.emit(jobId, 'generating');
    expect(s.events.busy.at(-1)).toEqual({ busy: [{ sectionId: sec(s.model, 0, 0), action: 'expand' }] });
    s.jobs.emit(jobId, 'failed', 'LLM_UNAVAILABLE');
    expect(s.events.busy.at(-1)).toEqual({
      busy: [],
      notices: [{ sectionId: sec(s.model, 0, 0), message: "Couldn't update this section. Try again" }],
    });
    expect(await s.ir.actions.regenerateSection(req(s))).toEqual({ jobId: 'job-s2' });
  });

  it('sends no notice for a cancelled job or a section that is gone', async () => {
    const s = await setup();
    const a = await s.ir.actions.regenerateSection(req(s));
    s.jobs.emit(a.jobId, 'failed', 'CANCELLED');
    expect(s.events.busy.at(-1)).toEqual({ busy: [] });
    const b = await s.ir.actions.regenerateSection(req(s));
    s.jobs.emit(b.jobId, 'failed', 'SECTION_GONE');
    expect(s.events.busy.at(-1)).toEqual({ busy: [] });
  });

  it('broadcasts only for the document in the viewer', async () => {
    const s = await setup();
    const { jobId } = await s.ir.actions.regenerateSection(req(s));
    const n = s.events.busy.length;
    s.viewer.slug = 'other-doc';
    s.jobs.emit(jobId, 'done');
    expect(s.events.busy.length).toBe(n);
  });

  it('rebuilds busy state from non-terminal section jobs at launch and on retry', async () => {
    const s = await setup();
    const id = sec(s.model, 0, 1);
    const payload = {
      slug: s.slug,
      tabKey: 'indepth',
      sectionId: id,
      action: 'analogy' as const,
      selectionText: 'x'.repeat(10),
      heading: 'h',
      baseHash: 'h',
    };
    const jobs = new (s.jobs.constructor as new () => typeof s.jobs)();
    jobs.seed('job-old', 'generating', payload);
    jobs.seed('job-done', 'done', { ...payload, sectionId: sec(s.model, 0, 0) });
    s.ir.attachJobs(jobs);
    expect(await rejection(s.ir.actions.regenerateSection(req(s, { sectionId: id })))).toMatchObject({
      code: 'E_CONFLICT',
    });
    expect(await s.ir.actions.regenerateSection(req(s))).toMatchObject({ jobId: 'job-s1' });
    // A user retry re-queues a failed job: it is busy again.
    jobs.emit('job-old', 'failed', 'SECTION_CHANGED');
    jobs.emit('job-old', 'queued');
    expect(s.events.busy.at(-1)).toMatchObject({
      busy: expect.arrayContaining([{ sectionId: id, action: 'analogy' }]),
    });
  });

  it('re-sends busy state after every viewer load (08 §8.3)', async () => {
    const s = await setup();
    await s.ir.actions.regenerateSection(req(s));
    const n = s.events.busy.length;
    s.viewer.load();
    expect(s.events.busy.length).toBe(n + 1);
    expect(s.events.busy.at(-1)).toEqual({ busy: [{ sectionId: sec(s.model, 0, 0), action: 'expand' }] });
  });
});
