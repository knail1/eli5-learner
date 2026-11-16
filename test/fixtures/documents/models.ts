/**
 * Golden fixture models: build (and for 'with-tab', add a section ELI5 tab) deterministically.
 * 'merged' is a woven merge (merge.ts); 'showcase' covers the components the others lack (showcase.ts);
 * 'asked' is 'with-tab' with two reader answer boxes (08 Ask), one in the ELI5 tab.
 * 'deep-asked' is 'asked' plus three Ask deep boxes (08 §6.9), one per source mode, and three Ask
 * deeper boxes (08 §6.10), one per reach.
 * 'with-ste' adds the optional ASD-STE100 tab before a section ELI5 tab (showcase.ts steModel).
 */
import {
  addSectionEli5Tab,
  buildDocumentModel,
  insertAnswer,
  resolveDocTheme,
  type DocTheme,
  type DocumentModel,
} from '../../../src/main/document';
import type { DocumentDraftTab } from '../../../src/main/llm';
import { SeededIdSource } from '../../helpers/ids';
import { THEMED, fixtureInput, type FixtureName } from './drafts';
import { wovenFixture } from './merge';
import { showcaseModel, steModel } from './showcase';

export type GoldenName = FixtureName | 'with-tab' | 'merged' | 'showcase' | 'asked' | 'with-ste' | 'deep-asked';
export const GOLDEN_NAMES: readonly GoldenName[] = [
  'full',
  'placeholder',
  'themed',
  'with-tab',
  'merged',
  'showcase',
  'asked',
  'with-ste',
  'deep-asked',
];

export const SECTION_ELI5_DRAFT: DocumentDraftTab = {
  kind: 'section-eli5',
  title: 'ROAS, simply',
  sections: [
    {
      heading: 'What ROAS means',
      blocks: [{ type: 'paragraph', md: 'For every coin you spend on ads, ROAS tells you how many coins come back.' }],
    },
  ],
};

export interface FixtureDocument {
  model: DocumentModel;
  assets: Map<string, Uint8Array>;
  theme: DocTheme;
  warnings: string[];
}

/** 'asked': two answer boxes on top of 'with-tab' (in depth after the first block, ELI5 at the end). */
function askedDocument(): FixtureDocument {
  const base = fixtureDocument('with-tab');
  const indepth = base.model.tabs.find((t) => t.kind === 'indepth')?.sections[0];
  const eli5 = base.model.tabs.find((t) => t.kind === 'eli5')?.sections[0];
  if (!indepth || !eli5) throw new Error('fixture has no in-depth or ELI5 section');
  const idSource = new SeededIdSource(123);
  const first = insertAnswer(
    base.model,
    indepth.id,
    0,
    {
      // Markdown and markup in a question are shown as typed (07 §7.1).
      question: 'Is a ROAS of **4** good, and does <b>revenue</b> mean profit here?',
      topic: 'What a good ROAS is',
      quote: 'A channel with a ROAS of 4 returns four dollars for every dollar.',
      paragraphs: [
        'A ROAS of 4 is **healthy** for most channels: each dollar of spend brings back four in revenue.',
        'Revenue is not profit. The document does not give margins, so it cannot say how much of that is *kept*.',
      ],
    },
    '2026-09-27T14:00:00.000Z',
    { idSource },
  );
  const second = insertAnswer(
    first.model,
    eli5.id,
    undefined,
    {
      question: 'Why do some ads bring back more money?',
      topic: 'Why some ads earn more',
      quote: 'Some ads bring back lots of money, and some bring back only a little.',
      paragraphs: ['Some ads reach people who already want to buy, like someone searching for a widget.'],
    },
    '2026-09-27T14:05:00.000Z',
    { idSource },
  );
  return { ...base, model: second.model };
}

/**
 * 'deep-asked': 'asked' plus three Ask deep boxes (08 §6.9) in the in-depth tab, one per source
 * mode (all / excerpts / none), and three Ask deeper boxes (08 §6.10), one per reach (material /
 * web with a page list / general), so every badge text and both box styles have a golden.
 */
