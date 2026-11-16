import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  DEEP_ASK_RATE,
  deepAskSources,
  failureNotice,
  parseDocument,
  renderDocument,
  type DocumentModel,
  type QaDocBlock,
  type SectionId,
  type SectionJobPayload,
} from '../../../../../src/main/document';
import type { DocumentMeta, SourceRecord, SourceSidecar, SourceSidecarInput } from '../../../../../src/main/library';
import { DeepContextTooLargeError, LLMError } from '../../../../../src/main/llm';
import { PipelineFailure } from '../../../../../src/main/pipeline';
import type { SectionBusyEvent } from '../../../../../src/preload/contract';
import { fixtureDocument } from '../../../../fixtures/documents/models';
import { ANSWER, DEEP_RESULT, FakeJobs, rejection, sec, setup, type Setup } from './harness';

/** Deep Ask (08 §6.9): material, decision 8, saving, links, notices, busy depth and the rate limit. */

const CANARY_A = 'Report text A: search took 61 percent of the spend.';
const CANARY_B = 'Merged-away text B: a different report entirely.';

const src = (ref: string, text: string | null, over: Partial<SourceSidecarInput> = {}): SourceSidecarInput => ({
  ref,
  label: ref,
  kind: 'file',
  mime: text === null ? 'image/png' : 'application/pdf',
  format: text === null ? 'image' : 'pdf',
  text,
  chars: text?.length ?? 0,
  extractTruncated: false,
  ...over,
});
const used = (...refs: string[]): SourceRecord[] => refs.map((ref) => ({ ref, kind: 'file' as const }));

const askReq = (s: Setup, over: Record<string, unknown> = {}) => ({
  slug: s.slug,
  tabKey: 'indepth',
  sectionId: sec(s.model, 0, 0),
  selectionText: 'judges every channel',
  question: 'What does the report say about reach?',
  depth: 'deep' as const,
  ...over,
});

const meta = async (s: Setup): Promise<DocumentMeta> =>
  JSON.parse(await readFile(s.lib.docPath(s.slug, 'meta.json'), 'utf8')) as DocumentMeta;

const boxesOf = (m: DocumentModel, id: SectionId): QaDocBlock[] =>
  (m.tabs.flatMap((t) => t.sections).find((x) => x.id === id)?.blocks ?? []).filter(
    (b): b is QaDocBlock => b.type === 'qa',
  );

/** Requests and runs one ask; returns its job id. */
async function run(s: Setup, over: Record<string, unknown> = {}): Promise<string> {
  const { jobId } = await s.ir.actions.askSection(askReq(s, over));
  await s.ir.runner(s.ctx(jobId).ctx);
  s.jobs.emit(jobId, 'done');
  return jobId;
}

const deepInput = (s: Setup) => {
  const i = s.answerDeepQuestion.mock.calls.at(-1)?.[0];
  if (!i) throw new Error('answerDeepQuestion was not called');
  return i;
};

