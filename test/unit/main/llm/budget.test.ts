import { describe, expect, it } from 'vitest';
import type { ExtractedContent } from '../../../../src/main/extract';
import {
  contentToPromptText,
  contentUnits,
  estimateTokens,
  imageTokens,
  inputBudget,
  planChunks,
  renderChunk,
  reservedOutput,
  splitSentences,
  visibleOutput,
} from '../../../../src/main/llm/budget';
import {
  prepareImages,
  SKIP_IMAGE_TOO_LARGE,
  SKIP_NO_VISION,
  type ImageReencoder,
} from '../../../../src/main/llm/images';
import { fallbackLimits, limitsFor, suggestedModels } from '../../../../src/main/llm/models';
import type { ImageInput } from '../../../../src/main/llm/types';

const asset = (
  id: string,
  over: Partial<ExtractedContent['images'][number]> = {},
): ExtractedContent['images'][number] => ({
  id,
  mediaType: 'image/png',
  data: new Uint8Array(10),
  width: 1000,
  height: 500,
  byteLength: 10,
  origin: 'page-render',
  ...over,
});

const doc = (
  ref: string,
  blocks: ExtractedContent['blocks'],
  images: ExtractedContent['images'] = [],
  format: ExtractedContent['format'] = 'pdf',
): ExtractedContent => ({
  sourceId: ref,
  sourceRef: ref,
  format,
  blocks,
  images,
  stats: { chars: 0, approxTokens: 0, imagesKept: images.length, imagesDropped: 0, elapsedMs: 0 },
  warnings: [],
  truncated: false,
});

describe('token estimation and budget (02 §8.1, §8.2)', () => {
  it('uses chars/3.5 for Latin and chars/1.5 for CJK-heavy text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(35))).toBe(10);
    expect(estimateTokens('漢'.repeat(15))).toBe(10);
    expect(imageTokens(1568, 1568)).toBe(1600);
    expect(imageTokens(750, 10)).toBe(10);
    expect(imageTokens(3136, 100)).toBe(Math.ceil((1568 * 50) / 750));
  });

  it('reserves output (thinking included) and the framing allowance', () => {
    const l = limitsFor('claude', 'claude-opus-5-5');
    expect(reservedOutput(l, 32_000)).toBe(32_000);
    expect(visibleOutput(l, 32_000)).toBe(32_000 - l.thinkingReserveTokens);
    expect(inputBudget(l, 5_000, 32_000)).toBe(800_000 - 5_000 - 32_000 - 2_000);
    expect(reservedOutput(fallbackLimits('openai'), 32_000)).toBe(8_000);
  });

  it('model table: defaults, suggestions and conservative unknown rows', () => {
    expect(suggestedModels('claude').default).toBe('claude-opus-5');
    expect(suggestedModels('openai').suggested).toContain('gpt-5');
    expect(suggestedModels('bedrock').suggested).toEqual([]);
    expect(limitsFor('claude', 'nope')).toMatchObject({
      contextTokens: 200_000,
      maxOutputTokens: 8_000,
      supportsTemperature: false,
    });
    expect(limitsFor('bedrock', 'x')).toEqual(fallbackLimits('bedrock', 'x'));
  });
});

