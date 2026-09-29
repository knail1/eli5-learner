/**
 * Golden fixture models: build (and for 'with-tab', add a section ELI5 tab) deterministically.
 * 'merged' is a woven merge (merge.ts); 'showcase' covers the components the others lack (showcase.ts).
 */
import {
  addSectionEli5Tab,
  buildDocumentModel,
  resolveDocTheme,
  type DocTheme,
  type DocumentModel,
} from '../../../src/main/document';
import type { DocumentDraftTab } from '../../../src/main/llm';
import { SeededIdSource } from '../../helpers/ids';
import { THEMED, fixtureInput, type FixtureName } from './drafts';
import { wovenFixture } from './merge';
import { showcaseModel } from './showcase';

export type GoldenName = FixtureName | 'with-tab' | 'merged' | 'showcase';
export const GOLDEN_NAMES: readonly GoldenName[] = ['full', 'placeholder', 'themed', 'with-tab', 'merged', 'showcase'];

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

export function fixtureDocument(name: GoldenName): FixtureDocument {
  // A four-step stepper, stock photos with credits and an "ELI5 this selection" tab (showcase.ts).
  if (name === 'showcase') return showcaseModel();
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
