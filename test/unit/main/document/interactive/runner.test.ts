import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SECTION_ELI5_TABS,
  addSectionEli5Tab,
  locateModelJson,
  locateSection,
  parseDocument,
  removeTab,
  replaceSection,
  type IdSource,
  type SectionId,
} from '../../../../../src/main/document';
import type { DocumentMeta } from '../../../../../src/main/library';
import { LLMError } from '../../../../../src/main/llm';
import { PipelineFailure } from '../../../../../src/main/pipeline';
import { SeededIdSource } from '../../../../helpers/ids';
import { NEW_SECTION, NEW_TAB, fixture, rejection, render, req, sec, setup, type Setup } from './harness';

/** The section runner (08 §6.2-§6.4, §7.1): generate, then parse -> mutate -> render -> write. */

const meta = async (s: Setup): Promise<DocumentMeta> =>
  JSON.parse(await readFile(s.lib.docPath(s.slug, 'meta.json'), 'utf8')) as DocumentMeta;

async function queued(s: Setup, over: Record<string, unknown> = {}) {
  const r = req(s, over);
  const { jobId } =
    r.action === ('eli5-tab' as string)
      ? await s.ir.actions.createSectionEli5({ ...r, action: undefined } as never)
      : await s.ir.actions.regenerateSection(r);
  return jobId;
}

async function failure(p: Promise<unknown>): Promise<{ code: string; detail?: string }> {
  const e = await rejection(p);
  expect(e).toBeInstanceOf(PipelineFailure);
  return e as unknown as PipelineFailure;
}

/** Everything outside the target <section> and the #eli5-model JSON. */
function outside(html: string, id: SectionId): string {
  const s = locateSection(html, id);
  const m = locateModelJson(html);
  if (!s || !m) throw new Error('not found');
  const [a, b] = s.start < m.start ? [s, m] : [m, s];
  return html.slice(0, a.start) + '<A/>' + html.slice(a.end, b.start) + '<B/>' + html.slice(b.end);
}

