import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractSource, type ContentBlock, type ExtractedContent } from '../../../../src/main/extract';
import { headingStylesFromStylesXml } from '../../../../src/main/extract/docx';
import { fixtureSource, testContext } from '../../../contracts/extractor.contract';
import { zipFiles } from '../../../fixtures/build/common';

async function doc(rel: string): Promise<ExtractedContent> {
  const r = await extractSource(fixtureSource(rel), testContext());
  if (!r.ok) throw new Error(`skipped: ${r.skipped.code}`);
  return r.content;
}
const headings = (bs: ContentBlock[]): Array<[number, string]> =>
  bs.flatMap((b) => (b.kind === 'heading' ? [[b.level, b.text] as [number, string]] : []));

describe('docx extractor (04 §5.2)', () => {
  it('maps Title and Heading 1..3 to heading levels', async () => {
    const c = await doc('sources/docx/policy-memo.docx');
    expect(headings(c.blocks).slice(0, 5)).toEqual([
      [1, 'Remote Work Policy'],
      [1, 'Purpose'],
      [2, 'Scope'],
      [2, 'Approval steps'],
      [3, 'Equipment'],
    ]);
    expect(c.title).toBe('Remote Work Policy');
  });

  it('maps localized heading styles through the w:outlineLvl pre-scan', async () => {
    const c = await doc('sources/docx/localized-headings.docx');
    expect(headings(c.blocks)).toEqual([
      [1, 'Jahresbericht'],
      [2, 'Résultats'],
      [3, '概要'],
    ]);
    expect(c.blocks.at(-1)).toEqual({ kind: 'paragraph', text: 'Nur ein Hinweis, keine Überschrift.' });
  });

  it('keeps bulleted and numbered list nesting', async () => {
    const lists = (await doc('sources/docx/policy-memo.docx')).blocks.filter((b) => b.kind === 'list');
    expect(lists[0]).toEqual({
      kind: 'list',
      ordered: false,
      items: [
        {
          text: 'Engineering',
          children: [{ text: 'Platform services', children: [{ text: 'On-call rotation excluded' }] }],
        },
        { text: 'Finance' },
      ],
    });
    expect(lists[1]).toMatchObject({
      ordered: true,
      items: [
        { text: 'Submit a request form' },
        { text: 'Manager signs off within five days', children: [{ text: 'Escalations go to the operations lead' }] },
      ],
    });
  });

  it('keeps tables with header detection, captions, and flattened nested tables', async () => {
    const tables = (await doc('sources/docx/policy-memo.docx')).blocks.filter((b) => b.kind === 'table');
    expect(tables[0]).toEqual({
      kind: 'table',
      caption: 'Table 1: Equipment allowance',
      header: ['Item', 'Allowance'],
      rows: [
        ['Laptop', '$1,500'],
        ['Monitor', '$300'],
      ],
    });
    expect(tables[1]).toMatchObject({
      rows: [
        ['Team', 'Office days'],
        ['Support', 'See tiers:; Tier; Days; A; 3'],
      ],
    });
    expect(tables[1]).not.toHaveProperty('header');
  });

  it('keeps footnotes under Notes, text boxes, quotes and the embedded image', async () => {
    const c = await doc('sources/docx/policy-memo.docx');
    const texts = JSON.stringify(c.blocks);
    expect(headings(c.blocks).at(-1)).toEqual([2, 'Notes']);
    expect(texts).toContain('Contractors follow their own agreement.');
    expect(texts).not.toContain('↑');
    expect(texts).toContain('Contact IT for exceptions');
    expect(c.blocks).toContainEqual({
      kind: 'paragraph',
      text: 'Remote work is a privilege, not a right.',
      style: 'quote',
    });
    expect(c.images).toHaveLength(1);
    expect(c.blocks).toContainEqual(
      expect.objectContaining({ kind: 'image', alt: 'Office network diagram', origin: 'embedded' }),
    );
  });

  it('promotes bold pseudo-headings only when no real headings exist', async () => {
    const bold = await doc('sources/docx/bold-headings.docx');
    expect(headings(bold.blocks)).toEqual([
      [2, 'Background'],
      [2, 'Findings'],
      [2, 'Next steps'],
    ]);
    expect(bold.warnings.some((w) => /bold lines treated as headings/.test(w))).toBe(true);
    const memo = await doc('sources/docx/policy-memo.docx');
    expect(memo.warnings.some((w) => /bold lines/.test(w))).toBe(false);
  });

  it('refuses parts with DOCTYPE declarations and lying sizes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eli5-docx-'));
    const bad = join(dir, 'dtd.docx');
    writeFileSync(
      bad,
      await zipFiles([
        ['word/document.xml', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><w:document xmlns:w="w"/>'],
      ]),
    );
    const r = await extractSource(
      fixtureSource('sources/docx/policy-memo.docx', { location: bad, payload: { kind: 'path', path: bad } }),
      testContext(),
    );
    expect(r).toMatchObject({ ok: false, skipped: { code: 'corrupt' } });
    const lying = await extractSource(fixtureSource('sources/hostile/lying-sizes.docx'), testContext());
    expect(lying).toMatchObject({ ok: false, skipped: { code: 'zip-bomb', reason: 'File expands to an unsafe size' } });
  });

  it('collects heading styles by name with basedOn inheritance', () => {
    const map = headingStylesFromStylesXml(
      '<w:styles><w:style w:type="paragraph" w:styleId="A"><w:name w:val="Base"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="B"><w:name w:val="Child"/><w:basedOn w:val="A"/></w:style>' +
        '<w:style w:type="paragraph" w:styleId="C"><w:name w:val="Body"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style>' +
        '<w:style w:type="character" w:styleId="D"><w:name w:val="Char"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>',
    );
    expect([...map]).toEqual([
      ['Base', 1],
      ['Child', 1],
    ]);
  });
});