describe('Deep Ask: the material sent (08 §6.9)', () => {
  it('sends every tab in document order without answer boxes or references, plus the local context', async () => {
    const asked = fixtureDocument('asked').model;
    const s = await setup({ model: asked, sources: [src('widgets.pdf', CANARY_A)] });
    await run(s);
    expect(s.answerSectionQuestion).not.toHaveBeenCalled();
    const i = deepInput(s);
    expect(i.tabs.map((t) => [t.key, t.kind, t.label])).toEqual(asked.tabs.map((t) => [t.key, t.kind, t.label]));
    for (const [n, t] of asked.tabs.entries()) {
      const content = t.sections.filter((x) => x.kind === 'content');
      expect(i.tabs[n]?.sections.map((x) => x.heading)).toEqual(content.map((x) => x.heading));
    }
    expect(i.tabs.flatMap((t) => t.sections.flatMap((x) => x.blocks)).some((b) => (b.type as string) === 'qa')).toBe(
      false,
    );
    expect(i).toMatchObject({
      tabKind: 'indepth',
      selection: 'judges every channel',
      question: 'What does the report say about reach?',
      section: { heading: asked.tabs[0]?.sections[0]?.heading },
    });
    expect(i.outline.length).toBeGreaterThan(0);
  });

  it('sends the kept source text of the sources the live meta uses', async () => {
    const s = await setup({ sources: [src('widgets.pdf', CANARY_A)], meta: { sourcesUsed: used('widgets.pdf') } });
    await run(s);
    expect(deepInput(s).sources).toEqual([
      { id: 'src-01', ref: 'widgets.pdf', label: 'widgets.pdf', format: 'pdf', text: CANARY_A, truncated: false },
    ]);
  });

  it('gives sources: null when the document has no sidecar', async () => {
    const s = await setup();
    await run(s);
    expect(deepInput(s).sources).toBeNull();
  });

  it('gives sources: null when the library has no readSources (decision 9)', async () => {
    const s = await setup({ sources: [src('widgets.pdf', CANARY_A)] });
    // An InteractiveLibrary without the optional member.
    Object.defineProperty(s.lib, 'readSources', { value: undefined });
    await run(s);
    expect(deepInput(s).sources).toBeNull();
  });

  it('lists an image entry and a sourcesUsed record with no kept text once each, as text: null', async () => {
    const s = await setup({
      sources: [src('widgets.pdf', CANARY_A), src('chart.png', null)],
      meta: { sourcesUsed: [...used('widgets.pdf', 'chart.png'), { ref: 'https://example.com/a', kind: 'url' }] },
    });
    await run(s);
    const sources = deepInput(s).sources ?? [];
    expect(sources.map((x) => [x.ref, x.text === null, x.format])).toEqual([
      ['widgets.pdf', false, 'pdf'],
      ['chart.png', true, 'image'],
      ['https://example.com/a', true, 'unknown'],
    ]);
    expect(sources[2]).toEqual({
      id: 'missing-1',
      ref: 'https://example.com/a',
      label: 'https://example.com/a',
      format: 'unknown',
      text: null,
      truncated: false,
    });
  });

  it('after an undone merge, the merged-away kept text is not sent (decision 8)', async () => {
    const s = await setup({
      sources: [src('widgets.pdf', CANARY_A), src('other.pdf', CANARY_B, { origin: 'merge:x' })],
      meta: { sourcesUsed: used('widgets.pdf') },
    });
    const first = (await s.ir.history.versions(s.slug)).currentId;
    // The merge: the live meta gains the merged-away record (a new version).
    await s.lib.withDocLock(s.slug, async () => {
      const cur = parseDocument(await s.read());
      const html = renderDocument({ ...cur.model, updatedAt: '2026-09-28T09:30:00.000Z' }, cur.assets, {
        runtime: cur.runtime,
        theme: cur.theme,
      });
      await s.lib.updateDocument(s.slug, {
        html,
        meta: (m) => ({ ...m, sourcesUsed: [...m.sourcesUsed, ...used('other.pdf')] }),
        label: "merged 'Other'",
        change: { kind: 'merge', topic: 'Other' },
      });
    });
    await run(s);
    expect((deepInput(s).sources ?? []).map((x) => x.ref)).toEqual(['widgets.pdf', 'other.pdf']);
    // Undo the merge: the pre-merge version's meta does not use other.pdf.
    await s.ir.history.checkout({ slug: s.slug, versionId: first });
    expect((await meta(s)).sourcesUsed.map((x) => x.ref)).toEqual(['widgets.pdf']);
    await run(s, { question: 'And after the undo, what then?' });
    const after = deepInput(s).sources ?? [];
    expect(after.map((x) => x.ref)).toEqual(['widgets.pdf']);
    expect(JSON.stringify(after)).not.toContain(CANARY_B);
  });

  it('matches by sha256 when both sides carry one, so a checkout to a pre-rebuild version sends only its text', async () => {
    const s = await setup({
      sources: [
        src('widgets.pdf', CANARY_A, { sourceSha256: 'a'.repeat(64) }),
        src('widgets.pdf', 'Rebuilt text.', { sourceSha256: 'b'.repeat(64), origin: 'rebuild:job-r' }),
      ],
      meta: { sourcesUsed: [{ ref: 'widgets.pdf', kind: 'file', sha256: 'a'.repeat(64) }] },
    });
    await run(s);
    expect((deepInput(s).sources ?? []).map((x) => x.text)).toEqual([CANARY_A]);
  });
});

