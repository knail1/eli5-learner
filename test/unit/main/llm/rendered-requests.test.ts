import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExtractedContent } from '../../../../src/main/extract';
import { fallbackLimits } from '../../../../src/main/llm/models';
import { PromptCatalogue } from '../../../../src/main/llm/prompts';
import { SkillLibrary } from '../../../../src/main/llm/skills';
import { createTasks, type LlmTasks, type PhotoPickSlot, type TaskDeps } from '../../../../src/main/llm/tasks';
import { FakeProvider, loadFakeScript, type FakeScript } from '../../../../src/main/llm/testing/fake';
import type { GenerationRequest, ImageInput, LLMProvider, ModelLimits } from '../../../../src/main/llm/types';
import { PROMPTS_ROOT, REPO, SKILLS_DIR, settingsFor } from './helpers';

/**
 * Byte-identical rendering guard (02 §9): every request the task functions send, for every
 * PromptId on the FakeProvider fixture, is compared with a golden captured before the prompt
 * catalogue moved to config/prompts. A wording change to a prompt or fragment updates the golden
 * on purpose (`npm run test:update-goldens`, then review the diff); an unintended change fails here.
 */

const DEFAULT_SCRIPT = path.join(REPO, 'test/fixtures/llm/default.json');
const GOLDEN = path.join(REPO, 'test/fixtures/llm/rendered-requests.golden.json');
const UPDATE = process.env.ELI5_UPDATE_GOLDENS === '1';
const catalogue = PromptCatalogue.load({ root: PROMPTS_ROOT });
const skills = new SkillLibrary([SKILLS_DIR]);
const signal = new AbortController().signal;
const ctx = { clarifyingInput: 'I run a small widget shop', signal };
const tinyLimits: ModelLimits = { ...fallbackLimits('claude'), contextTokens: 16_000, maxOutputTokens: 2_000 };

interface Recorded {
  taskId: string;
  system: string;
  messages: { role: string; text: string; images?: string[] }[];
  maxOutputTokens: number;
  temperature?: number;
  effort?: string;
  jsonSchema?: string;
}

