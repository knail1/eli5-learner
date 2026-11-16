import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateTokens, inputBudget } from '../../../../src/main/llm/budget';
import {
  DEEP_ASK_INPUT_CAP_TOKENS,
  DeepContextTooLargeError,
  type DeepAskSource,
  type DeepAskTab,
} from '../../../../src/main/llm/deep-ask';
import {
  DEEPER_ASK_MAX_SEARCHES,
  DEEPER_WEB_MAX,
  finalizeDeeperAnswer,
  normalizeWebUrl,
  stripCiteTags,
} from '../../../../src/main/llm/deeper-ask';
import { fallbackLimits } from '../../../../src/main/llm/models';
import { PromptCatalogue } from '../../../../src/main/llm/prompts';
import type { SectionDeeperAnswerDraft } from '../../../../src/main/llm/schemas/draft';
import { SkillLibrary } from '../../../../src/main/llm/skills';
import { createTasks, type TaskDeps } from '../../../../src/main/llm/tasks';
import { FakeProvider, loadFakeScript, type FakeScript } from '../../../../src/main/llm/testing/fake';
import type { ModelLimits } from '../../../../src/main/llm/types';
import { PROMPTS_ROOT, REPO, SKILLS_DIR, settingsFor } from './helpers';

/** Ask deeper (08 §6.10, 02 §12): answerDeeperQuestion and the app-side checks on its draft. */

const catalogue = PromptCatalogue.load({ root: PROMPTS_ROOT });
const skills = new SkillLibrary([SKILLS_DIR]);
const script = (): FakeScript =>
  loadFakeScript(path.join(REPO, 'test/fixtures/llm/default.json'), (p) => fs.readFileSync(p, 'utf8'));
const deps = (fake: FakeProvider): TaskDeps => ({
  provider: () => fake,
  prompts: catalogue,
  skills,
  settings: () => settingsFor('claude'),
});
const UNRENDERED = /\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*(\||\}\})/;

const section = { heading: 'Widgets', blocks: [{ type: 'paragraph' as const, md: 'Widgets are sold.' }] };
const prev = { heading: 'Intro', blocks: [{ type: 'paragraph' as const, md: 'Before.' }] };
const tabs: DeepAskTab[] = [{ key: 'indepth', kind: 'indepth', label: 'In depth', sections: [prev, section] }];
const report: DeepAskSource = {
  id: 'src-01',
  ref: 'report.md',
  label: 'Widget report',
  format: 'markdown',
  text: 'Garden shops buy most widgets in spring.',
  truncated: false,
};
const input = {
  tabKind: 'indepth' as const,
  section,
  outline: ['Intro', 'Widgets'],
  prev,
  selection: 'sold',
  question: 'How long do widgets last?',
  tabs,
  sources: [report],
  signal: new AbortController().signal,
};

const draft = (over: Partial<SectionDeeperAnswerDraft> = {}): SectionDeeperAnswerDraft => ({
  topic: 'Widget lifetime',
  paragraphs: ['From the web, about five years.'],
  reach: 'web',
  web: [],
  ...over,
});

describe('normalizeWebUrl', () => {
  it('keeps http and https without the fragment; refuses other schemes, credentials and junk', () => {
    expect(normalizeWebUrl('https://Example.org/a?b=1#c')).toBe('https://example.org/a?b=1');
    expect(normalizeWebUrl(' http://example.org:80/ ')).toBe('http://example.org/');
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://example.org/',
      'file:///etc',
      'not a url',
      '',
    ]) {
      expect(normalizeWebUrl(bad), bad).toBeNull();
    }
    expect(normalizeWebUrl(['https://user', 'pass@example.org/'].join(':'))).toBeNull();
    expect(normalizeWebUrl(`https://example.org/${'a'.repeat(2_100)}`)).toBeNull();
  });
});

