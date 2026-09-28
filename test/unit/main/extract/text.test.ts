import { describe, expect, it } from 'vitest';
import { extractSource, type ExtractedContent } from '../../../../src/main/extract';
import { markdownToBlocks, splitFrontMatter } from '../../../../src/main/extract/markdown';
import { decodeText } from '../../../../src/main/extract/payload';
import { textToBlocks } from '../../../../src/main/extract/text';
import { fixtureSource, testContext, textSource } from '../../../contracts/extractor.contract';

async function run(src: ReturnType<typeof fixtureSource>): Promise<ExtractedContent> {
  const r = await extractSource(src, testContext());
  if (!r.ok) throw new Error(`skipped: ${r.skipped.code}`);
  return r.content;
}

describe('text decoding (04 §9.2)', () => {
  it('follows BOMs for UTF-8 and UTF-16 LE/BE', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe('hi');
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0, 0xe9, 0]))).toBe('hé');
    expect(decodeText(new Uint8Array([0xfe, 0xff, 0, 0x68, 0, 0xe9]))).toBe('hé');
  });

  it('falls back to windows-1252 when UTF-8 is mostly invalid', () => {
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80]))).toBe('café €');
    expect(decodeText(new TextEncoder().encode('naïve'))).toBe('naïve');
  });

  it('decodes the committed UTF-16 and windows-1252 fixtures', async () => {
    const utf16 = await run(fixtureSource('sources/text/bom-utf16.txt'));
    expect(utf16.blocks[0]).toEqual({ kind: 'paragraph', text: 'Café menu review' });
    const cp = await run(fixtureSource('sources/text/cp1252.txt'));
    expect(cp.blocks[0]).toEqual({ kind: 'paragraph', text: 'Résumé of the naïve café plan — €1,200 budget' });
    expect(cp.blocks[1]).toEqual({ kind: 'paragraph', text: '“Smart quotes” survive the round trip.' });
  });
});

describe('plain text (04 §9.2)', () => {
  it('splits paragraphs on blank lines and turns bullet runs into lists', () => {
    expect(textToBlocks('One\r\ntwo\r\n\r\n- a\n  - b\n- c\nafter')).toEqual([
      { kind: 'paragraph', text: 'One two' },
      { kind: 'list', ordered: false, items: [{ text: 'a', children: [{ text: 'b' }] }, { text: 'c' }] },
      { kind: 'paragraph', text: 'after' },
    ]);
    expect(textToBlocks('1. first\n2. second')).toEqual([
      { kind: 'list', ordered: true, items: [{ text: 'first' }, { text: 'second' }] },
    ]);
  });

  it('wraps structured files whole as code chunks of 4,000 characters', async () => {
    const json = `{"a": "${'x'.repeat(5000)}"}`;
    const blocks = textToBlocks(json, { asCode: true });
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.kind === 'paragraph' && b.style === 'code')).toBe(true);
    const src = fixtureSource('sources/text/plain.txt', { location: '/data/config.json' });
    const c = await run(src);
    expect(c.blocks[0]).toMatchObject({ kind: 'paragraph', style: 'code' });
  });

  it('uses text payloads directly and removes control characters', async () => {
    const c = await run(textSource('Pasted\u0007 line with   spaces'));
    expect(c.blocks).toEqual([{ kind: 'paragraph', text: 'Pasted line with spaces' }]);
  });

  it('skips whitespace-only text as empty', async () => {
    const r = await extractSource(textSource(' \n\t\n'), testContext());
    expect(r).toMatchObject({ ok: false, skipped: { code: 'empty' } });
  });
});

describe('markdown (04 §9.1)', () => {
  it('maps headings, lists, tables, quotes, code and image references', async () => {
    const c = await run(fixtureSource('sources/text/notes.md'));
    expect(c.title).toBe('Warehouse Automation Notes');
    expect(c.blocks[0]).toEqual({ kind: 'heading', level: 1, text: 'Warehouse automation' });
    expect(c.blocks[1]).toMatchObject({ kind: 'paragraph', text: expect.stringContaining('**pilot review**') });
    expect(c.blocks).toContainEqual({
      kind: 'list',
      ordered: false,
      items: [
        {
          text: 'Pick rate rose 9%',
          children: [
            { text: 'Night shift saw the biggest gain', children: [{ text: 'Fewer walking miles per order' }] },
          ],
        },
        { text: 'Error rate fell to 0.4%' },
      ],
    });
    expect(c.blocks).toContainEqual({
      kind: 'paragraph',
      text: 'Automation should help people, not replace them.',
      style: 'quote',
    });
    expect(c.blocks).toContainEqual({ kind: 'paragraph', text: 'pilot:\n  sites: 2', style: 'code' });
    expect(c.blocks).toContainEqual({ kind: 'paragraph', text: '[image: Floor layout sketch]' });
    expect(c.blocks).toContainEqual(expect.objectContaining({ kind: 'table', header: ['Metric', 'Before', 'After'] }));
  });

  it('strips front matter and html tags', () => {
    expect(splitFrontMatter('---\ntitle: "Hi"\n---\nBody')).toEqual({ body: 'Body', title: 'Hi' });
    expect(splitFrontMatter('No front matter')).toEqual({ body: 'No front matter' });
    expect(markdownToBlocks('<div>Hello <b>there</b></div>').blocks).toEqual([
      { kind: 'paragraph', text: 'Hello there' },
    ]);
  });
});