describe('in-place actions (08 §6.2, §6.4)', () => {
  it('replaces only the target section, keeps its SectionId and records the action', async () => {
    const s = await setup();
    const id = sec(s.model, 0, 0);
    const jobId = await queued(s, { note: 'shorter please' });
    const { ctx, steps } = s.ctx(jobId);
    const out = await s.ir.runner(ctx);
    const html = await s.read();
    // 07 §5.5: only the target section, the model JSON and updatedAt may differ.
    const reference = render({ ...s.model, updatedAt: '2026-09-28T10:00:00.000Z' });
    expect(outside(html, id)).toBe(outside(reference, id));
    const { model } = parseDocument(html);
    const target = model.tabs[0]?.sections[0];
    expect(target).toMatchObject({
      id,
      heading: NEW_SECTION.heading,
      origin: 'regenerated',
      lastAction: 'expand',
      updatedAt: '2026-09-28T10:00:00.000Z',
    });
    expect(model.tabs.flatMap((t) => t.sections.map((x) => x.id))).toEqual(
      s.model.tabs.flatMap((t) => t.sections.map((x) => x.id)),
    );
    expect(steps).toEqual(['saving', 'commit']);
    const m = await meta(s);
    expect(m.actions).toEqual([
      {
        at: '2026-09-28T10:00:00.000Z',
        action: 'expand',
        sectionId: id,
        tabKey: 'indepth',
        note: 'shorter please',
        jobId,
      },
    ]);
    expect(JSON.stringify(m)).not.toContain('judges every channel');
    expect(m.tabs.map((t) => t.key)).toEqual(s.model.tabs.map((t) => t.key));
    expect(out).toEqual({ result: { docId: m.id, topicSlug: s.slug, title: m.title } });
    expect(s.events.updated).toEqual([{ slug: s.slug, sectionId: id, tabKey: 'indepth' }]);
    expect(s.events.busy.at(-1)).toEqual({ busy: [] });
  });

  it('sends the section, its neighbours, the outline and the register to runSectionAction', async () => {
    const s = await setup();
    const signal = new AbortController().signal;
    const jobId = await queued(s, { sectionId: sec(s.model, 0, 1), action: 'deeper', note: 'with numbers' });
    await s.ir.runner(s.ctx(jobId, signal).ctx);
    const input = s.runSectionAction.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    const content = s.model.tabs[0]?.sections.filter((x) => x.kind === 'content') ?? [];
    expect(input).toMatchObject({
      action: 'deeper',
      tabKind: 'indepth',
      selection: 'judges every channel',
      note: 'with numbers',
      outline: content.map((x) => x.heading),
      section: { heading: content[1]?.heading },
      prev: { heading: content[0]?.heading },
      next: { heading: content[2]?.heading },
    });
    expect(input.signal).toBe(signal);
    expect(input).not.toHaveProperty('sourceExcerpt');
  });

  it('works inside the ELI5 tab with the ELI5 register', async () => {
    const s = await setup();
    const id = sec(s.model, 1, 0);
    const jobId = await queued(s, { tabKey: 'eli5', sectionId: id, action: 'analogy' });
    await s.ir.runner(s.ctx(jobId).ctx);
    expect(s.runSectionAction.mock.calls[0]?.[0]).toMatchObject({ tabKind: 'eli5' });
    const { model } = parseDocument(await s.read());
    expect(model.tabs[1]?.sections[0]).toMatchObject({ id, lastAction: 'analogy' });
    expect(model.glossary).toEqual(s.model.glossary);
  });

  it('fails with SECTION_CHANGED when the section changed outside the app; nothing is written', async () => {
    const s = await setup();
    const id = sec(s.model, 0, 0);
    const jobId = await queued(s);
    const edited = replaceSection(
      s.model,
      id,
      { heading: 'Hand edit', blocks: [{ type: 'paragraph', md: 'Edited by hand at Example Widgets.' }] },
      undefined,
      '2026-09-28T09:00:00.000Z',
    ).model;
    await s.writeModel(edited);
    const before = await s.read();
    const metaBefore = await meta(s);
    expect((await failure(s.ir.runner(s.ctx(jobId).ctx))).code).toBe('SECTION_CHANGED');
    expect(await s.read()).toBe(before);
    expect(await meta(s)).toEqual(metaBefore);
    expect(s.events.updated).toEqual([]);
  });

  it('a user retry takes a fresh baseHash, so the retried action applies to the edited section (08 §9)', async () => {
    const s = await setup();
    const id = sec(s.model, 0, 0);
    const jobId = await queued(s);
    await s.writeModel(replaceSection(s.model, id, NEW_SECTION, undefined, '2026-09-28T09:00:00.000Z').model);
    expect((await failure(s.ir.runner(s.ctx(jobId).ctx))).code).toBe('SECTION_CHANGED');
    s.jobs.emit(jobId, 'failed', 'SECTION_CHANGED');
    s.jobs.emit(jobId, 'queued'); // eli5:jobs:retry
    await s.ir.runner(s.ctx(jobId).ctx);
    expect(parseDocument(await s.read()).model.tabs[0]?.sections[0]?.lastAction).toBe('expand');
    // A crash resume (no failed -> queued in this process) keeps the request-time hash.
    s.jobs.emit(jobId, 'done');
    const next = await queued(s);
    await s.writeModel(replaceSection(parseDocument(await s.read()).model, id, NEW_SECTION, undefined, 'x').model);
    expect((await failure(s.ir.runner(s.ctx(next).ctx))).code).toBe('SECTION_CHANGED');
  });

  it('is idempotent after the write: a resumed job that already committed does not run again (06 §9.4)', async () => {
    const s = await setup();
    const jobId = await queued(s);
    const first = await s.ir.runner(s.ctx(jobId).ctx);
    const html = await s.read();
    // Crash after updateDocument, before the queue persisted done: the job runs once more.
    const again = await s.ir.runner(s.ctx(jobId).ctx);
    expect(again).toEqual(first);
    expect(await s.read()).toBe(html);
    expect(s.runSectionAction).toHaveBeenCalledTimes(1);
    expect((await meta(s)).actions?.filter((a) => a.jobId === jobId)).toHaveLength(1);
  });

  it('passes the precondition when a different section changed meanwhile', async () => {
    const s = await setup();
    const jobId = await queued(s);
    const other = sec(s.model, 0, 1);
    await s.writeModel(replaceSection(s.model, other, NEW_SECTION, 'deeper', '2026-09-28T09:00:00.000Z').model);
    await s.ir.runner(s.ctx(jobId).ctx);
    const { model } = parseDocument(await s.read());
    expect(model.tabs[0]?.sections[0]?.lastAction).toBe('expand');
    expect(model.tabs[0]?.sections[1]?.lastAction).toBe('deeper');
  });

  it('fails with SECTION_GONE when the section was removed before generation or save', async () => {
    const s = await setup();
    const sx = s.model.tabs[2];
    const id = sec(s.model, 2, 0);
    const jobId = await queued(s, { tabKey: sx?.key, sectionId: id });
    await s.writeModel(removeTab(s.model, sx?.key ?? '', '2026-09-28T09:00:00.000Z'));
    expect((await failure(s.ir.runner(s.ctx(jobId).ctx))).code).toBe('SECTION_GONE');
    // Removed while the model was running.
    const s2 = await setup();
    const job2 = await queued(s2, { tabKey: sx?.key, sectionId: id });
    s2.runSectionAction.mockImplementationOnce(async () => {
      await s2.writeModel(removeTab(s2.model, sx?.key ?? '', '2026-09-28T09:00:00.000Z'));
      return NEW_SECTION;
    });
    expect((await failure(s2.ir.runner(s2.ctx(job2).ctx))).code).toBe('SECTION_GONE');
  });

  it('fails with DOC_GONE when the document was deleted or merged away', async () => {
    const s = await setup();
    const jobId = await queued(s);
    s.runSectionAction.mockImplementationOnce(async () => {
      await s.lib.trashDocument(s.slug);
      return NEW_SECTION;
    });
    expect((await failure(s.ir.runner(s.ctx(jobId).ctx))).code).toBe('DOC_GONE');
    const s2 = await setup();
    const job2 = await queued(s2);
    await s2.lib.trashDocument(s2.slug);
    expect((await failure(s2.ir.runner(s2.ctx(job2).ctx))).code).toBe('DOC_GONE');
  });

  it('fails with INTERNAL document_corrupt when the embedded model is invalid', async () => {
    const s = await setup();
    const jobId = await queued(s);
    await s.write(s.html.replace(/(<script type="application\/json" id="eli5-model">)/, '$1{broken'));
    expect(await failure(s.ir.runner(s.ctx(jobId).ctx))).toMatchObject({
      code: 'INTERNAL',
      detail: 'document_corrupt',
    });
  });

  it('fails with INTERNAL invalid_output when the model returns the wrong shape', async () => {
    const s = await setup();
    const jobId = await queued(s);
    s.runSectionAction.mockResolvedValueOnce(NEW_TAB);
    expect(await failure(s.ir.runner(s.ctx(jobId).ctx))).toMatchObject({ code: 'INTERNAL', detail: 'invalid_output' });
    expect(await s.read()).toBe(s.html);
  });

  it('lets LLM errors through for the queue to map, leaving the file unchanged', async () => {
    const s = await setup();
    const jobId = await queued(s);
    s.runSectionAction.mockRejectedValueOnce(new LLMError('overloaded', 'provider down'));
    expect(await rejection(s.ir.runner(s.ctx(jobId).ctx))).toBeInstanceOf(LLMError);
    expect(await s.read()).toBe(s.html);
  });

  it('fails with SAVE_FAILED when updateDocument throws; index.html and meta.json are unchanged', async () => {
    const s = await setup();
    const jobId = await queued(s);
    const metaBefore = await meta(s);
    vi.spyOn(s.lib, 'updateDocument').mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));
    expect((await failure(s.ir.runner(s.ctx(jobId).ctx))).code).toBe('SAVE_FAILED');
    expect(await s.read()).toBe(s.html);
    expect(await meta(s)).toEqual(metaBefore);
  });

  it('writes under withDocLock', async () => {
    const s = await setup();
    const jobId = await queued(s);
    const lock = vi.spyOn(s.lib, 'withDocLock');
    await s.ir.runner(s.ctx(jobId).ctx);
    expect(lock).toHaveBeenCalledWith(s.slug, expect.any(Function));
  });

  it('shrinks neighbours to fit 60% of the input budget, and fails SECTION_TOO_LARGE when the target cannot fit', async () => {
    const long = 'Example Widgets sells widgets. '.repeat(400);
    const big = replaceSection(
      fixture.model,
      sec(fixture.model, 0, 1),
      { heading: 'Big neighbour', blocks: [{ type: 'paragraph', md: long }] },
      undefined,
      '2026-09-27T12:00:00.000Z',
    ).model;
    const s = await setup({ model: big, deps: { inputBudgetTokens: () => 5000 } });
    const jobId = await queued(s);
    await s.ir.runner(s.ctx(jobId).ctx);
    const input = s.runSectionAction.mock.calls[0]?.[0] as unknown as {
      next: { heading: string; blocks: { md: string }[] };
    };
    expect(input.next.heading).toBe('Big neighbour');
    expect(JSON.stringify(input.next.blocks).length).toBeLessThan(1700);

    const s2 = await setup({ model: big, deps: { inputBudgetTokens: () => 500 } });
    const job2 = await queued(s2, { sectionId: sec(big, 0, 1) });
    expect((await failure(s2.ir.runner(s2.ctx(job2).ctx))).code).toBe('SECTION_TOO_LARGE');
    expect(s2.runSectionAction).not.toHaveBeenCalled();
  });
});

