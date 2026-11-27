import { describe, expect, it } from 'vitest';
import { replaceSection, type DocumentModel, type SectionId } from '../../../../../src/main/document';
import { SECTION_BUDGET_SHARE } from '../../../../../src/main/document/interactive/regenerate';
import { estimateTokens } from '../../../../../src/main/llm';
import { fixtureDocument } from '../../../../fixtures/documents/models';
import { req, setup, type Setup } from './harness';

/**
 * Ask on a Deadpan section: the answer may keep the tone, but its facts come only from the
 * material, so the In depth tab always goes along; Ask deep and deeper never send the Deadpan tab.
 */

const model = fixtureDocument('with-deadpan').model;

const firstOf = (m: DocumentModel, key: string): SectionId => {
  const id = m.tabs.find((t) => t.key === key)?.sections.find((s) => s.kind === 'content')?.id;
  if (!id) throw new Error(`fixture has no ${key} section`);
  return id;
};

async function ask(s: Setup, tabKey: string, depth?: 'deep' | 'deeper'): Promise<void> {
  const { jobId } = await s.ir.actions.askSection({
    slug: s.slug,
    tabKey,
    sectionId: firstOf(s.model, tabKey),
    selectionText: 'two days',
    question: 'How long does shipping take?',
    ...(depth ? { depth } : {}),
  });
  await s.ir.runner(s.ctx(jobId).ctx);
  s.jobs.emit(jobId, 'done');
}

const lastArg = (fn: { mock: { calls: unknown[][] } }): Record<string, unknown> => {
  const a = fn.mock.calls.at(-1)?.[0];
  if (!a) throw new Error('not called');
  return a as Record<string, unknown>;
};

describe('Ask on a Deadpan section', () => {
  it('a quick ask carries the In depth sections as factSections', async () => {
    const s = await setup({ model });
    await ask(s, 'deadpan');
    const i = lastArg(s.answerSectionQuestion);
    expect(i.tabKind).toBe('deadpan');
    const facts = i.factSections as { heading: string }[];
    const content = model.tabs[0]?.sections.filter((x) => x.kind === 'content') ?? [];
    expect(facts.map((x) => x.heading)).toEqual(content.map((x) => x.heading));
  });

  it('a quick ask elsewhere carries no extra context', async () => {
    const s = await setup({ model });
    await ask(s, 'indepth');
    expect(lastArg(s.answerSectionQuestion)).not.toHaveProperty('factSections');
    await ask(s, 'ste');
    expect(lastArg(s.answerSectionQuestion)).not.toHaveProperty('factSections');
  });

  it('Ask deep sends In depth through tabs and never the Deadpan tab', async () => {
    const s = await setup({ model });
    await ask(s, 'deadpan', 'deep');
    const i = lastArg(s.answerDeepQuestion);
    expect(i.tabKind).toBe('deadpan');
    const keys = (i.tabs as { key: string }[]).map((t) => t.key);
    expect(keys).toContain('indepth');
    expect(keys).not.toContain('deadpan');
    expect(i).not.toHaveProperty('factSections');
  });

  it('Ask deeper never sends the Deadpan tab either', async () => {
    const s = await setup({ model });
    await ask(s, 'deadpan', 'deeper');
    const keys = (lastArg(s.answerDeeperQuestion).tabs as { key: string }[]).map((t) => t.key);
    expect(keys).toContain('indepth');
    expect(keys).not.toContain('deadpan');
  });

  const contentOf = (m: DocumentModel, kind: string) =>
    m.tabs.find((t) => t.kind === kind)?.sections.filter((x) => x.kind === 'content' && x.origin !== 'placeholder') ??
    [];

  async function act(s: Setup, tabKey: string, action: 'deeper' | 'expand' | 'eli5-tab' = 'deeper'): Promise<void> {
    const { action: _a, ...r } = req(s);
    const target = { ...r, tabKey, sectionId: firstOf(s.model, tabKey) };
    const { jobId } =
      action === 'eli5-tab'
        ? await s.ir.actions.createSectionEli5(target)
        : await s.ir.actions.regenerateSection({ ...target, action });
    await s.ir.runner(s.ctx(jobId).ctx);
    s.jobs.emit(jobId, 'done');
  }

  it('a section action on a Deadpan section carries the In depth section it retells, first', async () => {
    const s = await setup({ model });
    const inDepth = contentOf(model, 'indepth');
    for (const action of ['deeper', 'expand', 'eli5-tab'] as const) {
      await act(s, 'deadpan', action);
      const i = lastArg(s.runSectionAction);
      expect(i.tabKind).toBe('deadpan');
      const facts = i.factSections as { heading: string }[];
      // The first Deadpan section retells the first In depth section; its neighbours go along.
      expect(facts.map((x) => x.heading)).toEqual(inDepth.slice(0, 3).map((x) => x.heading));
    }
    await act(s, 'indepth');
    expect(lastArg(s.runSectionAction)).not.toHaveProperty('factSections');
    await act(s, 'ste');
    expect(lastArg(s.runSectionAction)).not.toHaveProperty('factSections');
  });

  it('the In depth material fits what is left of the section budget', async () => {
    // Every In depth section far larger than the budget: only the counterpart goes, shrunk.
    let big = model;
    const long = 'Shipping takes two days from the main warehouse. '.repeat(300);
    for (const x of contentOf(model, 'indepth')) {
      big = replaceSection(
        big,
        x.id,
        { heading: x.heading, blocks: [{ type: 'paragraph', md: long }] },
        undefined,
        '2026-11-01T10:00:00.000Z',
      ).model;
    }
    const budget = 5000;
    const limit = Math.floor(budget * SECTION_BUDGET_SHARE);
    const s = await setup({ model: big, deps: { inputBudgetTokens: () => budget } });
    await ask(s, 'deadpan');
    const q = lastArg(s.answerSectionQuestion);
    const facts = q.factSections as { heading: string; blocks: { md: string }[] }[];
    expect(facts).toHaveLength(1);
    expect(facts[0]?.heading).toBe(contentOf(big, 'indepth')[0]?.heading);
    expect(estimateTokens(JSON.stringify(facts))).toBeLessThanOrEqual(limit);
    expect(facts[0]?.blocks[0]?.md.length).toBeLessThanOrEqual(1500);

    await act(s, 'deadpan');
    const a = lastArg(s.runSectionAction).factSections as unknown[];
    expect(estimateTokens(JSON.stringify(a))).toBeLessThanOrEqual(limit);

    // No room left at all: no In depth material, and the ask still runs.
    const tiny = await setup({
      model: big,
      deps: {
        inputBudgetTokens: () =>
          Math.ceil(estimateTokens(JSON.stringify(contentOf(big, 'deadpan')[0])) / SECTION_BUDGET_SHARE) + 1,
      },
    });
    await ask(tiny, 'deadpan');
    expect(lastArg(tiny.answerSectionQuestion)).not.toHaveProperty('factSections');
  });
});
