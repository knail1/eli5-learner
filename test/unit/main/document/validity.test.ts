import { describe, expect, it } from 'vitest';
import { renderDocument } from '../../../../src/main/document';
import { fixtureDocument } from '../../../fixtures/documents/models';
import { STUB_RUNTIME } from '../../../fixtures/documents/runtime';
import { validateDocument, type ValidityRule } from '../../../helpers/doc-validity';

const doc = fixtureDocument('with-tab');
const good = renderDocument(doc.model, doc.assets, { runtime: STUB_RUNTIME, theme: doc.theme });
const rules = (html: string): ValidityRule[] => [...new Set(validateDocument(html).errors.map((e) => e.rule))];
const firstSection = doc.model.tabs[0]?.sections[0]?.id ?? '';

describe('validateDocument (13 §7.1)', () => {
  it('accepts a rendered document', () => {
    const r = validateDocument(good);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.stats.tabs).toBe(3);
    expect(r.warnings).toEqual([]);
  });

  it.each<[string, (h: string) => string, ValidityRule]>([
    [
      'external script',
      (h) => h.replace('</head>', '<script src="https://cdn.example.com/x.js"></script></head>'),
      'single-file',
    ],
    ['stylesheet link', (h) => h.replace('</head>', '<link rel="stylesheet" href="x.css"></head>'), 'single-file'],
    ['iframe', (h) => h.replace('<main>', '<main><iframe></iframe>'), 'single-file'],
    [
      'remote image',
      (h) => h.replace('<main>', '<main><img src="https://example.com/p.png" alt="">'),
      'no-external-ref',
    ],
    ['relative image', (h) => h.replace('<main>', '<main><img src="p.png" alt="">'), 'no-external-ref'],
    [
      'css url',
      (h) =>
        h.replace('<style id="eli5-theme">', '<style id="eli5-theme">a{background:url(https://example.com/t.png)}'),
      'no-external-ref',
    ],
    [
      'css import',
      (h) => h.replace('<style id="eli5-theme">', '<style id="eli5-theme">@import "x.css";'),
      'no-external-ref',
    ],
    [
      'link without rel',
      (h) => h.replace(' target="_blank" rel="noopener noreferrer">the pricing page', '>the pricing page'),
      'no-external-ref',
    ],
    ['loose CSP', (h) => h.replace("default-src 'none'", 'default-src *'), 'csp'],
    ['missing CSP', (h) => h.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''), 'csp'],
    ['bad section id', (h) => h.replaceAll(firstSection, 'sec-indepth-XYZ'), 'section-id-format'],
    ['wrong tab segment', (h) => h.replaceAll(firstSection, 'sec-eli5-00000000'), 'section-id-format'],
    ['duplicate id', (h) => h.replace('<main>', '<main><p id="tab-eli5">x</p>'), 'section-id-unique'],
    [
      'mirror mismatch',
      (h) => h.replace(`data-section-id="${firstSection}"`, 'data-section-id="sec-indepth-00000000"'),
      'section-id-mirror',
    ],
    ['default tab', (h) => h.replace('aria-selected="true"', 'aria-selected="false"'), 'default-tab'],
    ['inline handler', (h) => h.replace('<main>', '<main onclick="x()">'), 'no-inline-handlers'],
    [
      'glossary outside indepth',
      (h) =>
        h.replace(
          '<h2 class="panel-title">ELI5</h2>',
          '<h2 class="panel-title">ELI5</h2><details class="gl-note" id="g-zzzzzz"></details>',
        ),
      'glossary-scope',
    ],
    ['no references', (h) => h.replace('data-kind="references" ', ''), 'references'],
    ['parse error', (h) => h.replace('<main>', '<main><p <p>'), 'parse'],
  ])('flags %s', (_name, mutate, rule) => {
    expect(rules(mutate(good))).toContain(rule);
  });

  it('checks tabs and sources against meta', () => {
    const r = validateDocument(good, {
      tabs: [{ key: 'indepth' }, { key: 'eli5' }],
      sourcesUsed: [{ ref: 'missing-file.pdf', kind: 'file' }],
      sourcesSkipped: [{ ref: 'https://portal.example.com/login', reason: 'A different reason.' }],
    });
    expect(r.errors.map((e) => e.rule)).toEqual(['tabs-match-meta', 'references', 'references']);
  });

  it('warns (never errors) above 25 MB', { timeout: 60_000 }, () => {
    // Multi-byte text: 9 M characters of 'é' (2 bytes each) exceed 25 MB of UTF-8 cheaply.
    const big = good.replace('</main>', `<!--${'\u00e9'.repeat(13 * 1024 * 1024)}--></main>`);
    const r = validateDocument(big);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.rule)).toEqual(['size']);
  });
});