describe('section ELI5 tabs (08 §7.1)', () => {
  it('appends a tab at the right with a heading-derived label and fresh ids, and records it', async () => {
    const s = await setup();
    const from = s.model.tabs[0]?.sections[1];
    const jobId = await queued(s, { sectionId: from?.id, action: 'eli5-tab' });
    const out = await s.ir.runner(s.ctx(jobId).ctx);
    const { model } = parseDocument(await s.read());
    const tab = model.tabs.at(-1);
    expect(model.tabs.length).toBe(s.model.tabs.length + 1);
    expect(from?.heading).toBe('2. How the budget moved');
    expect(tab).toMatchObject({ kind: 'section-eli5', label: 'ELI5: How the budget moved' });
    expect(tab?.key).toMatch(/^sx[0-9a-f]{6}$/);
    expect(tab?.sections.every((x) => x.id.startsWith(`sec-${tab.key}-`))).toBe(true);
    const oldIds = s.model.tabs.flatMap((t) => t.sections.map((x) => x.id));
    expect(model.tabs.slice(0, -1).flatMap((t) => t.sections.map((x) => x.id))).toEqual(oldIds);
    const m = await meta(s);
    expect(m.tabs.at(-1)).toMatchObject({ key: tab?.key, kind: 'section-eli5', sourceSectionId: from?.id });
    expect(m.actions?.at(-1)).toMatchObject({ action: 'eli5-tab', sectionId: from?.id, resultTabKey: tab?.key });
    expect(out).toMatchObject({ tabLabel: tab?.label });
    expect(s.events.updated).toEqual([{ slug: s.slug, tabKey: tab?.key }]);
    expect(s.runSectionAction.mock.calls[0]?.[0]).toMatchObject({ action: 'eli5-tab', tabKind: 'indepth' });
  });

  it('a resumed eli5-tab job that already committed adds no second tab and no second LLM call', async () => {
    const s = await setup();
    const jobId = await queued(s, { action: 'eli5-tab' });
    const first = await s.ir.runner(s.ctx(jobId).ctx);
    const again = await s.ir.runner(s.ctx(jobId).ctx);
    expect(again).toEqual(first);
    expect(parseDocument(await s.read()).model.tabs.length).toBe(s.model.tabs.length + 1);
    expect(s.runSectionAction).toHaveBeenCalledTimes(1);
    const m = await meta(s);
    expect(m.actions?.filter((a) => a.jobId === jobId)).toHaveLength(1);
    expect(m.tabs.length).toBe(s.model.tabs.length + 1);
  });

  it('does not check baseHash: an edited source section still yields a tab', async () => {
    const s = await setup();
    const id = sec(s.model, 0, 0);
    const jobId = await queued(s, { action: 'eli5-tab' });
    await s.writeModel(replaceSection(s.model, id, NEW_SECTION, 'expand', '2026-09-28T09:00:00.000Z').model);
    await s.ir.runner(s.ctx(jobId).ctx);
    expect(parseDocument(await s.read()).model.tabs.length).toBe(s.model.tabs.length + 1);
  });

  it('fails with TOO_MANY_TABS when another job filled the tab row while queued', async () => {
    const s = await setup();
    const jobId = await queued(s, { action: 'eli5-tab' });
    let m = s.model;
    const ids = new SeededIdSource(3);
    while (m.tabs.filter((t) => t.kind === 'section-eli5').length < MAX_SECTION_ELI5_TABS) {
      m = addSectionEli5Tab(m, sec(m, 0, 0), 'Example Widgets', NEW_TAB, '2026-09-28T09:00:00.000Z', {
        idSource: ids,
      }).model;
    }
    await s.writeModel(m);
    expect((await failure(s.ir.runner(s.ctx(jobId).ctx))).code).toBe('TOO_MANY_TABS');
  });

  it('never reuses the ids of a closed tab (retiredIds)', async () => {
    const sx = fixture.model.tabs[2];
    const hex = sx?.key.slice(2) ?? '';
    // An id source that offers the closed tab's key first.
    const replay = (first: string[]): IdSource => {
      const rest = new SeededIdSource(5);
      return { hex: (n: number) => (first.length ? (first.shift() ?? '') : rest.hex(n)) };
    };
    const s = await setup({ idSource: replay([hex]) });
    await s.ir.actions.closeTab({ slug: s.slug, tabKey: sx?.key ?? '' });
    const jobId = await queued(s, { action: 'eli5-tab' });
    await s.ir.runner(s.ctx(jobId).ctx);
    const { model } = parseDocument(await s.read());
    expect(model.tabs.at(-1)?.key).not.toBe(sx?.key);
    const m = await meta(s);
    expect(m.retiredIds).toEqual(sx?.sections.map((x) => x.id));
  });
});

