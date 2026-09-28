import { describe, expect, it } from 'vitest';
import type { ExtractError } from '../../../../src/main/extract';
import { allText, attr, child, coreTitle, parseRels, parseXml, rootEl } from '../../../../src/main/extract/ooxml-xml';

describe('ooxml-xml (04 §5.1, §10.3)', () => {
  it('decodes predefined entities and character references', () => {
    const doc = parseXml('<a:p xmlns:a="x"><a:r><a:t>R&amp;D &lt;50% &#8212; &quot;ok&quot; &apos;s</a:t></a:r></a:p>');
    expect(allText(rootEl(doc, 'a:p'), 'a:t')).toBe('R&D <50% — "ok" \'s');
  });

  it('keeps whitespace and leading zeros literally', () => {
    const doc = parseXml('<r><t> 007 </t><t>1e3</t></r>');
    expect(allText(rootEl(doc, 'r'), 't')).toBe(' 007 1e3');
  });

  it('refuses DOCTYPE and ENTITY declarations as corrupt', () => {
    for (const xml of ['<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>', '<?xml version="1.0"?><!ENTITY x "y"><r/>']) {
      let code: string | undefined;
      try {
        parseXml(xml);
      } catch (e) {
        code = (e as ExtractError).code;
      }
      expect(code).toBe('corrupt');
    }
  });

  it('parses relationships and core title', () => {
    const rels = parseRels(
      '<Relationships><Relationship Id="rId1" Type="t/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="t/link" Target="https://example.com" TargetMode="External"/></Relationships>',
    );
    expect(rels.get('rId1')).toEqual({ id: 'rId1', type: 't/slide', target: 'slides/slide1.xml', external: false });
    expect(rels.get('rId2')?.external).toBe(true);
    expect(parseRels(undefined).size).toBe(0);
    expect(coreTitle('<cp:coreProperties><dc:title>Plan</dc:title></cp:coreProperties>')).toBe('Plan');
    expect(coreTitle('<cp:coreProperties><dc:title></dc:title></cp:coreProperties>')).toBeUndefined();
    const doc = parseXml('<a x="1"><b/></a>');
    expect(attr(rootEl(doc, 'a'), 'x')).toBe('1');
    expect(child(rootEl(doc, 'a'), 'b')).toBeDefined();
  });
});
