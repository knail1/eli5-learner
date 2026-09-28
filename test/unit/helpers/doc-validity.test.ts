/**
 * validateDocument (13 §7.1): every static rule against the committed golden documents, which embed
 * the real doc-runtime and its CSP hash (07 §6.2). One mutation per failure mode.
 */
import { describe, expect, it } from 'vitest';
import { GOLDEN_NAMES, fixtureDocument, type GoldenName } from '../../fixtures/documents/models';
import { RESOLVED, SKIPPED } from '../../fixtures/documents/drafts';
import { readGolden } from '../../fixtures/documents/runtime';
import { validateDocument, type ValidityMeta, type ValidityRule } from '../../helpers/doc-validity';

function metaFor(name: GoldenName): ValidityMeta {
  const { model } = fixtureDocument(name);
  return {
    tabs: model.tabs.map((t) => ({ key: t.key })),
    sourcesUsed: RESOLVED.map((s) => ({ ref: s.ref, kind: s.resolverId })),
    sourcesSkipped: name === 'placeholder' ? [] : SKIPPED.map((s) => ({ ref: s.ref, reason: s.reason })),
  };
}

const good = readGolden('full');
const rules = (html: string, meta?: ValidityMeta): ValidityRule[] => [
  ...new Set(validateDocument(html, meta).errors.map((e) => e.rule)),
];
const CSP_META_RE = /<meta http-equiv="Content-Security-Policy"[^>]*>/;
const inMain = (snippet: string) => (h: string) => h.replace('<main>', `<main>${snippet}`);
const inHead = (snippet: string) => (h: string) => h.replace('</head>', `${snippet}</head>`);
const cspOf = (h: string): string => /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(h)?.[1] ?? '';
const withCsp = (edit: (csp: string) => string) => (h: string) => h.replace(cspOf(h), edit(cspOf(h)));
const moveCsp = (to: (h: string, meta: string) => string) => (h: string) => {
  const meta = CSP_META_RE.exec(h)?.[0] ?? '';
  return to(h.replace(meta, ''), meta);
};

describe.each(GOLDEN_NAMES)('golden %s', (name) => {
  it('passes every static rule with its meta and no warnings', () => {
    const r = validateDocument(readGolden(name), metaFor(name));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.stats.tabs).toBe(metaFor(name).tabs.length);
    expect(r.stats.sections).toBeGreaterThan(0);
  });
});

