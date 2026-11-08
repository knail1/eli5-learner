import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  DOC_RUNTIME_VERSION,
  compareRuntimeVersions,
  locateModelJson,
  locateSection,
  parseDocument,
  replaceSection,
  runtimeFor,
  type DocRuntime,
  type DocumentModel,
  type QaDocBlock,
  type SectionId,
} from '../../../../../src/main/document';
import type { DocumentMeta, DocumentPatch } from '../../../../../src/main/library';
import { PipelineFailure } from '../../../../../src/main/pipeline';
import { STUB_RUNTIME } from '../../../../fixtures/documents/runtime';
import { ANSWER, NEW_SECTION, fixture, rejection, render, req, sec, setup, type Setup } from './harness';

/** What each section job records on the version node it creates (09 §4.1), and runtimeFor (D12). */

const NEW_RUNTIME: DocRuntime = {
  js: '(function(){document.documentElement.classList.add("js","v2")})();',
  css: ':root{--paper:#fefefe}body{background:var(--paper)}',
};

/** Runs one section job and returns the patch it wrote. */
async function patchOf(s: Setup, start: () => Promise<{ jobId: string }>): Promise<DocumentPatch> {
  const spy = vi.spyOn(s.lib, 'updateDocument');
  const { jobId } = await start();
  await s.ir.runner(s.ctx(jobId).ctx);
  const patch = spy.mock.calls.at(-1)?.[1];
  if (!patch) throw new Error('no write');
  return patch;
}

describe('version change payloads (09 §4.1)', () => {
  it.each(['expand', 'reexplain', 'analogy', 'deeper'] as const)(
    '%s: the section is both the target and the undo target; topic = heading',
    async (action) => {
      const s = await setup();
      const sectionId = sec(s.model, 0, 1);
      const heading = s.model.tabs[0]?.sections[1]?.heading ?? '';
      const patch = await patchOf(s, () => s.ir.actions.regenerateSection(req(s, { action, sectionId })));
      const at = { tabKey: 'indepth', sectionId };
      expect(patch.change).toEqual({
        kind: action,
        topic: heading,
        heading,
        target: at,
        undoTarget: at,
        jobId: 'job-s1',
      });
    },
  );

  it('revise records an edit of its section', async () => {
    const s = await setup();
    const patch = await patchOf(s, () =>
      s.ir.actions.regenerateSection(req(s, { action: 'revise', note: 'Shorter please' })),
    );
    expect(patch.change).toMatchObject({
      kind: 'revise',
      target: { tabKey: 'indepth', sectionId: sec(s.model, 0, 0) },
    });
  });

  it('eli5-tab: lands on the new tab; undo lands on the source section; topic = tab label', async () => {
    const s = await setup();
    const sectionId = sec(s.model, 0, 0);
    const patch = await patchOf(s, () =>
      s.ir.actions.createSectionEli5({ slug: s.slug, tabKey: 'indepth', sectionId, selectionText: 'judges every' }),
    );
    const tab = parseDocument(await s.read()).model.tabs.at(-1);
    expect(patch.change).toEqual({
      kind: 'eli5-tab',
      topic: tab?.label,
      heading: s.model.tabs[0]?.sections[0]?.heading,
      target: { tabKey: tab?.key },
      undoTarget: { tabKey: 'indepth', sectionId },
      jobId: 'job-s1',
    });
  });

  it('eli5-selection: the same shape, kind eli5-selection', async () => {
    const s = await setup();
    const ids = [sec(s.model, 0, 0), sec(s.model, 0, 1)];
    const patch = await patchOf(s, () =>
      s.ir.actions.createSectionEli5({
        slug: s.slug,
        tabKey: 'indepth',
        sectionId: ids[0] as SectionId,
        selectionText: 'judges every channel by ROAS',
        scope: 'selection',
        sectionIds: ids,
      }),
    );
    const tab = parseDocument(await s.read()).model.tabs.at(-1);
    expect(patch.change).toMatchObject({
      kind: 'eli5-selection',
      topic: tab?.label,
      target: { tabKey: tab?.key },
      undoTarget: { tabKey: 'indepth', sectionId: ids[0] },
    });
  });

  it('closing a tab lands on the section it came from; undo lands on the restored tab', async () => {
    const s = await setup();
    const sectionId = sec(s.model, 0, 0);
    await patchOf(s, () =>
      s.ir.actions.createSectionEli5({ slug: s.slug, tabKey: 'indepth', sectionId, selectionText: 'judges every' }),
    );
    const tab = parseDocument(await s.read()).model.tabs.at(-1);
    const spy = vi.spyOn(s.lib, 'updateDocument');
    await s.ir.actions.closeTab({ slug: s.slug, tabKey: tab?.key ?? '' });
    expect(spy.mock.calls.at(-1)?.[1].change).toEqual({
      kind: 'close-tab',
      topic: tab?.label,
      target: { tabKey: 'indepth', sectionId },
      undoTarget: { tabKey: tab?.key },
    });
    const tree = await s.ir.history.versions(s.slug);
    expect(tree.nodes.at(-1)).toMatchObject({ kind: 'close-tab', target: { tabKey: 'indepth', sectionId } });
  });

  it('the node in the tree carries the kind, label and target', async () => {
    const s = await setup();
    await patchOf(s, () => s.ir.actions.regenerateSection(req(s, { action: 'deeper' })));
    const tree = await s.ir.history.versions(s.slug);
    expect(tree.nodes).toHaveLength(2);
    expect(tree.nodes.at(-1)).toMatchObject({
      kind: 'deeper',
      parentId: tree.nodes[0]?.id,
      target: { tabKey: 'indepth', sectionId: sec(s.model, 0, 0) },
      available: true,
    });
    expect(tree.currentId).toBe(tree.nodes.at(-1)?.id);
  });
});

