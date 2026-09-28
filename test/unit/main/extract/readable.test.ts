/**
 * Local .html files go through Readability before htmlToBlocks (04 §4 dispatch row "html"). The
 * helper runs inside the extract worker, so its import graph must stay free of Electron and of the
 * security module (04 §10.4).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createPublicExtractors, extractSource } from '../../../../src/main/extract';
import { readableHtml } from '../../../../src/main/extract/readable';
import { fixtureSource, testContext } from '../../../contracts/extractor.contract';

const para = (n: number): string =>
  `<p>Paragraph ${n} explains how the sensor network reports faults, why each report matters, and what ` +
  `an operator should check before escalating the case to the field team.</p>`;

const PAGE = `<!doctype html><html lang="en"><head><title>Sensor faults explained</title></head><body>
<header><div class="site-menu"><a href="/">Home</a> <a href="/shop">Shop the catalogue</a></div></header>
<aside class="related"><h3>Related reading</h3><ul><li><a href="/a">Ten gadgets we loved this spring</a></li>
<li><a href="/b">Subscribe to our weekly digest</a></li></ul></aside>
<main><article><h1>How sensor faults are reported</h1>${[1, 2, 3, 4, 5, 6].map(para).join('')}
<h2>Checklist</h2><ol><li>Check the bracket</li><li>Run the self-test</li></ol></article></main>
<footer><p>Copyright notice and cookie preferences for the example site.</p></footer>
</body></html>`;

const dir = mkdtempSync(join(tmpdir(), 'eli5-readable-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function localHtml(name: string, html: string): ReturnType<typeof fixtureSource> {
  const path = join(dir, name);
  writeFileSync(path, html);
  return fixtureSource('sources/text/article.html', {
    ref: name,
    location: path,
    payload: { kind: 'path', path },
  });
}

describe('readableHtml (04 §4, via 05 §5 rules)', () => {
  it('keeps the article and drops page chrome', async () => {
    const out = await readableHtml(PAGE, undefined, new AbortController().signal);
    expect(out).toContain('Paragraph 6 explains');
    expect(out).toContain('Run the self-test');
    expect(out).not.toMatch(/Ten gadgets|weekly digest|cookie preferences|Shop the catalogue/);
  });

  it("keeps the page's own h1 at level 1 (Readability demotes it to h2)", async () => {
    const r = await extractSource(localHtml('levels.html', PAGE), testContext(), createPublicExtractors());
    if (!r.ok) throw new Error(r.skipped.code);
    expect(r.content.blocks).toContainEqual({ kind: 'heading', level: 1, text: 'How sensor faults are reported' });
    expect(r.content.blocks).toContainEqual({ kind: 'heading', level: 2, text: 'Checklist' });
  });

  it('returns the page unchanged when Readability finds no substantial article', async () => {
    const tiny = '<html><body><p>Just one short note.</p></body></html>';
    expect(await readableHtml(tiny, undefined, new AbortController().signal)).toBe(tiny);
  });

  it('never runs scripts in the page', async () => {
    const html = PAGE.replace('</body>', '<script>globalThis.__eli5Ran = true;</script></body>');
    await readableHtml(html, undefined, new AbortController().signal);
    expect((globalThis as { __eli5Ran?: boolean }).__eli5Ran).toBeUndefined();
  });

  it('rejects when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(readableHtml(PAGE, undefined, ac.signal)).rejects.toThrow();
  });
});

describe('html extractor on a local file', () => {
  it('uses Readability by default (the public registry, as the worker builds it)', async () => {
    const r = await extractSource(localHtml('page.html', PAGE), testContext(), createPublicExtractors());
    if (!r.ok) throw new Error(r.skipped.code);
    const text = JSON.stringify(r.content.blocks);
    expect(text).toContain('Paragraph 1 explains');
    expect(text).not.toMatch(/Ten gadgets|weekly digest|cookie preferences/);
    expect(r.content.title).toBe('Sensor faults explained');
  });

  it('does not run Readability on html payloads (already readable, from 03/05)', async () => {
    const src = fixtureSource('sources/text/article.html', {
      payload: { kind: 'html', html: '<aside><p>Kept aside text</p></aside><p>Body</p>' },
    });
    const r = await extractSource(src, testContext(), createPublicExtractors());
    expect(r.ok && JSON.stringify(r.content.blocks)).toContain('Kept aside text');
  });
});

describe('worker safety (04 §10.4)', () => {
  it('readable.ts imports nothing from Electron, the security module or other main modules', () => {
    const root = resolve(__dirname, '../../../../src/main/extract');
    const seen = new Set<string>();
    const bad: string[] = [];
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
        const spec = m[1]!;
        if (spec === 'electron' || spec.includes('security') || spec.startsWith('../')) bad.push(`${file}: ${spec}`);
        else if (spec.startsWith('./')) visit(resolve(dirname(file), `${spec}.ts`));
      }
    };
    visit(join(root, 'readable.ts'));
    expect(bad).toEqual([]);
  });
});