describe('serialization and chunk planning (02 §8.4)', () => {
  const blocks: ExtractedContent['blocks'] = [
    {
      kind: 'slide',
      index: 1,
      title: 'Intro',
      blocks: [{ kind: 'list', ordered: false, items: [{ text: 'a', children: [{ text: 'b' }] }] }],
      notes: { kind: 'notes', text: 'say hi' },
    },
    { kind: 'table', caption: 'T', header: ['x', 'y'], rows: [['1', '2|3']] },
    {
      kind: 'page',
      number: 2,
      blocks: [
        { kind: 'paragraph', text: 'q', style: 'quote' },
        { kind: 'image', imageId: 'i1', origin: 'page-render' },
      ],
    },
    { kind: 'paragraph', text: 'code', style: 'code' },
    { kind: 'notes', text: 'loose notes' },
    { kind: 'image', imageId: 'missing', alt: 'alt text', origin: 'embedded' },
  ];

  it('renders every block kind inside a source delimiter', () => {
    const text = contentToPromptText([doc('deck "v2".pptx', blocks)], (id) => (id === 'i1' ? 'deck p.2' : undefined));
    // One path (02 §9, 04 §11): 04 renders the body and attributes, 02 owns the escaped delimiter.
    expect(text).toContain('<source ref="deck &quot;v2&quot;.pptx" format="pdf" truncated="false">');
    expect(text).toContain('## Slide 1: Intro');
    expect(text).toContain('  - b');
    expect(text).toContain('> Speaker notes: say hi');
    expect(text).toContain('Table: T');
    expect(text).toContain('| 1 | 2\\|3 |');
    expect(text).toContain('--- Page 2 ---');
    expect(text).toContain('[Image: deck p.2]');
    expect(text).toContain('[Image not sent: alt text]');
    expect(text.trimEnd().endsWith('</source>')).toBe(true);
  });

  it('splits long text at sentences with overlap, and hard-cuts giant sentences', () => {
    const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const parts = splitSentences(text, 300, 50);
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) expect(estimateTokens(p)).toBeLessThanOrEqual(300);
    const lastSentence = /Sentence number \d+ is here\.$/.exec(parts[0] ?? '')?.[0] ?? '(none)';
    expect(parts[1]).toContain(lastSentence); // overlap carried forward
    expect(splitSentences('x'.repeat(5000), 200).length).toBeGreaterThan(4);
  });

  it('packs units in order under the target and the per-request image cap', async () => {
    const images = [asset('i1'), asset('i2'), asset('i3')];
    const c = doc(
      'a.pdf',
      [
        ...images.map((i) => ({ kind: 'image' as const, imageId: i.id, origin: 'page-render' as const })),
        { kind: 'paragraph', text: 'word '.repeat(4000) },
      ],
      images,
    );
    const prepared = await prepareImages([c], { ...fallbackLimits('claude'), maxImagesPerRequest: 2 });
    const units = contentUnits([c], prepared.byId, 1500);
    const chunks = planChunks(units, 1500, 2);
    expect(chunks.every((ch) => ch.images.length <= 2)).toBe(true);
    expect(chunks.flatMap((ch) => ch.images.map((i) => i.label))).toEqual([
      'a.pdf image 1',
      'a.pdf image 2',
      'a.pdf image 3',
    ]);
    expect(chunks.length).toBeGreaterThan(2);
    expect(renderChunk(chunks[0] ?? { units: [], tokens: 0, images: [], sourceRefs: [] })).toContain(
      '<source ref="a.pdf">',
    );
  });

  it('splits a unit that holds more images than one request allows instead of dropping any', () => {
    const img = (label: string): ImageInput & { tokens: number } => ({
      mediaType: 'image/png',
      data: Buffer.from([1]),
      label,
      sourceRef: 'deck.pptx',
      tokens: 100,
    });
    const unit = {
      sourceRef: 'deck.pptx',
      text: 'Slide text [Image: s1] [Image: s2] [Image: s3]',
      tokens: 310,
      images: [img('s1'), img('s2'), img('s3')],
    };
    const chunks = planChunks([unit], 10_000, 2);
    expect(chunks.every((ch) => ch.images.length <= 2)).toBe(true);
    expect(chunks.flatMap((ch) => ch.images.map((i) => i.label))).toEqual(['s1', 's2', 's3']);
    expect(chunks.map(renderChunk).join('\n')).toContain('[Image: s3]');
  });
});

describe('image preparation (02 §8.3)', () => {
  it('labels by page/slide, keeps them unique, and skips when the model has no vision', async () => {
    const pdf = doc('r.pdf', [], [asset('a', { pageOrSlide: 4 }), asset('b', { pageOrSlide: 4 })]);
    const deck = doc('d.pptx', [], [asset('c', { pageOrSlide: 3 })], 'pptx');
    const shot = doc('shot.png', [], [asset('s', { origin: 'standalone' })], 'png');
    const r = await prepareImages([pdf, deck, shot], limitsFor('claude', 'claude-opus-5-5'));
    expect(r.ordered.map((i) => i.label)).toEqual(['r.pdf p.4', 'r.pdf p.4 (2)', 'd.pptx slide 3', 'shot.png']);
    const none = await prepareImages([shot], { ...fallbackLimits('claude'), supportsImages: false });
    expect(none.skipped).toEqual([{ ref: 'shot.png', reason: SKIP_NO_VISION, code: 'unsupported-type' }]);
  });

  it('re-encodes oversized images and skips what cannot be sent, with a reason', async () => {
    const big = asset('big', { width: 4000, height: 3000, data: new Uint8Array(20) });
    const limits = { ...fallbackLimits('claude'), maxImageBytes: 15 };
    const reencode: ImageReencoder = (img, o) =>
      Promise.resolve({
        data: new Uint8Array(12),
        mediaType: 'image/jpeg',
        width: o.maxLongEdge,
        height: Math.round((img.height * o.maxLongEdge) / img.width),
      });
    const ok = await prepareImages([doc('p.png', [], [big])], limits, reencode);
    expect(ok.ordered[0]).toMatchObject({ mediaType: 'image/jpeg', width: 1568, height: 1176 });
    const skipped = await prepareImages([doc('p.png', [], [big])], limits);
    // ref is the source ref (04 §8), the image detail goes in the reason.
    expect(skipped.skipped[0]).toEqual({
      ref: 'p.png',
      reason: `${SKIP_IMAGE_TOO_LARGE} (image 1)`,
      code: 'image-too-large',
    });
    expect(skipped.ordered).toEqual([]);
  });
});