describe('validateDocument rules (13 §7.1)', () => {
  it.each<[string, (h: string) => string, ValidityRule]>([
    // parse
    ['stray markup', inMain('<p <p>'), 'parse'],
    ['second <html>', (h) => h.replace('</body>', '<html></html></body>'), 'parse'],
    // single-file: self-contained
    ['script src', inHead('<script src="runtime.js"></script>'), 'single-file'],
    ['stylesheet link', inHead('<link rel="stylesheet" href="x.css">'), 'single-file'],
    ['iframe', inMain('<iframe></iframe>'), 'single-file'],
    ['object', inMain('<object></object>'), 'single-file'],
    ['embed', inMain('<embed>'), 'single-file'],
    ['base', inHead('<base href="#">'), 'single-file'],
    // no-external-ref: no external requests
    ['remote img', inMain('<img src="https://example.com/p.png" alt="">'), 'no-external-ref'],
    ['relative img', inMain('<img src="p.png" alt="">'), 'no-external-ref'],
    ['protocol-relative img', inMain('<img src="//example.com/p.png" alt="">'), 'no-external-ref'],
    ['file: img', inMain('<img src="file:///tmp/p.png" alt="">'), 'no-external-ref'],
    [
      'srcset',
      inMain('<img src="data:image/png;base64,AA==" srcset="https://example.com/2x.png 2x" alt="">'),
      'no-external-ref',
    ],
    ['video poster', inMain('<video poster="https://example.com/p.png"></video>'), 'no-external-ref'],
    ['form action', inMain('<form action="https://example.com/f"></form>'), 'no-external-ref'],
    ['button formaction', inMain('<button formaction="https://example.com/f">x</button>'), 'no-external-ref'],
    [
      'svg xlink:href',
      inMain('<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://example.com/i.png"/></svg>'),
      'no-external-ref',
    ],
    ['inline style url()', inMain('<p style="background:url(https://example.com/t.png)">x</p>'), 'no-external-ref'],
    ['<style> url()', inHead('<style>a{background:url("//example.com/t.png")}</style>'), 'no-external-ref'],
    ['@import', inHead('<style>@import url(data:text/css,a{});</style>'), 'no-external-ref'],
    ['non-anchor href', inMain('<map name="m"><area href="https://example.com/"></map>'), 'no-external-ref'],
    ['relative anchor', inMain('<a href="other.html">x</a>'), 'no-external-ref'],
    ['anchor without target/rel', inMain('<a href="https://example.com/">x</a>'), 'no-external-ref'],
    // no-inline-handlers
    ['onclick', inMain('<p onclick="x()">x</p>'), 'no-inline-handlers'],
    ['svg onload', inMain('<svg onload="x()"></svg>'), 'no-inline-handlers'],
    // csp (07 §6.2)
    ['missing CSP meta', (h) => h.replace(CSP_META_RE, ''), 'csp'],
    ['default-src not none', withCsp((c) => c.replace("default-src 'none'", 'default-src *')), 'csp'],
    ['connect-src opened', withCsp((c) => c.replace("connect-src 'none'", 'connect-src https:')), 'csp'],
    ['img-src opened', withCsp((c) => c.replace('img-src data:', 'img-src data: https:')), 'csp'],
    [
      'style-src opened',
      withCsp((c) => c.replace("style-src 'unsafe-inline'", "style-src 'unsafe-inline' https:")),
      'csp',
    ],
    ['script-src unsafe-inline', withCsp((c) => c.replace("script-src '", "script-src 'unsafe-inline' '")), 'csp'],
    ['unknown directive opened', withCsp((c) => `${c}; worker-src *`), 'csp'],
    ['base-uri dropped', withCsp((c) => c.replace("; base-uri 'none'", '')), 'csp'],
    ['form-action dropped', withCsp((c) => c.replace("form-action 'none'; ", '')), 'csp'],
    ['object-src opened', withCsp((c) => c.replace("object-src 'none'", 'object-src *')), 'csp'],
    [
      'runtime edited (hash mismatch)',
      (h) => h.replace('<script id="eli5-runtime">', '<script id="eli5-runtime">/*x*/'),
      'csp',
    ],
    [
      'hash from another runtime',
      withCsp((c) => c.replace(/sha256-[A-Za-z0-9+/=]+/, `sha256-${'A'.repeat(43)}=`)),
      'csp',
    ],
    ['extra unhashed inline script', inMain('<script>void 0</script>'), 'csp'],
    [
      'CSP meta after a script',
      moveCsp((h, meta) =>
        h
          .replace('<meta charset="utf-8">', '<meta charset="utf-8"><script type="application/json">{}</script>')
          .replace('</head>', `${meta}</head>`),
      ),
      'csp',
    ],
    ['CSP meta in body', moveCsp((h, meta) => h.replace('<main>', `<main>${meta}`)), 'csp'],
    ['two CSP metas', moveCsp((h, meta) => h.replace('</head>', `${meta}${meta}</head>`)), 'csp'],
    // section ids
    ['malformed section id', (h) => h.replaceAll('sec-indepth-148f210a', 'sec-indepth-XYZ'), 'section-id-format'],
    ['section id tab segment', (h) => h.replaceAll('sec-indepth-148f210a', 'sec-eli5-148f210a'), 'section-id-format'],
    [
      'section outside a panel',
      inMain('<section id="sec-indepth-00000001" data-section-id="sec-indepth-00000001"></section>'),
      'section-id-format',
    ],
    ['duplicate id', inMain('<p id="tab-eli5">x</p>'), 'section-id-unique'],
    ['duplicate section id', (h) => h.replaceAll('sec-eli5-7d0f4e94', 'sec-eli5-aa296fff'), 'section-id-unique'],
    [
      'mirror mismatch',
      (h) => h.replace('data-section-id="sec-eli5-aa296fff"', 'data-section-id="sec-eli5-00000000"'),
      'section-id-mirror',
    ],
    ['data-section-id off a section', inMain('<div data-section-id="sec-eli5-00000000"></div>'), 'section-id-mirror'],
    // tabs present
    ['eli5 panel missing', (h) => h.replace('data-tab-key="eli5"', 'data-tab-key="other"'), 'tabs-match-meta'],
    [
      'tab button missing',
      (h) => h.replace(/<button type="button" role="tab" id="tabbtn-eli5"[^>]*>/, '<button type="button">'),
      'tabs-match-meta',
    ],
    [
      'panel id mismatch',
      (h) => h.replace('id="tab-eli5" data-tab-key="eli5"', 'id="tab-x" data-tab-key="eli5"'),
      'tabs-match-meta',
    ],
    // default tab
    ['no default tab', (h) => h.replace('aria-selected="true"', 'aria-selected="false"'), 'default-tab'],
    [
      'eli5 selected by default',
      (h) =>
        h
          .replace(
            'aria-controls="tab-indepth" aria-selected="true"',
            'aria-controls="tab-indepth" aria-selected="false"',
          )
          .replace('aria-controls="tab-eli5" aria-selected="false"', 'aria-controls="tab-eli5" aria-selected="true"'),
      'default-tab',
    ],
    // glossary only in In depth
    [
      'glossary note in ELI5',
      (h) =>
        h.replace(
          '<h2 class="panel-title">ELI5</h2>',
          '<h2 class="panel-title">ELI5</h2><details class="gl-note" id="g-zz"></details>',
        ),
      'glossary-scope',
    ],
    ['glossary note outside panels', inMain('<details class="gl-note" id="g-zz"></details>'), 'glossary-scope'],
    // references
    ['no references section', (h) => h.replace('data-kind="references" ', ''), 'references'],
    [
      'references actionable',
      (h) =>
        h.replace(
          'data-kind="references" data-origin="generated" data-eli5-actionable="false"',
          'data-kind="references" data-origin="generated" data-eli5-actionable="true"',
        ),
      'references',
    ],
  ])('flags %s', (_name, mutate, rule) => {
    const html = mutate(good);
    expect(html).not.toBe(good);
    expect(rules(html)).toContain(rule);
  });

  it('flags tabs that differ from meta.tabs (order and keys)', () => {
    const meta = metaFor('full');
    expect(rules(good, { ...meta, tabs: [{ key: 'eli5' }, { key: 'indepth' }] })).toEqual(['tabs-match-meta']);
    expect(rules(good, { ...meta, tabs: [...meta.tabs, { key: 'sec1' }] })).toEqual(['tabs-match-meta']);
  });

  it('requires every used and skipped source, with its skip reason, in references', () => {
    const meta = metaFor('full');
    const missingUsed = { ...meta, sourcesUsed: [...meta.sourcesUsed, { ref: 'missing-file.pdf', kind: 'file' }] };
    expect(validateDocument(good, missingUsed).errors).toEqual([
      expect.objectContaining({ rule: 'references', detail: expect.stringContaining('missing-file.pdf') }),
    ]);
    const skippedRef = {
      ...meta,
      sourcesSkipped: [...meta.sourcesSkipped, { ref: 'https://other.example.com/x', reason: 'Page required login.' }],
    };
    expect(rules(good, skippedRef)).toEqual(['references']);
    const wrongReason = {
      ...meta,
      sourcesSkipped: meta.sourcesSkipped.map((s, i) => (i === 0 ? { ...s, reason: 'A different reason.' } : s)),
    };
    expect(validateDocument(good, wrongReason).errors.map((e) => e.detail)).toEqual([
      expect.stringContaining('skip reason missing'),
    ]);
    // Dropping the skipped list fails even though every used source is still listed.
    const noSkipped = good.replace(/<h3 class="ref-group">Skipped<\/h3><ul[\s\S]*?<\/ul>/, '');
    expect(noSkipped).not.toBe(good);
    expect(rules(noSkipped, meta)).toEqual(['references']);
  });

  it('reports each error once even when both check layers see it', () => {
    const r = validateDocument(withCsp((c) => c.replace("default-src 'none'", 'default-src *'))(good));
    const keys = r.errors.map((e) => `${e.rule}:${e.detail}`);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('size: warns above 25 MB and never errors (07 §5.4)', { timeout: 60_000 }, () => {
    // 13 M two-byte characters exceed 25 MB of UTF-8 cheaply.
    const big = good.replace('</main>', `<!--${'é'.repeat(13 * 1024 * 1024)}--></main>`);
    const r = validateDocument(big);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.rule)).toEqual(['size']);
    expect(r.stats.bytes).toBeGreaterThan(25 * 1024 * 1024);
  });
});
