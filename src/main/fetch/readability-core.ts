import { isProbablyReaderable, Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import { DETECT } from './constants';
import { CHALLENGE_TITLE } from './detect';
import { LOGIN_HEADING } from './login-wall';
import type { PageSignals } from './types';

/**
 * Readability + page signals, pure and synchronous (05 §5, §6.1). Runs inside the worker thread in
 * production (readability.worker.ts) and in-process in unit tests. No Electron imports.
 */

export interface ReadabilityJob {
  html: string;
  url: string;
  selectors?: string[]; // LoginSignature.domSelector values to probe (HOOK-FETCH-02)
}

export interface ReadabilityArticle {
  title: string | null;
  byline: string | null;
  siteName: string | null;
  lang: string | null;
  publishedTime: string | null;
  excerpt: string | null;
  contentHtml: string;
  textLength: number;
  imageUrls: string[];
}

export interface ReadabilityResult {
  article: ReadabilityArticle | null;
  signals: PageSignals;
  login: { loginHeading: boolean; paywallMarkers: boolean; selectorHits: string[] };
}

const MOUNT_SELECTOR =
  '#root, #app, #__next, #__nuxt, #svelte, [data-reactroot], [ng-version], [data-server-rendered], app-root';
const ENABLE_JS = /enable javascript|requires javascript|javascript is (disabled|required)/i;
const PAYWALL_TEXT = /subscribe to (continue|read)|already a subscriber|this content is for subscribers/i;
const STRIP_TAGS = 'script, style, iframe, object, embed, form, input, button, noscript, textarea, select';
const NON_CONTENT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'TEMPLATE', 'META']);

const collapse = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

function visibleText(el: Element | null): string {
  if (!el) return '';
  const c = el.cloneNode(true) as Element;
  c.querySelectorAll('script, style, noscript, template').forEach((n) => n.remove());
  return collapse(c.textContent);
}

function abs(href: string, base: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function metaContent(doc: Document, sel: string): string | null {
  const v = doc.querySelector(sel)?.getAttribute('content');
  return v && v.trim() ? v.trim() : null;
}

function parseMetaRefresh(doc: Document, base: string): string | null {
  const meta = [...doc.querySelectorAll('meta[http-equiv]')].find(
    (m) => m.getAttribute('http-equiv')?.toLowerCase() === 'refresh',
  );
  const m = /^\s*\d+(?:\.\d+)?\s*[;,]\s*url\s*=\s*['"]?([^'"]+)/i.exec(meta?.getAttribute('content') ?? '');
  return m?.[1] ? abs(m[1].trim(), base) : null;
}

function mountPointEmpty(doc: Document): boolean {
  const mount = doc.querySelector(MOUNT_SELECTOR);
  if (mount && visibleText(mount).length < DETECT.R3_MOUNT_TEXT) return true;
  const kids = [...(doc.body?.children ?? [])].filter((k) => !NON_CONTENT.has(k.tagName));
  const divs = kids.filter((k) => k.tagName === 'DIV');
  return (
    kids.length > 0 &&
    kids.length <= DETECT.R3_BODY_MAX_CHILDREN &&
    divs.length === 1 &&
    visibleText(divs[0] ?? null).length < DETECT.R3_MOUNT_TEXT &&
    visibleText(doc.body).length < DETECT.R3_MOUNT_TEXT
  );
}

function scriptBytes(doc: Document): number {
  let n = 0;
  for (const s of doc.querySelectorAll('script')) {
    const type = (s.getAttribute('type') ?? '').toLowerCase();
    if (type.includes('json') || type === 'text/template') continue;
    n += s.hasAttribute('src') ? DETECT.EXTERNAL_SCRIPT_BYTES : (s.textContent ?? '').length;
  }
  return n;
}

function challengeMarkers(doc: Document, bodyTextLength: number): boolean {
  if (CHALLENGE_TITLE.test(doc.title)) return true;
  if ([...doc.querySelectorAll('form[action]')].some((f) => /challenge/i.test(f.getAttribute('action') ?? ''))) {
    return true;
  }
  if (bodyTextLength >= DETECT.CHALLENGE_BODY_TEXT) return false;
  return [...doc.querySelectorAll('[id], [class]')].some(
    (el) => /challenge|captcha/i.test(el.id) || /challenge|captcha/i.test(el.getAttribute('class') ?? ''),
  );
}

function jsonLdNotFree(doc: Document): boolean {
  return [...doc.querySelectorAll('script[type="application/ld+json" i]')].some((s) =>
    /"isAccessibleForFree"\s*:\s*("?)false\1/i.test(s.textContent ?? ''),
  );
}

/** 05 §5.3 step 1–3, in place on the Readability content element. Returns image URLs. */
function sanitize(root: Element, base: string): string[] {
  root.querySelectorAll(STRIP_TAGS).forEach((n) => n.remove());
  const images: string[] = [];
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name)) el.removeAttribute(a.name);
    }
    for (const attr of ['href', 'src']) {
      const v = el.getAttribute(attr);
      if (v === null) continue;
      const u = abs(v, base);
      if (!u || /^(javascript|vbscript|data):/i.test(u)) el.removeAttribute(attr);
      else el.setAttribute(attr, u);
    }
    if (el.tagName === 'IMG') {
      const best = largestSrcset(el.getAttribute('srcset') ?? '', base) ?? el.getAttribute('src');
      if (best && /^https?:/i.test(best) && !images.includes(best)) images.push(best);
      el.removeAttribute('srcset');
    }
  }
  return images;
}

