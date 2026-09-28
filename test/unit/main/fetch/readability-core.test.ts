import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classify } from '../../../../src/main/fetch/detect';
import { runReadability } from '../../../../src/main/fetch/readability-core';

/** The worker's pure core, run in-process (05 §5, §6.1). */

const site = (name: string) =>
  readFileSync(new URL(`../../../fixtures/sites/${name}/index.html`, import.meta.url), 'utf8');
const BASE = 'https://news.example.test/2026/widgets/';

describe('runReadability', () => {
  it('extracts the article with metadata, absolute URLs and sanitized HTML', () => {
    const r = runReadability({ html: site('article'), url: BASE });
    expect(r.article).not.toBeNull();
    const a = r.article!;
    expect(a.title).toBe('Example Widgets Inc. Opens a Solar-Powered Widget Plant');
    expect(a.siteName).toBe('Example Gazette');
    expect(a.lang).toBe('en');
    expect(a.publishedTime).toBe('2026-03-14T09:30:00Z');
    expect(a.imageUrls).toEqual(['https://news.example.test/images/plant-large.jpg']);
    expect(a.contentHtml).not.toMatch(/<script|onclick|srcset/i);
    expect(a.contentHtml).toContain('src="https://news.example.test/images/plant.jpg"');
    expect(a.contentHtml).toMatch(/<table/);
    expect(r.signals.articleTextLength).toBe(a.textLength);
    expect(classify(r.signals)).toBe('ok');
  });

  it('removes forms, scripts, event handlers and javascript: links from the content', () => {
    const para = '<p>' + 'Example Widgets Inc. publishes a long report about widgets and presses. '.repeat(12) + '</p>';
    const html = `<html><body><article><h1>T</h1>${para}<p><a href="javascript:alert(1)">bad</a> <a href="/ok" onclick="x()">ok</a></p><form><input name="q"><button>go</button></form><iframe src="https://x.example"></iframe><script>evil()</script>${para}</article></body></html>`;
    const r = runReadability({ html, url: BASE });
    const c = r.article!.contentHtml;
    expect(c).not.toMatch(/<form|<input|<button|<iframe|<script|onclick|javascript:/i);
    expect(c).toContain('href="https://news.example.test/ok"');
  });

  it('signals an SPA shell as client-rendered', () => {
    const r = runReadability({ html: site('spa'), url: BASE });
    expect(r.signals.mountPointEmpty).toBe(true);
    expect(r.signals.noscriptSaysEnableJs).toBe(true);
    expect(r.signals.scriptBytes).toBeGreaterThan(0);
    expect(classify(r.signals)).toBe('client-rendered');
  });

  it('finds login-page facts', () => {
    const r = runReadability({
      html: site('login-wall'),
      url: BASE,
      selectors: ['form[action="/session"]', '#nope', '::bad('],
    });
    expect(r.signals.hasPasswordField).toBe(true);
    expect(r.signals.formCount).toBe(1);
    expect(r.login.loginHeading).toBe(true);
    expect(r.login.selectorHits).toEqual(['form[action="/session"]']);
  });

  it('finds paywall markers, including JSON-LD isAccessibleForFree: false', () => {
    expect(runReadability({ html: site('paywall'), url: BASE }).login.paywallMarkers).toBe(true);
    const ld = `<html><head><script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree": false}</script></head><body><p>Teaser.</p></body></html>`;
    expect(runReadability({ html: ld, url: BASE }).login.paywallMarkers).toBe(true);
    expect(runReadability({ html: site('article'), url: BASE }).login.paywallMarkers).toBe(false);
  });

  it('detects challenge interstitials and meta refresh', () => {
    const r = runReadability({
      html: '<html><head><title>Just a moment...</title><meta http-equiv="Refresh" content="3; URL=/next"></head><body></body></html>',
      url: BASE,
    });
    expect(r.signals.challengeMarkers).toBe(true);
    expect(r.signals.metaRefreshUrl).toBe('https://news.example.test/next');
    const byClass = runReadability({
      html: '<html><body><div class="g-captcha">verify</div></body></html>',
      url: BASE,
    });
    expect(byClass.signals.challengeMarkers).toBe(true);
  });

  it('never executes page scripts', () => {
    const html = '<html><body><script>document.body.innerHTML = "<p>INJECTED</p>"</script><p>static</p></body></html>';
    const r = runReadability({ html, url: BASE });
    expect(r.signals.bodyTextLength).toBe('static'.length);
  });

  it('falls back to og:title, then <title>, then host + path for the title', () => {
    const para =
      '<p>' + 'A plain page with enough words to be treated as an article by the parser. '.repeat(10) + '</p>';
    const r = runReadability({
      html: `<html><head><title>Only Title</title></head><body>${para}${para}</body></html>`,
      url: BASE,
    });
    expect(r.article?.title).toBe('Only Title');
  });
});