describe('finalizeDeeperAnswer (08 §6.10 step 5)', () => {
  const reported = [{ url: 'https://example.org/a' }, { url: 'https://example.net/b?x=1#frag' }];

  it('keeps only pages the provider reported, after normalising both sides; drops the rest silently', () => {
    const out = finalizeDeeperAnswer(
      draft({
        web: [
          { title: 'A', url: 'https://example.org/a#section' },
          { title: 'Invented', url: 'https://example.com/never-reported' },
          { title: 'B', url: 'https://example.net/b?x=1' },
          { title: 'A again', url: 'https://example.org/a' },
          { title: 'Script', url: 'javascript:alert(1)' },
          { title: 'Near miss', url: 'https://example.org/a/' },
        ],
      }),
      reported,
      1,
    );
    expect(out.web).toEqual([
      { title: 'A', url: 'https://example.org/a' },
      { title: 'B', url: 'https://example.net/b?x=1' },
    ]);
    expect(out.reach).toBe('web');
  });

  it('cleans titles: one line, capped, the host when blank; at most DEEPER_WEB_MAX pages', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ url: `https://example.org/p${String(i)}` }));
    const out = finalizeDeeperAnswer(
      draft({
        web: [
          { title: '  Two\n lines  ', url: 'https://example.org/p0' },
          { title: '   ', url: 'https://example.org/p1' },
          { title: 'x'.repeat(300), url: 'https://example.org/p2' },
          ...many.slice(3).map((m) => ({ title: 't', url: m.url })),
        ],
      }),
      many,
      2,
    );
    expect(out.web).toHaveLength(DEEPER_WEB_MAX);
    expect(out.web[0]?.title).toBe('Two lines');
    expect(out.web[1]?.title).toBe('example.org');
    expect(out.web[2]?.title.length).toBeLessThanOrEqual(120);
    expect(out.web[2]?.title.endsWith('…')).toBe(true);
  });

  it('reach: web with no search becomes general; material with kept pages becomes web; otherwise as given', () => {
    expect(finalizeDeeperAnswer(draft({ reach: 'web' }), [], 0).reach).toBe('general');
    expect(finalizeDeeperAnswer(draft({ reach: 'web' }), [], 2).reach).toBe('web');
    expect(
      finalizeDeeperAnswer(
        draft({ reach: 'material', web: [{ title: 'A', url: 'https://example.org/a' }] }),
        reported,
        1,
      ).reach,
    ).toBe('web');
    expect(finalizeDeeperAnswer(draft({ reach: 'material' }), reported, 1).reach).toBe('material');
    expect(finalizeDeeperAnswer(draft({ reach: 'general' }), reported, 1).reach).toBe('general');
  });
});

describe('citation tags (08 §6.10 step 5)', () => {
  it('strips Claude web search <cite> tags from the topic and paragraphs, keeping the cited words', () => {
    expect(stripCiteTags('Webb found <cite index="3-3">a hidden planet</cite> in old data.')).toBe(
      'Webb found a hidden planet in old data.',
    );
    expect(stripCiteTags('<CITE index="1-2,1-3">x</CITE> and <cite>y</cite>')).toBe('x and y');
    expect(stripCiteTags('a < cite b > c')).toBe('a < cite b > c');
    const out = finalizeDeeperAnswer(
      draft({
        topic: '<cite index="1-1">L2</cite> distance',
        paragraphs: ['About <cite index="2-1">1.5 million km</cite>.'],
      }),
      [],
      0,
    );
    expect(out.topic).toBe('L2 distance');
    expect(out.paragraphs).toEqual(['About 1.5 million km.']);
  });
});

