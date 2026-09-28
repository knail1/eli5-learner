import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DocRuntimeMissingError,
  DOC_RUNTIME_CSS,
  DOC_RUNTIME_JS,
  bundledDocRuntime,
  buildDocumentModel,
  documentCsp,
  parseDocument,
  renderDocument,
  type DocumentModel,
} from '../../../../src/main/document';
import { fixtureInput } from '../../../fixtures/documents/drafts';
import { fixtureDocument } from '../../../fixtures/documents/models';
import { STUB_RUNTIME } from '../../../fixtures/documents/runtime';
import { validateDocument } from '../../../helpers/doc-validity';

const doc = fixtureDocument('with-tab');
const html = renderDocument(doc.model, doc.assets, { runtime: STUB_RUNTIME, theme: doc.theme });

describe('renderDocument (07 §6)', () => {
  it('emits the 07 §6.2 CSP with the hash of the inlined runtime', () => {
    const hash = createHash('sha256').update(STUB_RUNTIME.js).digest('base64');
    const expected =
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; " +
      `script-src 'sha256-${hash}'; connect-src 'none'; media-src 'none'; object-src 'none'; ` +
      "frame-src 'none'; form-action 'none'; base-uri 'none'";
    expect(documentCsp(STUB_RUNTIME.js)).toBe(expected);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${expected}">`);
    expect(html).toContain(`<script id="eli5-runtime">${STUB_RUNTIME.js}</script>`);
  });

  it('follows the 07 §6.1 skeleton', () => {
    expect(
      html.startsWith(
        '<!doctype html>\n<html lang="en" data-eli5-format="1" data-theme="auto">\n<head>\n<meta charset="utf-8">',
      ),
    ).toBe(true);
    for (const s of [
      '<meta name="referrer" content="no-referrer">',
      '<meta name="generator" content="ELI5 Learner 1.0.0 (public); runtime 1.0.0">',
      '<style id="eli5-css">',
      '<style id="eli5-theme"></style>',
      '<script type="application/json" id="eli5-model">',
      '<nav class="tabbar" role="tablist" aria-label="Document views">',
      '<footer class="doc-foot">Made with ELI5 Learner</footer>',
      '<p class="doc-meta">Generated 27 Sep 2026 · 3 sources · 2 skipped</p>',
    ]) {
      expect(html).toContain(s);
    }
    expect(html).not.toMatch(/<(link|iframe|object|embed|base|form)\b/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('passes validateDocument with matching meta tabs and sources', () => {
    const report = validateDocument(html, {
      tabs: doc.model.tabs.map((t) => ({ key: t.key })),
      sourcesUsed: [
        { ref: 'widget-sales-q3.pptx', kind: 'file' },
        { ref: 'https://www.example.com/widgets/pricing', kind: 'url' },
        { ref: 'Pasted text: notes', kind: 'clipboard' },
      ],
      sourcesSkipped: [
        { ref: 'https://portal.example.com/login', reason: 'Page required login.' },
        { ref: 'old-forecast.numbers', reason: 'File type is not supported.' },
      ],
    });
    expect(report.errors).toEqual([]);
    expect(report.stats).toMatchObject({ tabs: 3 });
  });

  it('renders tabs in order with In depth selected and close buttons only on section ELI5 tabs', () => {
    const tabs = [
      ...html.matchAll(/<button type="button" role="tab" id="tabbtn-([a-z0-9]+)"[^>]*aria-selected="(true|false)"/g),
    ].map((m) => [m[1], m[2]]);
    expect(tabs[0]).toEqual(['indepth', 'true']);
    expect(tabs[1]).toEqual(['eli5', 'false']);
    expect(tabs[2]?.[0]).toMatch(/^sx[0-9a-f]{6}$/);
    const closes = [...html.matchAll(/data-close-tab="([^"]+)"[^>]*hidden/g)].map((m) => m[1]);
    expect(closes).toEqual([tabs[2]?.[0]]);
    expect(html).toContain('>ELI5: Why ad spend is judged by ROAS</button>');
  });

  it('keeps the theme toggle out of the tablist, which may own only tabs (13 §13 accessibility)', () => {
    const bar = /<nav class="tabbar"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
    expect(bar).toContain('role="tab"');
    expect(bar).not.toContain('theme-toggle');
    const head = /<header class="doc-head">([\s\S]*?)<\/header>/.exec(html)?.[1] ?? '';
    expect(head).toContain('<button type="button" class="theme-toggle" aria-label="Switch theme" hidden></button>');
  });

  it('truncates long section ELI5 labels to 48 characters with the full label in title', () => {
    const m: DocumentModel = structuredClone(doc.model);
    const sx = m.tabs[2];
    if (!sx) throw new Error('fixture');
    sx.label = 'ELI5: A very long heading about how the attribution window changes ROAS';
    const out = renderDocument(m, doc.assets, { runtime: STUB_RUNTIME });
    const btn = new RegExp(`id="tabbtn-${sx.key}"[^>]*title="([^"]+)">([^<]+)</button>`).exec(out);
    expect(btn?.[1]).toBe(sx.label);
    expect(btn?.[2]?.length).toBeLessThanOrEqual(48);
    expect(btn?.[2]?.endsWith('…')).toBe(true);
  });

  it('emits id and data-section-id identically on every section, directly inside its panel', () => {
    const sections = [...html.matchAll(/<section id="([^"]+)" data-section-id="([^"]+)"/g)];
    expect(sections.length).toBe(doc.model.tabs.reduce((n, t) => n + t.sections.length, 0));
    for (const m of sections) expect(m[1]).toBe(m[2]);
    expect(html).toMatch(/data-kind="references" data-origin="generated" data-eli5-actionable="false"/);
  });

  it('keeps glossary notes out of ELI5 tabs and places them after their block', () => {
    const eli5Start = html.indexOf('id="tab-eli5"');
    expect(html.indexOf('class="gl-note"', eli5Start)).toBe(-1);
    expect(html).toMatch(
      /<\/p><details class="gl-note" id="g-[0-9a-f]{6}" data-note-for="g-[0-9a-f]{6}-ref"><summary><span class="gl-icon" aria-hidden="true"><\/span><b>ROAS<\/b> · return on ad spend<\/summary>/,
    );
  });

  it('escapes model text and keeps the embedded JSON inert (07 §6.1)', () => {
    const m: DocumentModel = structuredClone(doc.model);
    m.title = 'Evil </script><script>alert(1)</script> \u2028 title';
    const out = renderDocument(m, doc.assets, { runtime: STUB_RUNTIME });
    expect(out).toContain('<title>Evil &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; \u2028 title</title>');
    const json = /<script type="application\/json" id="eli5-model">([^]*?)<\/script>/.exec(out)?.[1] ?? '';
    expect(json).not.toMatch(/[<\u2028\u2029]/);
    expect(parseDocument(out).model.title).toBe(m.title);
  });

  it('inlines runtime text safely even if it contains </script', () => {
    const out = renderDocument(doc.model, doc.assets, { runtime: { js: 'var s="</script>";', css: 'a{}' } });
    expect(out).toContain('<script id="eli5-runtime">var s="\\x3c/script>";</script>');
    expect(validateDocument(out).errors).toEqual([]);
  });

  it('writes theme overrides, footer and logo (HOOK-DOC-01)', () => {
    const themed = fixtureDocument('themed');
    const out = renderDocument(themed.model, themed.assets, { runtime: STUB_RUNTIME, theme: themed.theme });
    expect(out).toContain(
      '<style id="eli5-theme">:root:root:root{--accent:#8a1c7c;--font-serif:"Iowan Old Style", Georgia, serif}</style>',
    );
    expect(out).toContain('<footer class="doc-foot">Made with ELI5 Learner · Example footer label</footer>');
    expect(out).toMatch(/<p class="kicker"><span class="doc-logo"><svg [^>]*role="img" aria-label="Logo"/);
    expect(themed.model.theme).toEqual({ id: 'example-theme', version: '2', source: 'overlay' });
  });

  it('is deterministic: no clock reads, same bytes every time', () => {
    const again = buildDocumentModel({ ...fixtureInput('full') });
    const a = renderDocument(again.model, again.assets, { runtime: STUB_RUNTIME });
    const b = renderDocument(again.model, again.assets, { runtime: STUB_RUNTIME });
    expect(a).toBe(b);
  });

  it('requires a built runtime when none is injected', () => {
    // Vitest serves .css?raw as an empty module, so the bundled CSS may be empty here.
    if (DOC_RUNTIME_JS === '' || DOC_RUNTIME_CSS === '') {
      expect(() => bundledDocRuntime()).toThrow(DocRuntimeMissingError);
      expect(() => renderDocument(doc.model, doc.assets)).toThrow(DocRuntimeMissingError);
    } else {
      expect(renderDocument(doc.model, doc.assets)).toContain('<script id="eli5-runtime">');
    }
  });
});