function largestSrcset(srcset: string, base: string): string | null {
  let best: { url: string; w: number } | null = null;
  for (const part of srcset.split(',')) {
    const [u, d] = part.trim().split(/\s+/);
    if (!u) continue;
    const w = d ? parseFloat(d) || 0 : 1;
    const a = abs(u, base);
    if (a && (!best || w > best.w)) best = { url: a, w };
  }
  return best?.url ?? null;
}

function hostAndPath(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url;
  }
}

export function runReadability(job: ReadabilityJob): ReadabilityResult {
  const dom = new JSDOM(job.html, { url: job.url, contentType: 'text/html', virtualConsole: new VirtualConsole() });
  try {
    const doc = dom.window.document;
    const bodyText = visibleText(doc.body);
    const bodyTextLength = bodyText.length;
    const titleText = collapse(doc.title);

    // Readability mutates its input, so it runs on a clone; signals come from the original (§5.3).
    const clone = doc.cloneNode(true) as Document;
    const parsed = new Readability<Element>(clone, {
      charThreshold: 500,
      keepClasses: false,
      nbTopCandidates: 5,
      serializer: (n) => n as Element,
    }).parse();

    let article: ReadabilityArticle | null = null;
    if (parsed?.content) {
      const content = parsed.content;
      const imageUrls = sanitize(content, job.url);
      const published =
        parsed.publishedTime ??
        metaContent(doc, 'meta[property="article:published_time"]') ??
        content.querySelector('time[datetime]')?.getAttribute('datetime') ??
        null;
      article = {
        title:
          collapse(parsed.title) || metaContent(doc, 'meta[property="og:title"]') || titleText || hostAndPath(job.url),
        byline: collapse(parsed.byline) || null,
        siteName: collapse(parsed.siteName) || metaContent(doc, 'meta[property="og:site_name"]'),
        lang: parsed.lang ?? (doc.documentElement.getAttribute('lang') || null),
        publishedTime: published,
        excerpt: collapse(parsed.excerpt) || null,
        contentHtml: content.innerHTML,
        textLength: parsed.length ?? collapse(content.textContent).length,
        imageUrls,
      };
    }

    const articleTextLength = article?.textLength ?? 0;
    const signals: PageSignals = {
      bodyTextLength,
      articleTextLength,
      readerable: isProbablyReaderable(doc, { minContentLength: 140, minScore: 20 }),
      scriptBytes: scriptBytes(doc),
      htmlBytes: Buffer.byteLength(job.html, 'utf8'),
      mountPointEmpty: mountPointEmpty(doc),
      noscriptSaysEnableJs: [...doc.querySelectorAll('noscript')].some((n) => ENABLE_JS.test(n.textContent ?? '')),
      hasPasswordField: doc.querySelector('input[type="password" i]') !== null,
      formCount: doc.querySelectorAll('form').length,
      metaRefreshUrl: parseMetaRefresh(doc, job.url),
      titleText,
      challengeMarkers: challengeMarkers(doc, bodyTextLength),
    };

    const h1s = [...doc.querySelectorAll('h1')].map((h) => collapse(h.textContent));
    const tail = (s: string): string => s.slice(-DETECT.PAYWALL_TAIL_CHARS);
    const articleText = article ? collapse(parsed?.textContent) : '';
    const noRobots = doc.querySelector('meta[name="robots" i]') === null;
    const paywallMarkers =
      (noRobots && (PAYWALL_TEXT.test(tail(articleText)) || PAYWALL_TEXT.test(tail(bodyText)))) || jsonLdNotFree(doc);
    const selectorHits = (job.selectors ?? []).filter((sel) => {
      try {
        return doc.querySelector(sel) !== null;
      } catch {
        return false; // invalid selector from a signature list
      }
    });

    return {
      article,
      signals,
      login: {
        loginHeading: LOGIN_HEADING.test(titleText) || h1s.some((h) => LOGIN_HEADING.test(h)),
        paywallMarkers,
        selectorHits,
      },
    };
  } finally {
    dom.window.close();
  }
}
