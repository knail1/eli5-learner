import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  failureNotice,
  parseDocument,
  type DocumentModel,
  type QaDocBlock,
  type SectionId,
} from '../../../../../src/main/document';
import type { DocumentMeta, SourceSidecarInput } from '../../../../../src/main/library';
import { DeepContextTooLargeError } from '../../../../../src/main/llm';
import type { PipelineFailure } from '../../../../../src/main/pipeline';
import type { SectionBusyEvent } from '../../../../../src/preload/contract';
import { DEEPER_RESULT, rejection, sec, setup, type Setup } from './harness';

/** Ask deeper (08 §6.10): the material, saving, the box, labels, logging, busy depth and the limit. */

const CANARY = 'Report text: search took 61 percent of the spend.';
const src = (ref: string, text: string): SourceSidecarInput => ({
  ref,
  label: ref,
  kind: 'file',
  mime: 'application/pdf',
  format: 'pdf',
  text,
  chars: text.length,
  extractTruncated: false,
});

const askReq = (s: Setup, over: Record<string, unknown> = {}) => ({
  slug: s.slug,
  tabKey: 'indepth',
  sectionId: sec(s.model, 0, 0),
  selectionText: 'judges every channel',
  question: 'What ROAS do shops usually aim for?',
  depth: 'deeper' as const,
  ...over,
});

const meta = async (s: Setup): Promise<DocumentMeta> =>
  JSON.parse(await readFile(s.lib.docPath(s.slug, 'meta.json'), 'utf8')) as DocumentMeta;

const boxesOf = (m: DocumentModel, id: SectionId): QaDocBlock[] =>
  (m.tabs.flatMap((t) => t.sections).find((x) => x.id === id)?.blocks ?? []).filter(
    (b): b is QaDocBlock => b.type === 'qa',
  );

async function run(s: Setup, over: Record<string, unknown> = {}): Promise<string> {
  const { jobId } = await s.ir.actions.askSection(askReq(s, over));
  await s.ir.runner(s.ctx(jobId).ctx);
  s.jobs.emit(jobId, 'done');
  return jobId;
}

describe('Ask deeper: material and call (08 §6.10 steps 2-3)', () => {
  it('sends the Ask deep material to answerDeeperQuestion and never calls the other asks', async () => {
    const s = await setup({ sources: [src('widgets.pdf', CANARY)] });
    await run(s);
    expect(s.answerDeeperQuestion).toHaveBeenCalledTimes(1);
    expect(s.answerDeepQuestion).not.toHaveBeenCalled();
    expect(s.answerSectionQuestion).not.toHaveBeenCalled();
    const i = s.answerDeeperQuestion.mock.calls[0]?.[0];
    expect(i?.tabs.map((t) => t.key)).toEqual(s.model.tabs.map((t) => t.key));
    expect(i?.sources?.[0]).toMatchObject({ ref: 'widgets.pdf', text: CANARY });
    expect(i).toMatchObject({ question: 'What ROAS do shops usually aim for?', selection: 'judges every channel' });
  });

  it('maps DeepContextTooLargeError to SECTION_TOO_LARGE (deep_context) with the deep notice', async () => {
    const s = await setup();
    s.answerDeeperQuestion.mockRejectedValueOnce(new DeepContextTooLargeError());
    const before = await s.read();
    const { jobId } = await s.ir.actions.askSection(askReq(s));
    const err = await rejection(s.ir.runner(s.ctx(jobId).ctx));
    expect(err).toMatchObject({ code: 'SECTION_TOO_LARGE' });
    expect((err as unknown as PipelineFailure).detail).toBe('deep_context');
    expect(await s.read()).toBe(before);
    expect(failureNotice('SECTION_TOO_LARGE', { action: 'ask', depth: 'deeper' })).toBe(
      'This question needs more context than the model allows; try Ask',
    );
  });
});