describe('runtimeFor (D12)', () => {
  const g = fixture.model.generator;
  const parsed = (runtimeVersion: string) => ({
    model: { ...fixture.model, generator: { ...g, runtimeVersion } },
    runtime: STUB_RUNTIME,
  });

  it('compares dotted versions numerically', () => {
    expect(compareRuntimeVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareRuntimeVersions('0.9.9', '1.0.0')).toBe(-1);
    expect(compareRuntimeVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareRuntimeVersions('1.0', '1.0.0')).toBe(0);
  });

  it('keeps the document runtime when it is current or newer', () => {
    const bundled = vi.fn(() => NEW_RUNTIME);
    for (const v of [DOC_RUNTIME_VERSION, '99.0.0']) {
      const rt = runtimeFor(parsed(v), bundled);
      expect(rt.runtime).toBe(STUB_RUNTIME);
      expect(rt.upgraded).toBe(false);
      const m = parsed(v).model;
      expect(rt.stamp(m)).toBe(m);
    }
    expect(bundled).not.toHaveBeenCalled();
  });

  it('takes the bundled runtime for an older document and stamps its version', () => {
    const rt = runtimeFor(parsed('0.9.0'), () => NEW_RUNTIME);
    expect(rt.upgraded).toBe(true);
    expect(rt.runtime).toBe(NEW_RUNTIME);
    expect(rt.stamp(parsed('0.9.0').model).generator.runtimeVersion).toBe(DOC_RUNTIME_VERSION);
  });

  it('keeps the old runtime when the bundled one is missing', () => {
    const rt = runtimeFor(parsed('0.9.0'), () => {
      throw new Error('missing');
    });
    expect(rt).toMatchObject({ runtime: STUB_RUNTIME, upgraded: false });
  });

  it('a section action on an older document renders with the bundled runtime', async () => {
    const s = await setup({
      model: { ...fixture.model, generator: { ...g, runtimeVersion: '0.9.0' } },
      deps: { bundledRuntime: () => NEW_RUNTIME },
    });
    await patchOf(s, () => s.ir.actions.regenerateSection(req(s)));
    const after = parseDocument(await s.read());
    expect(after.runtime).toEqual(NEW_RUNTIME);
    expect(after.model.generator.runtimeVersion).toBe(DOC_RUNTIME_VERSION);
  });

  it('a section action on a current document keeps its runtime', async () => {
    const s = await setup({ deps: { bundledRuntime: () => NEW_RUNTIME } });
    await patchOf(s, () => s.ir.actions.regenerateSection(req(s)));
    expect(parseDocument(await s.read()).runtime).toEqual(STUB_RUNTIME);
  });
});

// ---- Ask (08 Ask, design §4) ----

const meta = async (s: Setup): Promise<DocumentMeta> =>
  JSON.parse(await readFile(s.lib.docPath(s.slug, 'meta.json'), 'utf8')) as DocumentMeta;

const askReq = (s: Setup, over: Record<string, unknown> = {}) => ({
  slug: s.slug,
  tabKey: 'indepth',
  sectionId: sec(s.model, 0, 0),
  selectionText: 'judges every channel',
  question: 'Why ROAS and not reach?',
  ...over,
});

