import type { FindInDocumentRequest, FindResultEvent } from '../../preload/contract';

/**
 * Find in document (11 §5.3 find bar). The bar lives in the app renderer; the search runs on the
 * viewer's webContents with `findInPage`, and its `found-in-page` results go back to the app. Only
 * the latest request's results are forwarded, so a slow earlier search never overwrites the count.
 *
 * While a search is active, a reload of the viewer (a document update, undo, merge or another
 * document) and a switch between the document's tabs (the runtime writes `#tab=<key>`) reset it:
 * the app re-runs the search after a tab switch and waits for the next Enter after a reload, so
 * the post-update scroll to the changed section is not overridden by a jump to the first match.
 */

/** The fields of Electron's `found-in-page` result that are forwarded. */
export interface FoundInPage {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

/** The part of the viewer's WebContents that find uses. */
export interface FindViewer {
  findInPage(text: string, opts: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): number;
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void;
  getURL(): string;
  on(event: 'found-in-page', listener: (e: unknown, r: FoundInPage) => void): unknown;
  on(event: 'did-finish-load', listener: () => void): unknown;
  on(event: 'did-navigate-in-page', listener: (e: unknown, url: string, isMainFrame: boolean) => void): unknown;
}

/**
 * The document tab a viewer URL shows: the `#tab=<key>` fragment, '' for none (the first tab), and
 * undefined for any other fragment (a section link, which does not say which tab is shown).
 */
export function tabOfUrl(url: string): string | undefined {
  let hash: string;
  try {
    hash = new URL(url).hash.replace(/^#/, '');
  } catch {
    return undefined;
  }
  if (hash === '') return '';
  return hash.startsWith('tab=') ? hash.slice(4) : undefined;
}

export interface FindInDocument {
  /** Subscribes to the current viewer's events; idempotent, and repeated for a recreated viewer. */
  attach(): void;
  find(r: FindInDocumentRequest): void;
  /** Ends the search and clears the highlight. */
  stop(): void;
}

export function createFindInDocument(d: {
  viewer: () => FindViewer | undefined;
  send: (e: FindResultEvent) => void;
}): FindInDocument {
  const attached = new WeakSet<object>();
  /** requestId of the latest findInPage call; undefined while no search is active. */
  let latest: number | undefined;
  let tab: string | undefined;

  const reset = (reason: 'reload' | 'tab'): void => {
    if (latest === undefined) return;
    // Results still in flight belong to the old page or tab; the app decides when to search again.
    latest = -1;
    d.send({ kind: 'reset', reason });
  };

  const attach = (): void => {
    const v = d.viewer();
    if (!v || attached.has(v)) return;
    attached.add(v);
    tab = tabOfUrl(v.getURL());
    v.on('found-in-page', (_e, r) => {
      if (latest === undefined || r.requestId !== latest) return;
      d.send({
        kind: 'result',
        activeMatchOrdinal: r.activeMatchOrdinal,
        matches: r.matches,
        finalUpdate: r.finalUpdate,
      });
    });
    v.on('did-finish-load', () => {
      tab = tabOfUrl(v.getURL());
      reset('reload');
    });
    v.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      const next = tabOfUrl(url);
      if (next === undefined || next === tab) return;
      tab = next;
      reset('tab');
    });
  };

  return {
    attach,
    find(r) {
      attach();
      const v = d.viewer();
      if (!v) return;
      latest = v.findInPage(r.text, { forward: r.forward ?? true, findNext: !r.again, matchCase: false });
    },
    stop() {
      latest = undefined;
      d.viewer()?.stopFindInPage('clearSelection');
    },
  };
}