describe('Deep Ask: saving (08 §6.9)', () => {
  it('marks the box deep with its source mode, records asks[].depth and a deep version node', async () => {
    const s = await setup({ sources: [src('widgets.pdf', CANARY_A)] });
    s.answerDeepQuestion.mockResolvedValueOnce({
      ...DEEP_RESULT,
      plan: { ...DEEP_RESULT.plan, sourceMode: 'excerpts' },
    });
    const spy = vi.spyOn(s.lib, 'updateDocument');
    const id = sec(s.model, 0, 0);
    const jobId = await run(s);
    const html = await s.read();
    const [box] = boxesOf(parseDocument(html).model, id);
    expect(box).toMatchObject({ depth: 'deep', sources: 'excerpts', topic: DEEP_RESULT.draft.topic });
    expect(html).toContain(`<aside class="qa qa-deep" id="${box?.id}" aria-label="Deep answer to a reader question">`);
    expect(html).toContain(
      '<p class="qa-badge" data-eli5-noact>Deep answer · checked against excerpts of the original sources</p>',
    );
    // Source text never lands in the document.
    expect(html).not.toContain(CANARY_A);
    const m = await meta(s);
    expect(m.asks).toEqual([
      expect.objectContaining({
        jobId,
        qaId: box?.id,
        depth: 'deep',
        question: 'What does the report say about reach?',
      }),
    ]);
    expect(JSON.stringify(m)).not.toContain(CANARY_A);
    const patch = spy.mock.calls.at(-1)?.[1];
    expect(patch?.label).toBe("asked (deep) about 'What the report says'");
    expect(patch?.change).toMatchObject({ kind: 'ask', depth: 'deep', jobId });
    const tree = await s.ir.history.versions(s.slug);
    expect(tree.nodes.at(-1)).toMatchObject({
      kind: 'ask',
      depth: 'deep',
      label: "asked (deep) about 'What the report says'",
    });
    expect((await s.ir.history.state(s.slug)).undoLabel).toBe("asked (deep) about 'What the report says'");
  });

  it.each([
    ['all', 'checked against the original sources'],
    ['none', 'the original source text is not available for this document, so this answer uses the tabs only'],
  ] as const)('mode %s gets its badge text', async (mode, text) => {
    const s = await setup();
    s.answerDeepQuestion.mockResolvedValueOnce({ ...DEEP_RESULT, plan: { ...DEEP_RESULT.plan, sourceMode: mode } });
    await run(s);
    const html = await s.read();
    expect(html).toContain(`<p class="qa-badge" data-eli5-noact>Deep answer · ${text}</p>`);
    // The badge sits before .qa-a, never inside it.
    const box = html.slice(html.indexOf('<aside class="qa qa-deep"'));
    expect(box.indexOf('class="qa-badge"')).toBeLessThan(box.indexOf('<div class="qa-a">'));
  });

  it('stores links in a deep answer as their text; a quick answer keeps them', async () => {
    const s = await setup();
    const linked = 'See [the report](https://example.com/r) and `[x](y)` for more.';
    s.answerDeepQuestion.mockResolvedValueOnce({ ...DEEP_RESULT, draft: { topic: 'Links', paragraphs: [linked] } });
    s.answerSectionQuestion.mockResolvedValueOnce({ topic: 'Links quick', paragraphs: [linked] });
    const id = sec(s.model, 0, 0);
    await run(s);
    await run(s, { depth: undefined, question: 'A quick one, please?' });
    const [deep, quick] = boxesOf(parseDocument(await s.read()).model, id);
    expect(deep?.paragraphs).toEqual(['See the report and `[x](y)` for more.']);
    expect(quick?.paragraphs).toEqual([linked]);
    expect(quick).not.toHaveProperty('depth');
    expect(quick).not.toHaveProperty('sources');
  });

  it('is idempotent: a resumed deep job that already committed does nothing', async () => {
    const s = await setup();
    const { jobId } = await s.ir.actions.askSection(askReq(s));
    const first = await s.ir.runner(s.ctx(jobId).ctx);
    const html = await s.read();
    const again = await s.ir.runner(s.ctx(jobId).ctx);
    expect(again).toEqual(first);
    expect(await s.read()).toBe(html);
    expect(s.answerDeepQuestion).toHaveBeenCalledTimes(1);
    expect((await meta(s)).asks).toHaveLength(1);
  });

  it('maps DeepContextTooLargeError to SECTION_TOO_LARGE (deep_context); nothing is written', async () => {
    const s = await setup();
    s.answerDeepQuestion.mockRejectedValueOnce(new DeepContextTooLargeError());
    const { jobId } = await s.ir.actions.askSection(askReq(s));
    const before = await s.read();
    const e = await rejection(s.ir.runner(s.ctx(jobId).ctx));
    expect(e).toBeInstanceOf(PipelineFailure);
    expect(e).toMatchObject({ code: 'SECTION_TOO_LARGE', detail: 'deep_context' });
    expect(await s.read()).toBe(before);
  });

  it('passes other LLM errors through unchanged', async () => {
    const s = await setup();
    const err = new LLMError('context_overflow', 'too big');
    s.answerDeepQuestion.mockRejectedValueOnce(err);
    const { jobId } = await s.ir.actions.askSection(askReq(s));
    expect(await rejection(s.ir.runner(s.ctx(jobId).ctx))).toBe(err);
  });

  it('shows the deep SECTION_TOO_LARGE notice when the job fails', async () => {
    const s = await setup();
    const { jobId } = await s.ir.actions.askSection(askReq(s));
    s.jobs.emit(jobId, 'failed', 'SECTION_TOO_LARGE');
    const last = s.events.busy.at(-1) as SectionBusyEvent;
    expect(last.notices).toEqual([
      { sectionId: sec(s.model, 0, 0), message: 'This question needs more context than the model allows; try Ask' },
    ]);
  });

  it('logs the plan with counts only', async () => {
    const info = vi.fn();
    const s = await setup({
      sources: [src('widgets.pdf', CANARY_A)],
      deps: { log: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
    });
    await run(s);
    expect(info).toHaveBeenCalledWith('document.section-action', expect.objectContaining({ kind: 'ask-deep' }));
    expect(info).toHaveBeenCalledWith('document.deep-ask', {
      slug: s.slug,
      sectionId: sec(s.model, 0, 0),
      kind: 'all',
      count: 0,
      inputTokens: 900,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain(CANARY_A);
  });
});

describe('Quick Ask is unchanged (08 §6.8)', () => {
  it('never reads the sidecar or calls answerDeepQuestion; the box has no depth', async () => {
    const s = await setup({ sources: [src('widgets.pdf', CANARY_A)] });
    const readSources = vi.spyOn(s.lib, 'readSources');
    const spy = vi.spyOn(s.lib, 'updateDocument');
    const id = sec(s.model, 0, 0);
    const jobId = await run(s, { depth: undefined });
    expect(readSources).not.toHaveBeenCalled();
    expect(s.answerDeepQuestion).not.toHaveBeenCalled();
    expect(s.answerSectionQuestion).toHaveBeenCalledTimes(1);
    const [box] = boxesOf(parseDocument(await s.read()).model, id);
    expect(box).toMatchObject({ topic: ANSWER.topic });
    expect(box).not.toHaveProperty('depth');
    expect((await meta(s)).asks?.[0]).not.toHaveProperty('depth');
    expect(spy.mock.calls.at(-1)?.[1].label).toBe(`asked about '${ANSWER.topic}'`);
    expect(spy.mock.calls.at(-1)?.[1].change).not.toHaveProperty('depth');
    expect(s.jobs.get(jobId)?.section).not.toHaveProperty('depth');
  });

  it("an explicit depth 'quick' is a quick ask", async () => {
    const s = await setup();
    const { jobId } = await s.ir.actions.askSection(askReq(s, { depth: 'quick' }));
    expect(s.jobs.get(jobId)?.section).not.toHaveProperty('depth');
  });
});

describe('Deep Ask: the service (08 §6.1, §8.3)', () => {
  it('puts depth on the payload, the first busy event and the pending row', async () => {
    const s = await setup();
    const id = sec(s.model, 0, 0);
    const { jobId } = await s.ir.actions.askSection(askReq(s));
    expect(s.jobs.get(jobId)?.section).toMatchObject({ action: 'ask', depth: 'deep' });
    expect(s.events.busy[0]).toEqual({ busy: [{ sectionId: id, action: 'ask', depth: 'deep' }] });
    const tree = await s.ir.history.versions(s.slug);
    expect(tree.pending).toEqual([expect.objectContaining({ sectionId: id, action: 'ask', depth: 'deep' })]);
  });

  it('a quick ask carries no depth on busy items or pending rows', async () => {
    const s = await setup();
    await s.ir.actions.askSection(askReq(s, { depth: undefined }));
    expect((s.events.busy[0] as SectionBusyEvent).busy[0]).not.toHaveProperty('depth');
    expect((await s.ir.history.versions(s.slug)).pending[0]).not.toHaveProperty('depth');
  });

  it('a resumed deep job (attachJobs) carries depth', async () => {
    const s = await setup();
    const id = sec(s.model, 0, 0);
    const q = new FakeJobs();
    const payload: SectionJobPayload = {
      slug: s.slug,
      tabKey: 'indepth',
      sectionId: id,
      action: 'ask',
      selectionText: 'judges every channel',
      question: 'What does the report say?',
      depth: 'deep',
      heading: 'H',
      baseHash: 'x',
    };
    q.seed('job-r1', 'queued', payload);
    s.events.busy.length = 0;
    s.ir.attachJobs(q);
    expect(s.events.busy.at(-1)).toEqual({ busy: [{ sectionId: id, action: 'ask', depth: 'deep' }] });
    expect((await s.ir.history.versions(s.slug)).pending).toEqual([
      { sectionId: id, action: 'ask', heading: 'H', depth: 'deep' },
    ]);
  });

  it('keeps the busy key: a deep ask on a busy section is refused', async () => {
    const s = await setup();
    await s.ir.actions.askSection(askReq(s, { depth: undefined }));
    expect(await rejection(s.ir.actions.askSection(askReq(s)))).toMatchObject({ code: 'E_CONFLICT' });
  });

  it('refuses the 4th deep ask within 60 s on one document, while a quick ask still passes', async () => {
    expect(DEEP_ASK_RATE).toEqual({ max: 3, windowMs: 60_000 });
    const s = await setup();
    for (let n = 0; n < 3; n++) {
      const { jobId } = await s.ir.actions.askSection(askReq(s, { question: `Deep question ${String(n)}?` }));
      s.jobs.emit(jobId, 'done');
    }
    expect(await rejection(s.ir.actions.askSection(askReq(s)))).toMatchObject({
      code: 'E_RATE_LIMITED',
      message: 'Too many requests; wait a moment',
    });
    const { jobId } = await s.ir.actions.askSection(askReq(s, { depth: undefined }));
    expect(jobId).toBeTruthy();
    s.jobs.emit(jobId, 'done');
    // The window slides: after 60 s deep asks pass again.
    s.clock.advance(60_000);
    await expect(s.ir.actions.askSection(askReq(s))).resolves.toMatchObject({ jobId: expect.any(String) });
  });

  it('refunds both limits when a deep request is refused later', async () => {
    const s = await setup({ deps: { hasApiKey: async () => false } });
    for (let n = 0; n < 5; n++) {
      expect(await rejection(s.ir.actions.askSection(askReq(s)))).toMatchObject({ code: 'E_NO_API_KEY' });
    }
  });

  it('a deep ask refused by its own limit does not use up the shared one', async () => {
    const s = await setup({
      deps: { rateLimit: { max: 4, windowMs: 60_000 }, deepAskRate: { max: 1, windowMs: 60_000 } },
    });
    const { jobId } = await s.ir.actions.askSection(askReq(s));
    s.jobs.emit(jobId, 'done');
    for (let n = 0; n < 3; n++) {
      expect(await rejection(s.ir.actions.askSection(askReq(s)))).toMatchObject({ code: 'E_RATE_LIMITED' });
    }
    // Shared: 1 used, so 3 quick asks still pass.
    for (let n = 0; n < 3; n++) {
      const r = await s.ir.actions.askSection(askReq(s, { depth: undefined, question: `Quick ${String(n)}?` }));
      s.jobs.emit(r.jobId, 'done');
    }
  });
});

describe('failureNotice and deepAskSources (pure)', () => {
  it('only a deep ask gets the deep SECTION_TOO_LARGE text', () => {
    const rewrite = 'This section is too long to rewrite in one step';
    expect(failureNotice('SECTION_TOO_LARGE')).toBe(rewrite);
    expect(failureNotice('SECTION_TOO_LARGE', { action: 'ask' })).toBe(rewrite);
    expect(failureNotice('SECTION_TOO_LARGE', { action: 'expand', depth: 'deep' })).toBe(rewrite);
    expect(failureNotice('SECTION_TOO_LARGE', { action: 'ask', depth: 'deep' })).toBe(
      'This question needs more context than the model allows; try Ask',
    );
    expect(failureNotice('INTERNAL', { action: 'ask', depth: 'deep' })).toBe("Couldn't update this section. Try again");
  });

  it('null sidecar gives null; unmatched entries are dropped', () => {
    expect(deepAskSources(null, used('a.pdf'))).toBeNull();
    const sc: SourceSidecar = {
      manifest: {
        v: 1,
        updatedAt: '2026-09-28T10:00:00.000Z',
        totalBytes: 4,
        sources: [
          {
            id: 'src-01',
            file: 'src-01.md',
            ref: 'a.pdf',
            label: 'A',
            kind: 'file',
            mime: 'application/pdf',
            format: 'pdf',
            stored: 'text',
            chars: 2,
            storedChars: 2,
            truncated: false,
            addedAt: '2026-09-28T10:00:00.000Z',
          },
          {
            id: 'src-02',
            file: 'src-02.md',
            ref: 'b.pdf',
            label: 'B',
            kind: 'file',
            mime: 'application/pdf',
            format: 'pdf',
            stored: 'text',
            chars: 2,
            storedChars: 2,
            truncated: true,
            addedAt: '2026-09-28T10:00:00.000Z',
          },
        ],
      },
      texts: { 'src-01': 'aa', 'src-02': 'bb' },
    };
    expect(deepAskSources(sc, used('b.pdf'))).toEqual([
      { id: 'src-02', ref: 'b.pdf', label: 'B', format: 'pdf', text: 'bb', truncated: true },
    ]);
    expect(deepAskSources(sc, [])).toEqual([]);
  });
});
