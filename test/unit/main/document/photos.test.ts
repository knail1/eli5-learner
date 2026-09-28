import { describe, expect, it } from 'vitest';
import {
  buildDocumentModel,
  checkDocumentHtml,
  parseDocument,
  photoSlotKey,
  renderDocument,
  replaceSection,
  sectionToDraft,
  type AssetCredit,
  type BuildInput,
  type StockPhotoInput,
} from '../../../../src/main/document';
import type { DocumentDraftTab } from '../../../../src/main/llm';
import { ELI5_DRAFT, fixtureInput, makePng } from '../../../fixtures/documents/drafts';
import { STUB_RUNTIME } from '../../../fixtures/documents/runtime';
import { SeededIdSource } from '../../../helpers/ids';

const CREDIT: AssetCredit = {
  kind: 'stock-photo',
  title: 'Courthouse <script>alert(1)</script> steps',
  creator: 'A. Photographer',
  license: 'by',
  licenseVersion: '2.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/2.0/',
  sourceUrl: 'https://photos.example/p/1',
  sourceName: 'Flickr',
  via: 'Openverse',
};

const eli5WithPhotos: DocumentDraftTab = {
  ...ELI5_DRAFT,
  sections: [
    {
      heading: 'Money in, money out',
      blocks: [
        { type: 'paragraph', md: 'A company pays for ads.' },
        { type: 'photo', query: 'shop window', purpose: 'a shop', alt: 'A shop window at night', caption: 'Shops.' },
      ],
    },
    {
      heading: 'Picking the best ads',
      blocks: [
        { type: 'paragraph', md: 'The company keeps the ads that work.' },
        { type: 'photo', query: 'market stall', purpose: 'a stall', alt: 'A market stall' },
      ],
    },
  ],
};

const PHOTO: StockPhotoInput = {
  slot: photoSlotKey('eli5', 0, 1),
  mime: 'image/png',
  bytes: makePng(48, 32),
  width: 48,
  height: 32,
  alt: 'A shop window at night',
  caption: 'Shops.',
  credit: CREDIT,
};

function build(p: Partial<BuildInput> = {}) {
  return buildDocumentModel({ ...fixtureInput('full'), eli5: eli5WithPhotos, photos: [PHOTO], ...p });
}

describe('stock photos in the document (07 §7.4)', () => {
  const built = build();
  const eli5 = built.model.tabs[1]!;
  const html = renderDocument(built.model, built.assets, { runtime: STUB_RUNTIME });

  it('turns a resolved photo slot into a figure backed by a credited asset', () => {
    const fig = eli5.sections[0]?.blocks[1];
    expect(fig).toMatchObject({ type: 'figure', caption: 'Shops.', alt: 'A shop window at night' });
    const asset = built.model.assets.find((a) => fig?.type === 'figure' && a.id === fig.assetId);
    expect(asset?.credit).toEqual(CREDIT);
    expect(asset?.label).toMatch(/^stock-photo-[0-9a-f]{12}$/);
  });

  it('drops an unresolved photo slot quietly', () => {
    expect(eli5.sections[1]?.blocks.map((b) => b.type)).toEqual(['paragraph']);
    expect(built.warnings).toContain('photo-unresolved');
  });

  it('renders a caption credit (escaped) marked as illustrative, with the license linked', () => {
    expect(html).toContain('<figure class="annotated stock-photo">');
    expect(html).toContain('Illustrative stock photo');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('Courthouse &lt;script&gt;alert(1)&lt;/script&gt; steps');
    expect(html).toContain(
      '<a class="fig-license" href="https://creativecommons.org/licenses/by/2.0/" target="_blank" rel="noopener noreferrer">CC BY 2.0</a>',
    );
    expect(html).toContain('A. Photographer');
  });

  it('lists image credits after the sources', () => {
    const refs = html.slice(html.indexOf('data-kind="references"'));
    expect(refs).toContain('<h3 class="ref-group">Image credits</h3>');
    expect(refs).toMatch(/<ul class="refs refs--credits"><li[^>]*>.*CC BY 2\.0/);
  });

  it('passes the validity checks and keeps zero network references', () => {
    const r = checkDocumentHtml(html);
    expect(r.errors).toEqual([]);
    expect(html).toMatch(/<img[^>]+src="data:image\/png;base64,/);
  });

  it('round-trips the credit through parse, and section rewrites keep it', () => {
    const parsed = parseDocument(html);
    expect(parsed.model.assets.find((a) => a.credit)?.credit).toEqual(CREDIT);
    const section = parsed.model.tabs[1]!.sections[0]!;
    const draft = sectionToDraft(parsed.model, section);
    const r = replaceSection(parsed.model, section.id, draft, 'reexplain', '2026-09-28T00:00:00.000Z', {
      assets: parsed.assets,
      idSource: new SeededIdSource(2),
    });
    const html2 = renderDocument(r.model, parsed.assets, { runtime: STUB_RUNTIME });
    expect(html2).toContain('Illustrative stock photo');
    expect(checkDocumentHtml(html2).errors).toEqual([]);
  });

  it('never links non-http license or source URLs', () => {
    const bad = build({
      photos: [{ ...PHOTO, credit: { ...CREDIT, licenseUrl: 'javascript:alert(1)', sourceUrl: 'file:///etc' } }],
    });
    const h = renderDocument(bad.model, bad.assets, { runtime: STUB_RUNTIME });
    expect(h).not.toContain('javascript:');
    expect(h).not.toContain('file:///');
    expect(h).toContain('CC BY 2.0');
  });

  it('names public-domain and CC0 licenses', () => {
    const cc0 = build({ photos: [{ ...PHOTO, credit: { ...CREDIT, license: 'cc0', licenseVersion: '1.0' } }] });
    expect(renderDocument(cc0.model, cc0.assets, { runtime: STUB_RUNTIME })).toContain('CC0 1.0');
    const pdm = build({ photos: [{ ...PHOTO, credit: { ...CREDIT, license: 'pdm', licenseVersion: '1.0' } }] });
    expect(renderDocument(pdm.model, pdm.assets, { runtime: STUB_RUNTIME })).toContain('Public Domain Mark');
  });

  it('flags a stock photo rendered without its credit (validity rule photo-credit)', () => {
    const stripped = html.replace(/<span class="fig-credit">[\s\S]*?<\/span><\/figcaption>/, '</figcaption>');
    expect(stripped).not.toBe(html);
    expect(checkDocumentHtml(stripped).errors.map((e) => e.rule)).toContain('photo-credit');
  });
});
