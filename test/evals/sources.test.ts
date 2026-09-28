import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { hasGlyph } from './lib/font';
import { EVAL_SOURCES_DIR, buildDocx, buildScannedPdf, buildTextPng, buildXlsx } from './lib/sources';

describe('built eval sources (deterministic, synthetic)', () => {
  it('draws text lines into a PNG sized by width and line count, byte-identical across builds', () => {
    const png = buildTextPng({ scale: 2, width: 20, lines: ['# TITLE', 'ROAS 3.8', 'CAC $95'] });
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = Buffer.from(png);
    expect(view.readUInt32BE(16)).toBe((20 + 4) * 6 * 2); // width: (cols + margins) * cell * scale
    expect(view.readUInt32BE(20)).toBe((3 + 2) * 11 * 2); // height: (lines + margin) * line height * scale
    expect(Buffer.from(buildTextPng({ scale: 2, width: 20, lines: ['# TITLE', 'ROAS 3.8', 'CAC $95'] }))).toEqual(view);
  });

  it('builds an image-only PDF, one page image per page, byte-identical across builds', () => {
    const spec = { pages: [{ lines: ['# PAGE ONE', 'TEXT'] }, { lines: ['PAGE TWO'] }] };
    const pdf = Buffer.from(buildScannedPdf(spec));
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(pdf.toString('latin1').match(/\/Type \/Page /g)).toHaveLength(2);
    expect(pdf.toString('latin1').match(/\/Subtype \/Image/g)).toHaveLength(2);
    expect(pdf.toString('latin1')).not.toMatch(/\/Font|BT /); // no text layer: a scan
    expect(Buffer.from(buildScannedPdf(spec))).toEqual(pdf);
  });

  it('has glyphs for every character the eval screenshots use', () => {
    for (const ch of "SOC DASHBOARD - LAST 24 HOURS: 1,240 62% (TARGET 15 MIN) 'IMPOSSIBLE TRAVEL'.")
      expect(hasGlyph(ch), ch).toBe(true);
  });

  it('has glyphs for every character in the committed screenshot and scan specs', () => {
    const specs = readdirSync(EVAL_SOURCES_DIR, { recursive: true, encoding: 'utf8' }).filter((f) =>
      /\.(png|pdf)\.json$/.test(f),
    );
    expect(specs.length).toBeGreaterThanOrEqual(2);
    for (const f of specs) {
      const spec = JSON.parse(readFileSync(path.join(EVAL_SOURCES_DIR, f), 'utf8')) as {
        lines?: string[];
        pages?: { lines: string[] }[];
      };
      const lines = [...(spec.lines ?? []), ...(spec.pages ?? []).flatMap((p) => p.lines)];
      for (const ch of lines.join('').replace(/^# /gm, '')) expect(hasGlyph(ch), `${f}: ${ch}`).toBe(true);
    }
  });

  it('writes a docx with headings, bullets and tables, and an xlsx with the given sheets', async () => {
    const docx = await buildDocx({
      title: 'T',
      blocks: [
        { h1: 'Head' },
        { p: 'Para & more' },
        { li: 'Item' },
        {
          table: [
            ['a', 'b'],
            ['1', '2'],
          ],
        },
      ],
    });
    const doc = await (await JSZip.loadAsync(docx)).file('word/document.xml')?.async('string');
    expect(doc).toContain('<w:pStyle w:val="Heading1"/>');
    expect(doc).toContain('Para &amp; more');
    expect(doc).toContain('<w:numId w:val="1"/>');
    expect(doc).toContain('<w:tbl>');
    const xlsx = await JSZip.loadAsync(await buildXlsx({ sheets: [{ name: 'S', rows: [['h'], [1]] }] }));
    expect(Object.keys(xlsx.files)).toContain('xl/worksheets/sheet1.xml');
  });
});
