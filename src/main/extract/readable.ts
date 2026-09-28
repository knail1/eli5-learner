/**
 * Worker-safe Readability for local .html files (04 §4 dispatch row "html", §10.4). 05's helper
 * lives behind fetch/index.ts, whose import graph reaches Electron, so the extract worker cannot
 * load it; this entry imports only @mozilla/readability and jsdom, both loaded on first use so the
 * main process (which builds the registry) never loads them (01 §7). It follows 05 §5.3's parse
 * (Readability on a clone, no scripts, no resource loading) and hands the article HTML to
 * htmlToBlocks, which does the tag filtering.
 */

/** 05 §5 minContentLength: below this the page is treated as having no article. */
const MIN_ARTICLE_CHARS = 140;
/** An "article" much smaller than the page's text is a Readability miss (a teaser box), not the content. */
const MIN_ARTICLE_SHARE = 0.2;

const collapse = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

function bodyText(doc: Document): string {
  const body = doc.body?.cloneNode(true) as HTMLElement | undefined;
  if (!body) return '';
  body.querySelectorAll('script, style, noscript, template').forEach((n) => n.remove());
  return collapse(body.textContent);
}

/**
 * The page's main article as HTML, or the page unchanged when Readability finds no substantial
 * article. Synchronous work: a stuck parse is bounded by the worker's kill timer (04 §10.4).
 */
export async function readableHtml(html: string, baseUrl: string | undefined, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const [{ Readability }, { JSDOM, VirtualConsole }] = await Promise.all([
    import('@mozilla/readability'),
    import('jsdom'),
  ]);
  signal.throwIfAborted();
  // runScripts and resources stay at their defaults: nothing in the page runs or loads.
  const dom = new JSDOM(html, {
    ...(baseUrl ? { url: baseUrl } : {}),
    contentType: 'text/html',
    virtualConsole: new VirtualConsole(),
  });
  try {
    const doc = dom.window.document;
    const total = bodyText(doc).length;
    const h1s = new Set([...doc.querySelectorAll('h1')].map((h) => collapse(h.textContent)).filter(Boolean));
    // Readability mutates its input, so it runs on a clone (05 §5.3).
    const parsed = new Readability<Element>(doc.cloneNode(true) as Document, {
      charThreshold: 500,
      keepClasses: false,
      nbTopCandidates: 5,
      serializer: (n) => n as Element,
    }).parse();
    signal.throwIfAborted();
    const len = collapse(parsed?.textContent).length;
    if (!parsed?.content || len < MIN_ARTICLE_CHARS || len < total * MIN_ARTICLE_SHARE) return html;
    // Readability turns every h1 into h2; the page's own h1 keeps level 1 so the outline survives.
    for (const h of [...parsed.content.querySelectorAll('h2')]) {
      if (!h1s.has(collapse(h.textContent))) continue;
      const h1 = doc.createElement('h1');
      h1.innerHTML = h.innerHTML;
      h.replaceWith(h1);
    }
    return parsed.content.innerHTML;
  } finally {
    dom.window.close();
  }
}
