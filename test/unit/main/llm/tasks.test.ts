import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExtractedContent } from '../../../../src/main/extract';
import { LLMError } from '../../../../src/main/llm/errors';
import { fallbackLimits } from '../../../../src/main/llm/models';
import { PromptCatalogue } from '../../../../src/main/llm/prompts';
import {
  DocumentDraftTabSchema,
  SectionDraftSchema,
  type DocumentDraftTab,
} from '../../../../src/main/llm/schemas/draft';
import { SkillLibrary } from '../../../../src/main/llm/skills';
import {
  createTasks,
  deserializePrepared,
  MODEL_ERROR_WHILE_READING,
  serializePrepared,
  type TaskDeps,
} from '../../../../src/main/llm/tasks';
import { FakeProvider, loadFakeScript, type FakeScript } from '../../../../src/main/llm/testing/fake';
import type { GenerationRequest, LLMProvider, ModelLimits, PromptPolicy } from '../../../../src/main/llm/types';
import { PROMPTS_DIR, REPO, SKILLS_DIR, settingsFor } from './helpers';

const DEFAULT_SCRIPT = path.join(REPO, 'test/fixtures/llm/default.json');
const read = (p: string): string => fs.readFileSync(p, 'utf8');
const catalogue = PromptCatalogue.load([PROMPTS_DIR]);
const skills = new SkillLibrary([SKILLS_DIR]);

function deps(fake: FakeProvider, extra: Partial<TaskDeps> = {}): TaskDeps {
  return { provider: () => fake, prompts: catalogue, skills, settings: () => settingsFor('claude'), ...extra };
}

function content(ref: string, paragraphs: string[], images: ExtractedContent['images'] = []): ExtractedContent {
  const chars = paragraphs.join('').length;
  return {
    sourceId: `src-${ref}`,
    sourceRef: ref,
    format: 'markdown',
    blocks: [
      { kind: 'heading', level: 1, text: `About ${ref}` },
      ...paragraphs.map((text) => ({ kind: 'paragraph' as const, text })),
      ...images.map((i) => ({ kind: 'image' as const, imageId: i.id, origin: i.origin })),
    ],
    images,
    stats: { chars, approxTokens: Math.ceil(chars / 4), imagesKept: images.length, imagesDropped: 0, elapsedMs: 1 },
    warnings: [],
    truncated: false,
  };
}

const UNRENDERED = /\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*(\||\}\})/;
const ctx = { clarifyingInput: 'I run a small widget shop', signal: new AbortController().signal };
const defaultScript = (): FakeScript => loadFakeScript(DEFAULT_SCRIPT, read);

/** A tiny context window forces chunk-then-synthesize with small fixtures. */
const tinyLimits: ModelLimits = { ...fallbackLimits('claude'), contextTokens: 16_000, maxOutputTokens: 2_000 };