function deepAskedDocument(): FixtureDocument {
  const base = askedDocument();
  const sections = base.model.tabs.find((t) => t.kind === 'indepth')?.sections ?? [];
  const targets = sections.filter((s) => s.kind !== 'references').slice(0, 3);
  if (targets.length < 3) throw new Error('fixture has fewer than three in-depth sections');
  const idSource = new SeededIdSource(456);
  const answers = [
    {
      sources: 'all' as const,
      question: 'Does the report say which channel had the best ROAS?',
      topic: 'Best channel by ROAS',
      paragraphs: [
        'Yes: search had the **highest** ROAS in the source, at 4.0. The explanation rounds it, but the report gives the exact figure.',
        // A link in a deep answer is stored as its text (decision 10 of the plan; 08 §6.9).
        'See [the channel table](https://example.com/table) for the other channels.',
      ],
    },
    {
      sources: 'excerpts' as const,
      question: 'How was revenue counted?',
      topic: 'How revenue was counted',
      paragraphs: ['The excerpts given count revenue at the time of the order, before returns.'],
    },
    {
      sources: 'none' as const,
      question: 'Why does spend matter for ROAS?',
      topic: 'Why spend matters',
      paragraphs: ['ROAS divides revenue by spend, so the same revenue on less spend gives a higher ROAS.'],
    },
  ];
  let model = base.model;
  answers.forEach((a, i) => {
    const section = targets[i];
    if (!section) return;
    model = insertAnswer(
      model,
      section.id,
      undefined,
      {
        question: a.question,
        topic: a.topic,
        quote: 'ROAS is revenue divided by ad spend.',
        paragraphs: a.paragraphs,
        depth: 'deep',
        sources: a.sources,
      },
      `2026-09-27T15:0${String(i)}:00.000Z`,
      { idSource },
    ).model;
  });
  // Three Ask deeper boxes (08 §6.10), one per reach, after the deep box of the same section.
  const deeper = [
    {
      reach: 'material' as const,
      question: 'Is ROAS the same as profit?',
      topic: 'ROAS versus profit',
      paragraphs: ['No: the report treats ROAS as revenue per dollar of ad spend; it does not count other costs.'],
      web: [],
    },
    {
      reach: 'web' as const,
      question: 'What ROAS do retailers usually aim for?',
      topic: 'Typical ROAS targets',
      paragraphs: [
        'The report gives no target.',
        'From the web, a marketing guide on Example.org says many retailers aim for a ROAS of about 4, though it varies by margin.',
      ],
      web: [
        { title: 'What is a good ROAS? <A guide> & more', url: 'https://example.org/guides/roas?ref=search#targets' },
        { title: 'Advertising basics', url: 'https://www.example.net/ads/' },
      ],
    },
    {
      reach: 'general' as const,
      question: 'Who coined the term ROAS?',
      topic: 'Origin of the term ROAS',
      paragraphs: ['In general, ROAS is an industry term with no single known author; the report does not discuss it.'],
      web: [],
    },
  ];
  deeper.forEach((a, i) => {
    const section = targets[i];
    if (!section) return;
    model = insertAnswer(
      model,
      section.id,
      undefined,
      {
        question: a.question,
        topic: a.topic,
        quote: 'ROAS is revenue divided by ad spend.',
        paragraphs: a.paragraphs,
        depth: 'deeper',
        sources: 'all',
        reach: a.reach,
        web: a.web,
      },
      `2026-09-27T15:1${String(i)}:00.000Z`,
      { idSource },
    ).model;
  });
  return { ...base, model };
}

export function fixtureDocument(name: GoldenName): FixtureDocument {
  if (name === 'asked') return askedDocument();
  if (name === 'deep-asked') return deepAskedDocument();
  // A four-step stepper, stock photos with credits and an "ELI5 this selection" tab (showcase.ts).
  if (name === 'showcase') return showcaseModel();
  if (name === 'with-ste') return steModel();
  if (name === 'merged') {
    // 09 §10.3: the 'full' fixture with a second document woven in (marks, legend, merged sources).
    const w = wovenFixture();
    return { model: w.model, assets: w.assets, theme: fixtureInput('full').theme, warnings: w.warnings };
  }
  const base = name === 'with-tab' ? 'full' : name;
  const input = fixtureInput(base);
  const theme = base === 'themed' ? resolveDocTheme({ overlay: THEMED }).theme : input.theme;
  const { model, assets, warnings } = buildDocumentModel({ ...input, theme });
  if (name !== 'with-tab') return { model, assets, theme, warnings };
  const from = model.tabs[0]?.sections[0]?.id;
  if (!from) throw new Error('fixture has no in-depth section');
  const added = addSectionEli5Tab(
    model,
    from,
    'ROAS, the revenue earned for each dollar spent',
    SECTION_ELI5_DRAFT,
    '2026-09-27T13:00:00.000Z',
    {
      idSource: new SeededIdSource(99),
    },
  );
  return { model: added.model, assets, theme, warnings: [...warnings, ...added.warnings] };
}
