/**
 * Golden fixture models: build (and for 'with-tab', add a section ELI5 tab) deterministically.
 * 'merged' is a woven merge (merge.ts); 'showcase' covers the components the others lack (showcase.ts);
 * 'asked' is 'with-tab' with two reader answer boxes (08 Ask), one in the ELI5 tab.
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

export type GoldenName = FixtureName | 'with-tab' | 'merged' | 'showcase' | 'asked' | 'with-ste';
export const GOLDEN_NAMES: readonly GoldenName[] = [
  'full',
  'placeholder',
  'themed',
  'with-tab',
  'merged',
  'showcase',
  'asked',
  'with-ste',
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

export function fixtureDocument(name: GoldenName): FixtureDocument {
  if (name === 'asked') return askedDocument();
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