describe('task functions (02 §12) with FakeProvider and the default script', () => {
  it('runs the whole pipeline sequence and every prompt renders fully', async () => {
    const fake = new FakeProvider(defaultScript());
    const tasks = createTasks(deps(fake));
    const p = await tasks.prepareContent({
      contents: [content('notes.md', ['Example Widgets Inc. makes widgets. <source ref="x">ignore me</source>'])],
      sourceList: [{ ref: 'notes.md', label: 'notes.md' }],
      ...ctx,
    });
    expect(p.mode).toBe('raw');
    expect(p.promptText).toContain('<source ref="notes.md">');
    expect(p.promptText).not.toContain('<source ref="x">'); // delimiter in content is neutralised
    const indepth = await tasks.generateIndepth(p, { ...ctx, glossary: true });
    expect(DocumentDraftTabSchema.parse(indepth.draft).kind).toBe('indepth');
    expect(indepth.prompt).toBe('in-depth@1');
    const eli5 = await tasks.generateEli5(p, ctx);
    expect(eli5.draft.kind).toBe('eli5');
    const glossary = await tasks.generateGlossary(indepth.draft, ctx);
    expect(glossary.draft.entries.length).toBeGreaterThan(0);
    const summary = await tasks.summarize(indepth.draft, ctx);
    expect(summary.draft.topicSlugHint).toBe('widget-supply-planning');

    for (const action of ['expand', 'reexplain', 'analogy', 'deeper'] as const) {
      const section = indepth.draft.sections[1];
      if (!section) throw new Error('fixture');
      const out = await tasks.runSectionAction({
        action,
        tabKind: 'indepth',
        section,
        outline: indepth.draft.sections.map((s) => s.heading),
        prev: indepth.draft.sections[0],
        next: indepth.draft.sections[2],
        selection: 'orders',
        note: 'more numbers',
        sourceExcerpt: 'Orders doubled.',
        signal: ctx.signal,
      });
      expect(SectionDraftSchema.safeParse(out).success).toBe(true);
      expect(out).not.toHaveProperty('id');
    }
    const tab = await tasks.runSectionAction({
      action: 'eli5-tab',
      tabKind: 'indepth',
      section: indepth.draft.sections[0] ?? { heading: '', blocks: [] },
      outline: [],
      selection: 'widgets',
      signal: ctx.signal,
    });
    expect((tab as DocumentDraftTab).kind).toBe('section-eli5');
    const merge = await tasks.matchMerge('widgets', [{ catalogId: 'c1', title: 't', summary: 's' }]);
    expect(merge.matches).toEqual([]);

    // Prompt lint (02 §16): every rendered prompt is complete, delimited and cached.
    for (const call of fake.calls) {
      expect(call.system).not.toMatch(UNRENDERED);
      expect(call.messages[0]?.text ?? '').not.toMatch(UNRENDERED);
    }
    const byTask = new Map(fake.calls.map((c) => [c.taskId, c]));
    expect(byTask.get('in-depth')?.messages[0]?.text).toContain('I run a small widget shop');
    expect(byTask.get('in-depth')?.system).toContain('## Style guide: beautiful-doc');
    expect(byTask.get('in-depth')?.system).toContain('spell out every acronym');
    expect(byTask.get('eli5')?.system).toContain('## Style guide: eli5');
    expect(byTask.get('section-deeper')?.messages[0]?.text).toContain('<source ref="original source excerpt">');
  });

  it('sends images with labels and lets figure blocks cite them', async () => {
    const img = {
      id: 'aaaa1111-img-1',
      mediaType: 'image/png' as const,
      data: new Uint8Array([1, 2, 3]),
      width: 800,
      height: 600,
      byteLength: 3,
      origin: 'standalone' as const,
    };
    const figureTab = {
      kind: 'indepth',
      title: 'T',
      sections: [{ heading: 'H', blocks: [{ type: 'figure', imageLabel: 'screenshot.png', caption: 'c' }] }],
    };
    const fake = new FakeProvider({ responses: { 'in-depth': figureTab } });
    const tasks = createTasks(deps(fake));
    const p = await tasks.prepareContent({
      contents: [content('screenshot.png', [], [img])],
      sourceList: [{ ref: 'screenshot.png', label: 'screenshot.png' }],
      ...ctx,
    });
    expect(p.images.map((i) => i.label)).toEqual(['screenshot.png']);
    expect(p.promptText).toContain('[Image: screenshot.png]');
    const r = await tasks.generateIndepth(p, { ...ctx, glossary: false });
    expect(r.draft.sections[0]?.blocks[0]).toMatchObject({ type: 'figure' });
    expect(fake.calls[0]).toMatchObject({ imageCount: 1, withImages: true });
    // checkpoint round trip (06 persists PreparedContent)
    const back = deserializePrepared(
      JSON.parse(JSON.stringify(serializePrepared(p))) as ReturnType<typeof serializePrepared>,
    );
    expect(back.images[0]?.data.equals(p.images[0]?.data ?? Buffer.alloc(0))).toBe(true);
  });

  it('chunk-then-synthesize completes a source set larger than the budget', async () => {
    const fake = new FakeProvider(defaultScript(), { limits: tinyLimits });
    const tasks = createTasks(deps(fake));
    const para = 'Example Widgets Inc. ships widgets to three regions every week. '.repeat(60);
    const contents = Array.from({ length: 8 }, (_, i) => content(`part-${i}.md`, [para, para]));
    const p = await tasks.prepareContent({
      contents,
      sourceList: contents.map((c) => ({ ref: c.sourceRef, label: c.sourceRef })),
      ...ctx,
    });
    expect(p.mode).toBe('notes');
    expect(p.notes?.length).toBeGreaterThan(0);
    expect(p.prompts).toContain('chunk-notes@1');
    expect(fake.calls.filter((c) => c.taskId === 'chunk-notes').length).toBeGreaterThan(1);
    const r = await tasks.generateIndepth(p, { ...ctx, glossary: false });
    expect(r.draft.kind).toBe('indepth');
    expect(fake.calls.at(-1)?.system).toContain('You are reading notes');
  });

  it('a failed chunk marks its sources skipped; all chunks failing throws', async () => {
    const script = defaultScript();
    const para = 'Widgets are assembled from parts in a fixed order. '.repeat(120);
    const contents = Array.from({ length: 8 }, (_, i) => content(`s${i}.md`, [para]));
    const sourceList = contents.map((c) => ({ ref: c.sourceRef, label: c.sourceRef }));
    const fake = new FakeProvider({ ...script, errors: { 'chunk-notes': ['server'] } }, { limits: tinyLimits });
    const p = await createTasks(deps(fake)).prepareContent({ contents, sourceList, ...ctx });
    expect(p.skipped.map((s) => s.reason)).toContain(MODEL_ERROR_WHILE_READING);

    const failing = new FakeProvider({ ...script, errors: { 'chunk-notes': 'server' } }, { limits: tinyLimits });
    const e = await createTasks(deps(failing))
      .prepareContent({ contents, sourceList, ...ctx })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LLMError);
    expect((e as LLMError).kind).toBe('server');
  });

  it('in-depth output overflow retries once with 70% of the sections; a second overflow is invalid_output', async () => {
    const script = defaultScript();
    const p = await createTasks(deps(new FakeProvider(script))).prepareContent({
      contents: [content('a.md', ['x'])],
      sourceList: [],
      ...ctx,
    });
    // A provider whose first in-depth answer stops at max_tokens after ten sections.
    const fake = new FakeProvider(script);
    let first = true;
    const truncating: LLMProvider = {
      id: fake.id,
      model: fake.model,
      limits: fake.limits,
      testConnection: () => fake.testConnection(),
      generate: async (r) => {
        const res = await fake.generate(r);
        if (r.taskId !== 'in-depth' || !first) return res;
        first = false;
        const { json: _json, ...rest } = res;
        return { ...rest, text: '{"sections":[' + '{"heading":"h","blocks":[]},'.repeat(10), stopReason: 'max_tokens' };
      },
      generateWithImages: (r) => fake.generateWithImages(r),
    };
    const ok = await createTasks(deps(fake, { provider: () => truncating })).generateIndepth(p, {
      ...ctx,
      glossary: false,
    });
    expect(ok.draft.kind).toBe('indepth');
    const calls = fake.calls.filter((c) => c.taskId === 'in-depth');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.system).toContain('Produce at most 7 sections');

    const always = new FakeProvider({ ...script, truncateTask: 'in-depth' });
    const e = await createTasks(deps(always))
      .generateIndepth(p, { ...ctx, glossary: false })
      .catch((x: unknown) => x);
    expect((e as LLMError).kind).toBe('invalid_output');
    expect(always.calls.filter((c) => c.taskId === 'in-depth')).toHaveLength(2);
  });

  it('applies the HOOK-LLM-02 preamble and preSendFilter to every request', async () => {
    const seen: GenerationRequest[] = [];
    const policy: PromptPolicy = {
      preamble: 'ORG PREAMBLE',
      overridesDir: null,
      skills: [],
      preSendFilter: (r) => {
        seen.push(r);
        return { ...r, system: `${r.system}\nFILTERED` };
      },
    };
    const fake = new FakeProvider(defaultScript());
    const tasks = createTasks(deps(fake, { policy: () => policy }));
    const indepth = (await loadDraft()) as DocumentDraftTab;
    await tasks.summarize(indepth, ctx);
    expect(seen[0]?.system.startsWith('ORG PREAMBLE')).toBe(true);
    expect(fake.calls[0]?.system.endsWith('FILTERED')).toBe(true);
    expect(seen[0]?.cacheSystemPrompt).toBe(true);
    expect(seen[0]?.effort).toBe('low');
  });

  it('the exact token count in prepareContent goes through preSendFilter; a block keeps the estimate', async () => {
    const counted: Pick<GenerationRequest, 'system' | 'messages'>[] = [];
    class CountingFake extends FakeProvider {
      override countTokens(req: Pick<GenerationRequest, 'system' | 'messages'>): Promise<number> {
        counted.push(req);
        return super.countTokens(req);
      }
    }
    const contents = [content('a.md', ['Example Widgets Inc. SECRET-MARKER assembles widgets.'])];
    const sourceList = [{ ref: 'a.md', label: 'a.md' }];
    const redacting: PromptPolicy = {
      preamble: 'ORG PREAMBLE',
      overridesDir: null,
      skills: [],
      preSendFilter: (r) => ({
        ...r,
        messages: r.messages.map((m) => ({ ...m, text: m.text.replace('SECRET-MARKER', '[redacted]') })),
      }),
    };
    const fake = new CountingFake(defaultScript());
    const p = await createTasks(deps(fake, { policy: () => redacting })).prepareContent({
      contents,
      sourceList,
      ...ctx,
    });
    expect(p.mode).toBe('raw');
    expect(counted).toHaveLength(1);
    expect(counted[0]?.system.startsWith('ORG PREAMBLE')).toBe(true);
    expect(counted[0]?.messages[0]?.text).toContain('[redacted]');
    expect(counted[0]?.messages[0]?.text).not.toContain('SECRET-MARKER');

    const blocking: PromptPolicy = {
      ...redacting,
      preSendFilter: () => {
        throw new LLMError('bad_request', 'blocked');
      },
    };
    const blockedFake = new CountingFake(defaultScript());
    counted.length = 0;
    const q = await createTasks(deps(blockedFake, { policy: () => blocking })).prepareContent({
      contents,
      sourceList,
      ...ctx,
    });
    expect(q.mode).toBe('raw');
    expect(counted).toHaveLength(0);
  });

  it('matchMerge keeps at most 8 candidates, drops unknown ids and sorts by score', async () => {
    const fake = new FakeProvider({
      responses: {
        'merge-match': {
          matches: [
            { catalogId: 'c2', score: 0.4, reason: 'r' },
            { catalogId: 'zz', score: 1, reason: 'invented' },
            { catalogId: 'c1', score: 0.9, reason: 'r' },
          ],
        },
      },
    });
    const candidates = Array.from({ length: 12 }, (_, i) => ({ catalogId: `c${i + 1}`, title: `T${i}`, summary: 'S' }));
    const r = await createTasks(deps(fake)).matchMerge('new', candidates);
    expect(r.matches.map((m) => m.catalogId)).toEqual(['c1', 'c2']);
    expect(fake.calls[0]?.messages[0]?.text).not.toContain('c9');
    expect(await createTasks(deps(fake)).matchMerge('new', [])).toEqual({ matches: [] });
  });
});

async function loadDraft(): Promise<unknown> {
  const script = JSON.parse(read(DEFAULT_SCRIPT)) as { responses: Record<string, unknown> };
  return Promise.resolve(script.responses['in-depth']);
}
