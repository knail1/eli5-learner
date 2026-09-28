import type { CatalogEntry, UiRoute } from '../../preload/contract';

/** Route helpers (11 §6). */

const LAST_DOC_KEY = 'eli5.lastDoc';

/** localStorage can throw or be empty (private mode, cleared data); never rely on it. */
export function readLastDoc(): string | null {
  try {
    return window.localStorage.getItem(LAST_DOC_KEY);
  } catch {
    return null;
  }
}

export function rememberDoc(slug: string): void {
  try {
    window.localStorage.setItem(LAST_DOC_KEY, slug);
  } catch {
    // per-viewer convenience only
  }
}

/** The most recently opened document if it still exists, else welcome. */
export function startupRoute(catalog: readonly CatalogEntry[] | null, lastDoc: string | null): UiRoute {
  if (catalog && lastDoc && catalog.some((e) => e.topicSlug === lastDoc)) return { view: 'doc', slug: lastDoc };
  return { view: 'welcome' };
}

/** A doc route whose slug has left the catalog shows the "files are missing" state (11 §8). */
export function resolveRoute(route: UiRoute, catalog: readonly CatalogEntry[] | null): UiRoute {
  if (route.view === 'doc' && catalog && !catalog.some((e) => e.topicSlug === route.slug)) {
    return { view: 'not-found', slug: route.slug };
  }
  return route;
}

export function sameRoute(a: UiRoute, b: UiRoute): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