/** Wraps a provider and records each request without signals or image bytes. */
function recorder(inner: LLMProvider, out: Recorded[]): LLMProvider {
  const rec = (r: GenerationRequest): void => {
    out.push({
      taskId: r.taskId,
      system: r.system,
      messages: r.messages.map((m) => ({
        role: m.role,
        text: m.text,
        ...(m.images?.length ? { images: m.images.map((i) => i.label) } : {}),
      })),
      maxOutputTokens: r.maxOutputTokens,
      ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
      ...(r.effort !== undefined ? { effort: r.effort } : {}),
      ...(r.jsonSchema ? { jsonSchema: r.jsonSchema.name } : {}),
    });
  };
  return {
    id: inner.id,
    model: inner.model,
    limits: inner.limits,
    testConnection: () => inner.testConnection(),
    generate: (r) => {
      rec(r);
      return inner.generate(r);
    },
    generateWithImages: (r) => {
      rec(r);
      return inner.generateWithImages(r);
    },
  };
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

const defaultScript = (): FakeScript => loadFakeScript(DEFAULT_SCRIPT, (p) => fs.readFileSync(p, 'utf8'));

function setup(
  out: Recorded[],
  opts: { script?: FakeScript; limits?: ModelLimits; skills?: SkillLibrary | null; readFile?: () => string } = {},
): LlmTasks {
  const fake = new FakeProvider(opts.script ?? defaultScript(), {
    ...(opts.limits ? { limits: opts.limits } : {}),
    ...(opts.readFile ? { readFile: opts.readFile } : {}),
  });
  const provider = recorder(fake, out);
  const d: TaskDeps = {
    provider: () => provider,
    prompts: catalogue,
    settings: () => settingsFor('claude'),
    ...(opts.skills === null ? {} : { skills: opts.skills ?? skills }),
  };
  return createTasks(d);
}

async function runAll(): Promise<Record<string, Recorded[]>> {
  const out: Record<string, Recorded[]> = {};
  const scenario = async (name: string, fn: (rec: Recorded[]) => Promise<unknown>): Promise<void> => {
    const rec: Recorded[] = [];
    await fn(rec);
    out[name] = rec;
  };
  const sources = [content('notes.md', ['Example Widgets Inc. makes widgets.'])];
  const sourceList = [{ ref: 'notes.md', label: 'notes.md' }];

  await scenario('writing-skills-photos-glossary', async (rec) => {
    const t = setup(rec);
    const p = await t.prepareContent({ contents: sources, sourceList, ...ctx });
    const indepth = await t.generateIndepth(p, { ...ctx, glossary: true, photos: true });
    await t.generateEli5(p, { ...ctx, photos: true });
    await t.generateGlossary(indepth.draft, ctx);
    await t.summarize(indepth.draft, ctx);
  });
  await scenario('writing-no-skills-no-photos', async (rec) => {
    const t = setup(rec, { skills: null });
    const p = await t.prepareContent({ contents: sources, sourceList, ...ctx });
    await t.generateIndepth(p, { ...ctx, glossary: false });
    await t.generateEli5(p, ctx);
  });
  await scenario('writing-empty-skill-library', async (rec) => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'eli5-noskills-'));
    const t = setup(rec, { skills: new SkillLibrary([empty]) });
    const p = await t.prepareContent({ contents: sources, sourceList, ...ctx });
    await t.generateEli5(p, ctx);
  });
  await scenario('chunk-notes', async (rec) => {
    const t = setup(rec, { limits: tinyLimits });
    const para = 'Example Widgets Inc. ships widgets to three regions every week. '.repeat(60);
    const contents = Array.from({ length: 8 }, (_, i) => content(`part-${i}.md`, [para, para]));
    const p = await t.prepareContent({
      contents,
      sourceList: contents.map((c) => ({ ref: c.sourceRef, label: c.sourceRef })),
      ...ctx,
    });
    await t.generateIndepth(p, { ...ctx, glossary: false });
  });
  await scenario('section-actions', async (rec) => {
    const t = setup(rec);
    const section = { heading: 'Widgets', blocks: [{ type: 'paragraph' as const, md: 'Widgets are sold.' }] };
    const prev = { heading: 'Intro', blocks: [{ type: 'paragraph' as const, md: 'Before.' }] };
    for (const tabKind of ['indepth', 'eli5'] as const) {
      for (const action of ['expand', 'reexplain', 'analogy', 'deeper', 'revise'] as const) {
        await t.runSectionAction({
          action,
          tabKind,
          section,
          outline: ['Intro', 'Widgets'],
          prev,
          selection: 'sold',
          note: 'more numbers',
          sourceExcerpt: 'Orders doubled.',
          signal,
        });
      }
    }
    await t.runSectionAction({ action: 'eli5-tab', tabKind: 'indepth', section, outline: [], selection: 'x', signal });
    await t.runSectionAction({
      action: 'eli5-selection',
      tabKind: 'indepth',
      section,
      outline: ['Widgets'],
      selection: 'sold',
      context: 'Section heading: Widgets',
      note: 'one paragraph',
      signal,
    });
    await t.answerSectionQuestion({
      tabKind: 'eli5',
      section,
      outline: ['Intro', 'Widgets'],
      prev,
      selection: 'sold',
      question: 'Who buys them?',
      signal,
    });
  });
  await scenario('merge', async (rec) => {
    const t = setup(rec);
    await t.matchMerge('widgets', [{ catalogId: 'c1', title: 't', summary: 's' }]);
    await t.weaveMerge({
      targetTitle: 'Target',
      incomingTitle: 'Incoming',
      target: 'I1 Intro\n[1] para',
      incoming: 'X1 Other\n[1] para',
      imageLabels: ['a.png'],
    });
  });
  await scenario('photo-pick', async (rec) => {
    const slot: PhotoPickSlot = {
      id: 's1',
      purpose: 'show a courthouse',
      alt: 'A courthouse',
      sensitive: false,
      candidates: [{ label: 's1-c1', title: 'Courthouse', license: 'CC BY 2.0' }],
    };
    const images: ImageInput[] = [{ mediaType: 'image/jpeg', data: Buffer.from([1]), label: 's1-c1', sourceRef: 's1' }];
    await setup(rec).pickPhotos({ slots: [slot], images, signal });
  });
  await scenario('overflow-retry', async (rec) => {
    const t = setup(rec, { script: { ...defaultScript(), truncateTask: 'in-depth' } });
    const p = await t.prepareContent({ contents: sources, sourceList, ...ctx });
    await t.generateIndepth(p, { ...ctx, glossary: false }).catch(() => undefined);
  });
  await scenario('repair', async (rec) => {
    const script = defaultScript();
    const valid = (k: 'summary' | 'eli5'): unknown => script.responses[k];
    const t = setup(rec, {
      script: {
        responses: { summary: ['"not json"', valid('summary')] as never, eli5: ['EMPTY', valid('eli5')] as never },
      },
      readFile: () => '', // 'EMPTY' resolves to an empty reply: the repair turn says "(no output)"
    });
    const p = await t.prepareContent({ contents: sources, sourceList, ...ctx });
    await t.summarize({ kind: 'indepth', title: 'T', sections: [{ heading: 'H', blocks: [] }] } as never, ctx);
    await t.generateEli5(p, ctx);
  });
  return out;
}

describe('rendered requests are byte-identical to the golden (02 §9)', () => {
  it('matches the golden for every prompt id', async () => {
    const all = await runAll();
    const ids = new Set(Object.values(all).flatMap((r) => r.map((x) => x.taskId)));
    expect([...ids].sort()).toEqual([...catalogue.all().map((d) => d.id)].sort());
    const text = JSON.stringify(all, null, 2) + '\n';
    if (UPDATE || !fs.existsSync(GOLDEN)) fs.writeFileSync(GOLDEN, text);
    const golden = fs.readFileSync(GOLDEN, 'utf8');
    expect(JSON.parse(text)).toEqual(JSON.parse(golden)); // a readable per-request diff first
    expect(text === golden, 'rendered requests are not byte-identical to the golden').toBe(true);
  });
});