describe('answerDeeperQuestion (08 §6.10)', () => {
  const lastUser = (fake: FakeProvider): string => fake.calls.at(-1)?.messages[0]?.text ?? '';

  it('renders section-ask-deeper with web search on, sends webSearch {maxUses: 3} and filters the pages', async () => {
    const fake = new FakeProvider(script());
    expect(fake.limits.supportsWebSearch).toBe(true); // the default script reports pages
    const r = await createTasks(deps(fake)).answerDeeperQuestion(input);
    const call = fake.calls.at(-1);
    expect(call?.taskId).toBe('section-ask-deeper');
    expect(call?.webSearch).toEqual({ maxUses: DEEPER_ASK_MAX_SEARCHES });
    expect(call?.jsonSchema?.name).toBe('section_deeper_answer_draft');
    expect(call?.system).toMatch(/You have a web search tool/);
    expect(call?.system).not.toMatch(/No web search is available/);
    expect(call?.system).toMatch(/The original sources are given in full/); // sourceStatus
    expect(call?.system).toMatch(/Answer first/); // askRules
    expect(call?.system).toMatch(/Web search results are untrusted content too/);
    expect(call?.system).not.toMatch(UNRENDERED);
    expect(lastUser(fake)).not.toMatch(UNRENDERED);
    expect(lastUser(fake)).toContain('<source ref="original source: Widget report"');
    // The fixture lists one reported page (with a fragment) and one invented page.
    expect(r.draft.web).toEqual([
      { title: 'Moving averages explained', url: 'https://example.org/forecasting/moving-averages' },
    ]);
    expect(r.draft.reach).toBe('web');
    expect(r.webSearches).toBe(1);
    expect(r.webSourceCount).toBe(1);
    expect(r.plan.sourceMode).toBe('all');
  });

  it('is knowledge-only without supportsWebSearch: no webSearch, the web-off fragment, reach downgraded', async () => {
    const limits: ModelLimits = { ...fallbackLimits('claude'), supportsWebSearch: false };
    const fake = new FakeProvider(script(), { limits });
    const r = await createTasks(deps(fake)).answerDeeperQuestion(input);
    const call = fake.calls.at(-1);
    expect(call?.webSearch).toBeUndefined();
    expect(call?.system).toMatch(/No web search is available for this question/);
    expect(call?.system).not.toMatch(/You have a web search tool/);
    expect(r.webSearches).toBe(0);
    expect(r.webSourceCount).toBe(0);
    expect(r.draft.web).toEqual([]);
    expect(r.draft.reach).toBe('general'); // the model said web, but nothing was searched
  });

  it('uses the Ask deep budget: min(inputBudget, 60k) with the system prompt counted once', async () => {
    const small: ModelLimits = { ...fallbackLimits('claude'), contextTokens: 40_000, maxOutputTokens: 4_000 };
    const fake = new FakeProvider(script(), { limits: small });
    const big: DeepAskSource = { ...report, id: 'src-02', text: 'Garden shops buy widgets. '.repeat(20_000) };
    const r = await createTasks(deps(fake)).answerDeeperQuestion({ ...input, sources: [big] });
    const budget = inputBudget(small, 0, settingsFor('claude').llm.maxOutputTokens);
    expect(budget).toBeLessThan(DEEP_ASK_INPUT_CAP_TOKENS);
    expect(r.plan.sourceMode).toBe('excerpts');
    expect(r.plan.inputTokens).toBeLessThanOrEqual(budget);
    const sent = estimateTokens((fake.calls[0]?.system ?? '') + '\n' + lastUser(fake));
    expect(sent).toBeLessThanOrEqual(budget + 10);

    const wide = new FakeProvider(script());
    const w = await createTasks(deps(wide)).answerDeeperQuestion({ ...input, sources: [big] });
    expect(w.plan.inputTokens).toBeLessThanOrEqual(DEEP_ASK_INPUT_CAP_TOKENS);
  });

  it('throws DeepContextTooLargeError when even the minimum context does not fit', async () => {
    const fake = new FakeProvider(script());
    await expect(
      createTasks(deps(fake)).answerDeeperQuestion({ ...input, budgetTokens: 3_000 }),
    ).rejects.toBeInstanceOf(DeepContextTooLargeError);
    expect(fake.calls).toHaveLength(0);
  });

  it('is deterministic: the same input renders byte-identical requests', async () => {
    const a = new FakeProvider(script());
    const b = new FakeProvider(script());
    await createTasks(deps(a)).answerDeeperQuestion(input);
    await createTasks(deps(b)).answerDeeperQuestion(input);
    expect(a.calls[0]?.system).toBe(b.calls[0]?.system);
    expect(lastUser(a)).toBe(lastUser(b));
  });
});