const boxesOf = (m: DocumentModel, id: SectionId): { at: number; box: QaDocBlock }[] =>
  (m.tabs.flatMap((t) => t.sections).find((x) => x.id === id)?.blocks ?? []).flatMap((b, at) =>
    b.type === 'qa' ? [{ at, box: b }] : [],
  );

async function failure(p: Promise<unknown>): Promise<{ code: string; detail?: string }> {
  const e = await rejection(p);
  expect(e).toBeInstanceOf(PipelineFailure);
  return e as unknown as PipelineFailure;
}

/** Everything outside the target <section> and the #eli5-model JSON. */
function outside(html: string, id: SectionId): string {
  const a = locateSection(html, id);
  const b = locateModelJson(html);
  if (!a || !b) throw new Error('not found');
  const [x, y] = a.start < b.start ? [a, b] : [b, a];
  return html.slice(0, x.start) + '<A/>' + html.slice(x.end, y.start) + '<B/>' + html.slice(y.end);
}

describe('Ask: the runner (08 Ask)', () => {
  it('asks the model with the section, the selection and the question; no rewrite call', async () => {
    const s = await setup();
    const { jobId } = await s.ir.actions.askSection(askReq(s));
    await s.ir.runner(s.ctx(jobId).ctx);
    expect(s.runSectionAction).not.toHaveBeenCalled();
    expect(s.answerSectionQuestion).toHaveBeenCalledTimes(1);
    expect(s.answerSectionQuestion.mock.calls[0]?.[0]).toMatchObject({
      tabKind: 'indepth',
      selection: 'judges every channel',
      question: 'Why ROAS and not reach?',
      section: { heading: s.model.tabs[0]?.sections[0]?.heading },
    });
  });

  it('inserts the answer box right after the selected block and leaves the rest of the file alone', async () => {
    const s = await setup();
    const id = sec(s.model, 0, 0);
    const { jobId } = await s.ir.actions.askSection(askReq(s, { selectionText: 'cheap reach, weaker' }));
    await s.ir.runner(s.ctx(jobId).ctx);
    const html = await s.read();
    const { model } = parseDocument(html);
    const [hit, ...more] = boxesOf(model, id);
    expect(more).toEqual([]);
    expect(hit?.at).toBe(2); // the list is block 1
    expect(hit?.box).toMatchObject({
      question: 'Why ROAS and not reach?',
      topic: ANSWER.topic,
      quote: 'cheap reach, weaker',
      paragraphs: ANSWER.paragraphs,
      askedAt: '2026-09-28T10:00:00.000Z',
    });
    expect(model.tabs[0]?.sections[0]?.lastAction).toBe('ask');
    expect(html).toContain(`<aside class="qa" id="${hit?.box.id}"`);
    const reference = render({ ...s.model, updatedAt: '2026-09-28T10:00:00.000Z' });
    expect(outside(html, id)).toBe(outside(reference, id));
  });

  it('records an asks entry, not an actions entry, and emits the box as the anchor', async () => {
    const s = await setup();
    const id = sec(s.model, 0, 0);
    const { jobId } = await s.ir.actions.askSection(askReq(s));
    await s.ir.runner(s.ctx(jobId).ctx);
    const qaId = boxesOf(parseDocument(await s.read()).model, id)[0]?.box.id;
    expect(qaId).toMatch(/^q-[0-9a-f]{8}$/);
    const m = await meta(s);
    expect(m.actions ?? []).toEqual([]);
    expect(m.asks).toEqual([
      {
        at: '2026-09-28T10:00:00.000Z',
        sectionId: id,
        tabKey: 'indepth',
        question: 'Why ROAS and not reach?',
        qaId,
        jobId,
      },
    ]);
    expect(s.events.updated.at(-1)).toEqual({ slug: s.slug, sectionId: id, tabKey: 'indepth', anchorId: qaId });
  });

  it('labels the version "asked about \'<topic>\'" and records the change', async () => {
    const s = await setup();
    const id = sec(s.model, 0, 0);
    const heading = s.model.tabs[0]?.sections[0]?.heading;
    s.answerSectionQuestion.mockResolvedValueOnce({ ...ANSWER, topic: '  ROAS   versus reach ' });
    const spy = vi.spyOn(s.lib, 'updateDocument');
    const { jobId } = await s.ir.actions.askSection(askReq(s));
    await s.ir.runner(s.ctx(jobId).ctx);
    const qaId = boxesOf(parseDocument(await s.read()).model, id)[0]?.box.id;
    const patch = spy.mock.calls.at(-1)?.[1];
    expect(patch?.label).toBe("asked about 'ROAS versus reach'");
    expect(patch?.change).toEqual({
      kind: 'ask',
      topic: 'ROAS versus reach',
      heading,
      question: 'Why ROAS and not reach?',
      target: { tabKey: 'indepth', sectionId: id, anchorId: qaId },
      undoTarget: { tabKey: 'indepth', sectionId: id },
      jobId,
    });
    const tree = await s.ir.history.versions(s.slug);
    expect(tree.nodes.at(-1)).toMatchObject({
      kind: 'ask',
      label: "asked about 'ROAS versus reach'",
      question: 'Why ROAS and not reach?',
      target: { anchorId: qaId },
    });
    expect((await s.ir.history.state(s.slug)).undoLabel).toBe("asked about 'ROAS versus reach'");
  });

  it('stacks a second answer after the first, in the order asked', async () => {
    const s = await setup();
    const id = sec(s.model, 0, 0);
    for (const question of ['First question here?', 'Second question here?']) {
      const { jobId } = await s.ir.actions.askSection(askReq(s, { question }));
      await s.ir.runner(s.ctx(jobId).ctx);
      s.jobs.emit(jobId, 'done');
    }
    const boxes = boxesOf(parseDocument(await s.read()).model, id);
    expect(boxes.map((b) => [b.at, b.box.question])).toEqual([
      [1, 'First question here?'],
      [2, 'Second question here?'],
    ]);
    expect(new Set(boxes.map((b) => b.box.id)).size).toBe(2);
    expect((await meta(s)).asks?.map((a) => a.qaId)).toEqual(boxes.map((b) => b.box.id));
  });

  it('is idempotent: a resumed job that already committed finds its asks entry and does nothing', async () => {
    const s = await setup();
    const id = sec(s.model, 0, 0);
    const { jobId } = await s.ir.actions.askSection(askReq(s));
    const first = await s.ir.runner(s.ctx(jobId).ctx);
    const html = await s.read();
    const qaId = boxesOf(parseDocument(html).model, id)[0]?.box.id;
    // Crash after updateDocument, before the queue persisted done: the job runs once more.
    const again = await s.ir.runner(s.ctx(jobId).ctx);
    expect(again).toEqual(first);
    expect(await s.read()).toBe(html);
    expect(s.answerSectionQuestion).toHaveBeenCalledTimes(1);
    expect((await meta(s)).asks).toHaveLength(1);
    expect(s.events.updated.at(-1)).toEqual({ slug: s.slug, sectionId: id, tabKey: 'indepth', anchorId: qaId });
  });

  it('fails with SECTION_CHANGED when the section changed after the request; nothing is written', async () => {
    const s = await setup();
    const id = sec(s.model, 0, 0);
    const { jobId } = await s.ir.actions.askSection(askReq(s));
    await s.writeModel(replaceSection(s.model, id, NEW_SECTION, undefined, '2026-09-28T09:00:00.000Z').model);
    const before = await s.read();
    const metaBefore = await meta(s);
    expect((await failure(s.ir.runner(s.ctx(jobId).ctx))).code).toBe('SECTION_CHANGED');
    expect(await s.read()).toBe(before);
    expect(await meta(s)).toEqual(metaBefore);
    expect(s.events.updated).toEqual([]);
  });

  it('fails INTERNAL invalid_output before saving when no answer paragraph is usable', async () => {
    const s = await setup();
    s.answerSectionQuestion.mockResolvedValueOnce({
      topic: 'Reach',
      paragraphs: ['  ', 'Would you like to know more?'],
    });
    const { jobId } = await s.ir.actions.askSection(askReq(s));
    const before = await s.read();
    const { ctx, steps } = s.ctx(jobId);
    expect(await failure(s.ir.runner(ctx))).toMatchObject({ code: 'INTERNAL', detail: 'invalid_output' });
    expect(steps).toEqual([]);
    expect(await s.read()).toBe(before);
  });

  it('fails INTERNAL without an LLM call when the payload has no question', async () => {
    const s = await setup();
    const { jobId } = await s.ir.actions.askSection(askReq(s));
    const job = s.jobs.get(jobId);
    if (job) delete job.section.question;
    expect((await failure(s.ir.runner(s.ctx(jobId).ctx))).code).toBe('INTERNAL');
    expect(s.answerSectionQuestion).not.toHaveBeenCalled();
  });
});