describe('Ask deeper: saving (08 §6.10 steps 6-8)', () => {
  it('writes a qa-deeper box with the reach badge and the page list, asks[].depth and a deeper version node', async () => {
    const s = await setup({ sources: [src('widgets.pdf', CANARY)] });
    const spy = vi.spyOn(s.lib, 'updateDocument');
    const id = sec(s.model, 0, 0);
    const jobId = await run(s);
    const html = await s.read();
    const [box] = boxesOf(parseDocument(html).model, id);
    expect(box).toMatchObject({
      depth: 'deeper',
      sources: 'all',
      reach: 'web',
      web: [{ title: 'What is a good ROAS?', url: 'https://example.org/guides/roas?ref=x' }],
      topic: DEEPER_RESULT.draft.topic,
    });
    expect(html).toContain(
      `<aside class="qa qa-deeper" id="${box?.id}" aria-label="Deeper answer to a reader question">`,
    );
    expect(html).not.toContain('class="qa qa-deep"');
    expect(html).toContain(
      '<p class="qa-badge" data-eli5-noact>Deeper answer · includes information from the web (pages listed below)</p>',
    );
    // The page list: plain text, after the answer, no query string, never a link.
    expect(html).toContain(
      '<ul class="qa-web" data-eli5-noact aria-label="Web pages used"><li>What is a good ROAS? — example.org/guides/roas</li></ul>',
    );
    const aside = html.slice(
      html.indexOf('<aside class="qa qa-deeper"'),
      html.indexOf('</aside>', html.indexOf('qa-deeper')),
    );
    expect(aside).not.toContain('<a ');
    expect(aside.indexOf('<div class="qa-a">')).toBeLessThan(aside.indexOf('<ul class="qa-web"'));
    expect(html).not.toContain(CANARY);
    const m = await meta(s);
    expect(m.asks).toEqual([expect.objectContaining({ jobId, qaId: box?.id, depth: 'deeper' })]);
    const patch = spy.mock.calls.at(-1)?.[1];
    expect(patch?.label).toBe("asked (deeper) about 'Typical ROAS targets'");
    expect(patch?.change).toMatchObject({ kind: 'ask', depth: 'deeper', jobId });
    const tree = await s.ir.history.versions(s.slug);
    expect(tree.nodes.at(-1)).toMatchObject({ kind: 'ask', depth: 'deeper' });
  });

  it.each([
    ['material', 'found in the document and its original sources'],
    ['general', "includes the AI's general knowledge, not from the document or the web"],
  ] as const)('reach %s gets its badge and no page list', async (reach, text) => {
    const s = await setup();
    s.answerDeeperQuestion.mockResolvedValueOnce({
      ...DEEPER_RESULT,
      draft: { ...DEEPER_RESULT.draft, reach, web: [] },
    });
    await run(s);
    const html = await s.read();
    expect(html).toContain(`<p class="qa-badge" data-eli5-noact>Deeper answer · ${text}</p>`);
    expect(html).not.toContain('class="qa-web"');
  });

  it('escapes page titles and stores paragraph links as text', async () => {
    const s = await setup();
    s.answerDeeperQuestion.mockResolvedValueOnce({
      ...DEEPER_RESULT,
      draft: {
        ...DEEPER_RESULT.draft,
        paragraphs: ['From the web, see [this page](https://evil.example/x) for more.'],
        web: [{ title: '<img src=x onerror=alert(1)> & co', url: 'https://example.org/a#frag' }],
      },
    });
    const id = sec(s.model, 0, 0);
    await run(s);
    const html = await s.read();
    const [box] = boxesOf(parseDocument(html).model, id);
    expect(box?.paragraphs).toEqual(['From the web, see this page for more.']);
    expect(box?.web).toEqual([{ title: '<img src=x onerror=alert(1)> & co', url: 'https://example.org/a' }]);
    expect(html).toContain('<li>&lt;img src=x onerror=alert(1)&gt; &amp; co — example.org/a</li>');
    expect(html).not.toContain('https://evil.example');
  });

  it('logs counts only: kind deeper, sourceMode, chunks, inputTokens, webSearches, webKept', async () => {
    const info = vi.fn();
    const s = await setup({
      sources: [src('widgets.pdf', CANARY)],
      deps: { log: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
    });
    await run(s);
    expect(info).toHaveBeenCalledWith('document.section-action', expect.objectContaining({ kind: 'ask-deeper' }));
    expect(info).toHaveBeenCalledWith('document.deep-ask', {
      slug: s.slug,
      sectionId: sec(s.model, 0, 0),
      kind: 'deeper',
      sourceMode: 'all',
      count: 0,
      inputTokens: 900,
      webSearches: 2,
      webKept: 1,
    });
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain(CANARY);
    expect(logged).not.toContain('example.org');
    expect(logged).not.toContain('What ROAS');
  });
});

describe('Ask deeper: busy depth and the shared deep limiter (08 §6.1 step 1a)', () => {
  it('puts depth deeper on the payload, the first busy event and the pending row', async () => {
    const s = await setup();
    const { jobId } = await s.ir.actions.askSection(askReq(s));
    expect(s.jobs.get(jobId)?.section).toMatchObject({ action: 'ask', depth: 'deeper' });
    const first = s.events.busy[0] as SectionBusyEvent;
    expect(first.busy).toEqual([{ sectionId: sec(s.model, 0, 0), action: 'ask', depth: 'deeper' }]);
    const tree = await s.ir.history.versions(s.slug);
    expect(tree.pending).toEqual([expect.objectContaining({ action: 'ask', depth: 'deeper' })]);
  });

  it('Ask deep and Ask deeper share the 3 per 60 s limit, while a quick ask still passes', async () => {
    const s = await setup();
    for (const depth of ['deep', 'deeper', 'deep'] as const) {
      const { jobId } = await s.ir.actions.askSection(askReq(s, { depth, question: `Q ${depth}?` }));
      s.jobs.emit(jobId, 'done');
    }
    expect(await rejection(s.ir.actions.askSection(askReq(s)))).toMatchObject({ code: 'E_RATE_LIMITED' });
    expect(await rejection(s.ir.actions.askSection(askReq(s, { depth: 'deep' })))).toMatchObject({
      code: 'E_RATE_LIMITED',
    });
    const { jobId } = await s.ir.actions.askSection(askReq(s, { depth: undefined }));
    expect(jobId).toBeTruthy();
  });
});