describe('closeTab (08 §7.2)', () => {
  it('removes a section ELI5 tab, retires its ids and points the viewer at the tab to the left', async () => {
    const s = await setup();
    const sx = s.model.tabs[2];
    await s.ir.actions.closeTab({ slug: s.slug, tabKey: sx?.key ?? '' });
    const { model } = parseDocument(await s.read());
    expect(model.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5']);
    const m = await meta(s);
    expect(m.tabs.map((t) => t.key)).toEqual(['indepth', 'eli5']);
    expect(m.retiredIds).toEqual(sx?.sections.map((x) => x.id));
    expect(s.events.updated).toEqual([{ slug: s.slug, tabKey: 'eli5' }]);
  });

  it('refuses the in-depth and ELI5 tabs, unknown tabs, other documents and busy tabs', async () => {
    const s = await setup();
    const sx = s.model.tabs[2]?.key ?? '';
    expect(await rejection(s.ir.actions.closeTab({ slug: s.slug, tabKey: 'eli5' }))).toMatchObject({
      code: 'E_FORBIDDEN',
    });
    expect(await rejection(s.ir.actions.closeTab({ slug: s.slug, tabKey: 'sx000000' }))).toMatchObject({
      code: 'E_NOT_FOUND',
    });
    s.viewer.slug = 'other-doc';
    expect(await rejection(s.ir.actions.closeTab({ slug: s.slug, tabKey: sx }))).toMatchObject({
      code: 'E_FORBIDDEN',
    });
    s.viewer.slug = s.slug;
    await queued(s, { tabKey: sx, sectionId: sec(s.model, 2, 0) });
    expect(await rejection(s.ir.actions.closeTab({ slug: s.slug, tabKey: sx }))).toMatchObject({
      code: 'E_CONFLICT',
      message: 'Wait for the update in this tab to finish',
    });
    expect(parseDocument(await s.read()).model.tabs.length).toBe(3);
  });
});
