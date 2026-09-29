/**
 * The 'showcase' golden (13 §7, visual regression): the components the other goldens lack. A
 * four-step stepper, open-licensed stock photos with their credits in both tabs (07 §7.4, so the
 * references end with "Image credits"), and an "ELI5 this selection" tab that quotes the selection
 * (08 §7.5). Synthetic "Example Widgets Inc." content only; the photos are generated in memory.
 */
import {
  addSectionEli5Tab,
  buildDocumentModel,
  photoSlotKey,
  type AssetCredit,
  type StockPhotoInput,
} from '../../../src/main/document';
import type { DocumentDraftTab } from '../../../src/main/llm';
import { SeededIdSource } from '../../helpers/ids';
import { fixtureInput, makePng } from './drafts';

export const SHOWCASE_SELECTION = 'The warehouse picks, packs and ships every order within two days.';
export const SHOWCASE_TAB_AT = '2026-09-27T14:00:00.000Z';

export const SHOWCASE_INDEPTH: DocumentDraftTab = {
  kind: 'indepth',
  title: 'How Example Widgets Inc. gets a widget to the door',
  dek: 'Four steps, two days, and one warehouse that sets the pace for every channel.',
  sections: [
    {
      heading: 'From click to doorstep',
      blocks: [
        {
          type: 'paragraph',
          md: 'Every order takes the same path. The warehouse picks, packs and ships every order within two days.',
        },
        {
          type: 'stepper',
          title: 'Four steps from click to doorstep',
          steps: [
            { label: 'Click', md: 'A shopper clicks a search ad and lands on the widget page.' },
            { label: 'Buy', md: 'They pay; the order reaches the warehouse within a minute.' },
            { label: 'Pack', md: 'A picker finds the widget and packs it with **recycled** filler.' },
            { label: 'Ship', md: 'A courier collects the parcel the same afternoon.' },
          ],
        },
        { type: 'photo', query: 'warehouse shelves', purpose: 'the warehouse', alt: 'Tall warehouse shelves' },
      ],
    },
    {
      heading: 'Where the days go',
      blocks: [
        {
          type: 'paragraph',
          md: 'Packing is the slowest step. Shipping depends on the courier, not on the warehouse.',
        },
        {
          type: 'chart',
          chart: {
            kind: 'bar',
            title: 'Packing takes the longest',
            subtitle: 'Hours per step, Q3 median',
            categories: ['Click to buy', 'Buy to pack', 'Pack', 'Ship'],
            series: [{ name: 'Hours', values: [0.2, 3, 9, 30] }],
          },
        },
      ],
    },
  ],
};

export const SHOWCASE_ELI5: DocumentDraftTab = {
  kind: 'eli5',
  title: 'Getting a widget to you, simply',
  sections: [
    {
      heading: 'A big room full of shelves',
      blocks: [
        { type: 'paragraph', md: 'The widgets wait on tall shelves until someone buys one.' },
        {
          type: 'photo',
          query: 'cardboard boxes',
          purpose: 'parcels',
          alt: 'Cardboard boxes stacked on a cart',
          caption: 'Boxes ready to go out.',
        },
      ],
    },
  ],
};

export const SHOWCASE_SECTION_ELI5: DocumentDraftTab = {
  kind: 'section-eli5',
  title: 'Two-day shipping',
  sections: [
    {
      heading: 'Why two days',
      blocks: [{ type: 'paragraph', md: 'A helper finds your widget, puts it in a box and gives it to a driver.' }],
    },
  ],
};

const credit = (title: string, over: Partial<AssetCredit> = {}): AssetCredit => ({
  kind: 'stock-photo',
  title,
  creator: 'A. Photographer',
  license: 'by',
  licenseVersion: '2.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/2.0/',
  sourceUrl: 'https://photos.example.com/p/1',
  sourceName: 'Example Photos',
  via: 'Openverse',
  ...over,
});

export const SHOWCASE_PHOTOS: StockPhotoInput[] = [
  {
    slot: photoSlotKey('indepth', 0, 2),
    mime: 'image/png',
    bytes: makePng(120, 72),
    width: 120,
    height: 72,
    alt: 'Tall warehouse shelves',
    caption: 'Shelves in a distribution warehouse.',
    credit: credit('Warehouse aisle'),
  },
  {
    slot: photoSlotKey('eli5', 0, 1),
    mime: 'image/png',
    bytes: makePng(96, 64),
    width: 96,
    height: 64,
    alt: 'Cardboard boxes stacked on a cart',
    caption: 'Boxes ready to go out.',
    credit: credit('Parcels on a cart', {
      creator: 'B. Example',
      license: 'cc0',
      licenseVersion: '1.0',
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      sourceUrl: 'https://commons.example.org/wiki/File:Parcels.png',
      sourceName: 'Example Commons',
    }),
  },
];

/** The showcase model: built from the 'full' sources, then one "ELI5 this selection" tab. */
export function showcaseModel() {
  const input = fixtureInput('full', 11);
  const built = buildDocumentModel({
    ...input,
    indepth: SHOWCASE_INDEPTH,
    eli5: SHOWCASE_ELI5,
    glossary: null,
    photos: SHOWCASE_PHOTOS,
  });
  const from = built.model.tabs[0]?.sections[0]?.id;
  if (!from) throw new Error('showcase has no in-depth section');
  const added = addSectionEli5Tab(built.model, from, SHOWCASE_SELECTION, SHOWCASE_SECTION_ELI5, SHOWCASE_TAB_AT, {
    idSource: new SeededIdSource(123),
    selectionOf: [from],
  });
  return {
    model: added.model,
    assets: built.assets,
    theme: input.theme,
    warnings: [...built.warnings, ...added.warnings],
  };
}
