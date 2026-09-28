/**
 * The save-time check (13 §7): checkDocumentHtml in src, which the pipeline runs before every
 * write, enforces the full 07 §6.2 CSP and the tab-button rules itself, not only the test helper.
 */
import { describe, expect, it } from 'vitest';
import { checkDocumentHtml, type ValidityRule } from '../../../../src/main/document/validity';
import { readGolden } from '../../../fixtures/documents/runtime';
import { validateDocument } from '../../../helpers/doc-validity';

const good = readGolden('full');
const CSP_META_RE = /<meta http-equiv="Content-Security-Policy"[^>]*>/;
const cspOf = (h: string): string => /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(h)?.[1] ?? '';
const withCsp = (edit: (csp: string) => string) => (h: string) => h.replace(cspOf(h), edit(cspOf(h)));
const moveCsp = (to: (h: string, meta: string) => string) => (h: string) => {
  const meta = CSP_META_RE.exec(h)?.[0] ?? '';
  return to(h.replace(meta, ''), meta);
};

describe('checkDocumentHtml (save-time, 13 §7)', () => {
  it('accepts a golden', () => {
    expect(checkDocumentHtml(good).errors).toEqual([]);
  });

  it.each<[string, (h: string) => string, ValidityRule]>([
    ['img-src opened', withCsp((c) => c.replace('img-src data:', 'img-src data: https:')), 'csp'],
    ['unknown directive opened', withCsp((c) => `${c}; worker-src *`), 'csp'],
    ['base-uri dropped', withCsp((c) => c.replace("; base-uri 'none'", '')), 'csp'],
    ['form-action dropped', withCsp((c) => c.replace("form-action 'none'; ", '')), 'csp'],
    [
      'runtime edited (hash mismatch)',
      (h) => h.replace('<script id="eli5-runtime">', '<script id="eli5-runtime">/*x*/'),
      'csp',
    ],
    ['extra unhashed inline script', (h) => h.replace('<main>', '<main><script>void 0</script>'), 'csp'],
    ['CSP meta in body', moveCsp((h, meta) => h.replace('<main>', `<main>${meta}`)), 'csp'],
    ['two CSP metas', moveCsp((h, meta) => h.replace('</head>', `${meta}${meta}</head>`)), 'csp'],
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
  ])('flags %s', (_name, mutate, rule) => {
    const html = mutate(good);
    expect(html).not.toBe(good);
    expect(checkDocumentHtml(html).errors.map((e) => e.rule)).toContain(rule);
  });

  it('is what the test helper runs (one rule set, no second layer)', () => {
    const html = withCsp((c) => `${c}; worker-src *`)(good);
    expect(validateDocument(html)).toEqual(checkDocumentHtml(html));
  });
});
