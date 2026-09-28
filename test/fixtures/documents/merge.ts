/**
 * Woven-merge fixtures (09 §10.3, 07 §8.1): an incoming "returns" document and a fixed
 * `merge-weave` plan that revises and inserts sections in both tabs of the 'full' fixture.
 * Synthetic "Example Widgets Inc." content only.
 */
import {
  applyMergePlan,
  buildDocumentModel,
  prepareMergeWeave,
  renderDocument,
  type DocRuntime,
  type DocumentModel,
  type MergeDocMeta,
} from '../../../src/main/document';
import type { DocumentDraftTab, MergePlanDraft } from '../../../src/main/llm';
import type { ResolvedSource } from '../../../src/main/sources';
import { SeededIdSource } from '../../helpers/ids';
import { RESOLVED, fixtureInput } from './drafts';
import { STUB_RUNTIME } from './runtime';

export const MERGE_TARGET_ID = '11111111-1111-4111-8111-111111111111';
export const MERGE_SOURCE_ID = '22222222-2222-4222-8222-222222222222';
export const MERGED_AT = '2026-09-28T10:00:00.000Z';
export const MERGE_TAB_TS = '2026-09-27T12:00:00.000Z';
export const MERGE_SOURCE_TITLE = 'Widget returns and refunds';

export const SOURCE_INDEPTH_DRAFT: DocumentDraftTab = {
  kind: 'indepth',
  title: MERGE_SOURCE_TITLE,
  dek: 'Returns take a bite out of every channel, most of all affiliates.',
  sections: [
    {
      heading: 'Returns by channel',
      blocks: [
        {
          type: 'paragraph',
          md: 'About 6% of widgets sold online come back. Affiliate sales are returned most often.',
        },
        {
          type: 'table',
          caption: 'Return rate by channel, Q3',
          header: ['Channel', 'Return rate'],
          rows: [
            ['Paid search', '4%'],
            ['Affiliate', '11%'],
          ],
        },
      ],
    },
  ],
};

export const SOURCE_ELI5_DRAFT: DocumentDraftTab = {
  kind: 'eli5',
  title: 'Taking things back, simply',
  sections: [{ heading: 'Sending it back', blocks: [{ type: 'paragraph', md: 'Some people send widgets back.' }] }],
};

const RETURNS_SOURCE: ResolvedSource = {
  ...(RESOLVED[1] as ResolvedSource),
  id: 'src-09',
  ref: 'https://www.example.org/widgets/returns',
  location: 'https://www.example.org/widgets/returns',
  title: 'Example Widgets Inc. returns report',
};

/** The plan a model would return for merging the returns document into the 'full' fixture. */
export const WEAVE_PLAN: MergePlanDraft = {
  indepth: {
    revise: [
      {
        section: 'I1',
        heading: 'Why ad spend is judged by ROAS',
        blocks: [
          {
            type: 'paragraph',
            md: 'Example Widgets Inc. judges every channel by **ROAS**, the revenue earned for each dollar spent, net of refunds since Q3. A channel with a ROAS of 4 returns *four dollars* for every dollar. See [the pricing page](https://www.example.com/widgets/pricing).',
          },
          {
            type: 'list',
            ordered: false,
            items: [
              'Paid search: intent is high, so conversion is strong',
              'Social: cheap reach, weaker **conversion**',
              'Email: tiny cost, `utm` tagged',
              'Affiliate: paid only on sales, but its buyers return the most widgets',
            ],
          },
          { type: 'keep', block: 2 },
          { type: 'keep', block: 3 },
          { type: 'keep', block: 4 },
          {
            type: 'callout',
            tone: 'note',
            md: 'Refunds are netted out from Q3 onward, so earlier quarters look slightly better than they were.',
          },
        ],
      },
    ],
    insert: [
      {
        after: 'I2',
        heading: 'Returns eat into the return',
        blocks: [
          {
            type: 'paragraph',
            md: 'About 6% of widgets sold online come back, and every point of **refund rate** lowers the ROAS a channel really earns.',
          },
          { type: 'incoming', section: 'X1', block: 1 },
        ],
      },
    ],
  },
  eli5: {
    revise: [
      {
        section: 'E1',
        heading: 'Money in, money out',
        blocks: [
          {
            type: 'paragraph',
            md: 'A company pays for ads. Some ads bring back lots of money, and some bring back only a little. When a buyer sends a widget back, the company gives that money back too.',
          },
          { type: 'keep', block: 1 },
        ],
      },
    ],
    insert: [
      {
        after: 'E2',
        heading: 'When things come back',
        blocks: [
          { type: 'paragraph', md: 'If a toy breaks, you might take it back to the shop. Shops count that too.' },
        ],
      },
    ],
  },
  glossary: [
    {
      term: 'Refund rate',
      explanation: 'The share of sales that buyers return for their money back.',
      anchorText: 'refund rate',
    },
    { term: 'ROAS', explanation: 'Already defined, so skipped.', anchorText: 'ROAS' },
  ],
};

export interface MergeFixtureDoc {
  html: string;
  model: DocumentModel;
  meta: MergeDocMeta;
}

function metaOf(model: DocumentModel): MergeDocMeta {
  return {
    id: model.docId,
    title: model.title,
    retiredIds: [],
    tabs: model.tabs.map((t) => ({
      key: t.key,
      kind: t.kind,
      label: t.label,
      sectionCount: t.sections.length,
      createdAt: MERGE_TAB_TS,
    })),
  };
}

/** The 'full' fixture as a merge target (its own doc id and slug). */
export function mergeTarget(runtime: DocRuntime = STUB_RUNTIME, seed = 7): MergeFixtureDoc {
  const { model, assets } = buildDocumentModel({
    ...fixtureInput('full', seed),
    docId: MERGE_TARGET_ID,
    slug: 'widget-ad-spend',
  });
  return { html: renderDocument(model, assets, { runtime }), model, meta: metaOf(model) };
}

/** The incoming returns document. */
export function mergeSource(runtime: DocRuntime = STUB_RUNTIME, seed = 9): MergeFixtureDoc {
  const { model, assets } = buildDocumentModel({
    ...fixtureInput('full', seed),
    docId: MERGE_SOURCE_ID,
    slug: 'widget-returns',
    indepth: SOURCE_INDEPTH_DRAFT,
    eli5: SOURCE_ELI5_DRAFT,
    glossary: null,
    images: [],
    resolved: [RETURNS_SOURCE, RESOLVED[1] as ResolvedSource],
    skipped: [],
  });
  return { html: renderDocument(model, assets, { runtime }), model, meta: metaOf(model) };
}

/** Target + source + WEAVE_PLAN, applied deterministically (the 'merged' golden). */
export function wovenFixture(runtime: DocRuntime = STUB_RUNTIME, plan: MergePlanDraft = WEAVE_PLAN) {
  const target = mergeTarget(runtime);
  const source = mergeSource(runtime);
  const prep = prepareMergeWeave({
    targetHtml: target.html,
    targetMeta: target.meta,
    sourceHtml: source.html,
    sourceMeta: source.meta,
  });
  const applied = applyMergePlan(prep, plan, {
    fromDocId: MERGE_SOURCE_ID,
    fromTitle: MERGE_SOURCE_TITLE,
    mergedAt: MERGED_AT,
    idSource: new SeededIdSource(42),
  });
  return { target, source, prep, ...applied };
}
