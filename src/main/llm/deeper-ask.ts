import type { DeepAskPlan } from './deep-ask';
import type { SectionDeeperAnswerDraft } from './schemas/draft';
import type { WebSource } from './types';

/**
 * Ask deeper (08 §6.10, 02 §12): the app-side checks on the model's draft. Pure, so they are tested
 * offline. The model may list any page; only pages the provider itself reported for this call are
 * kept, and `reach` is corrected against what actually ran.
 */

/** 08 §6.10 step 3: web searches one Ask deeper may run. */
export const DEEPER_ASK_MAX_SEARCHES = 3;
/** Pages a deeper answer box lists at most (07 §6.5). */
export const DEEPER_WEB_MAX = 6;
/** A listed page's title, one line, at most this long. */
export const DEEPER_WEB_TITLE_MAX = 120;
/** A stored page URL at most this long (07 §3 schema). */
export const DEEPER_WEB_URL_MAX = 2000;

export interface DeeperAskResult {
  /** After `finalizeDeeperAnswer`. */
  draft: SectionDeeperAnswerDraft;
  plan: DeepAskPlan;
  /** Searches the provider ran (0 when the tool was not sent or was dropped). */
  webSearches: number;
  /** Pages the provider reported, as a count (only counts are logged). */
  webSourceCount: number;
}

/**
 * The comparable form of a page URL: `http:` or `https:` only, fragment removed, otherwise as the
 * URL parser serialises it (lower-case scheme and host, default port dropped). null when the URL
 * does not parse, uses another scheme, carries credentials, or is too long.
 */
export function normalizeWebUrl(raw: string): string | null {
  const text = raw.trim();
  if (text === '' || text.length > DEEPER_WEB_URL_MAX) return null;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username !== '' || u.password !== '') return null;
  u.hash = '';
  const out = u.toString();
  return out.length > DEEPER_WEB_URL_MAX ? null : out;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Claude's web search wraps cited text in `<cite index="…">…</cite>` inside the answer (seen on a
 * real call); the tags are removed and the cited words kept, so an escaped box never shows markup.
 */
const CITE_TAG = /<\/?cite\b[^>]*>/gi;

export function stripCiteTags(s: string): string {
  return s.replace(CITE_TAG, '');
}

function capTitle(s: string): string {
  const t = oneLine(s);
  return t.length > DEEPER_WEB_TITLE_MAX ? `${t.slice(0, DEEPER_WEB_TITLE_MAX - 1).trimEnd()}…` : t;
}

/**
 * 08 §6.10 step 5. `web` keeps, in the model's order, only entries whose normalised URL equals a
 * normalised URL in `webSources` (first occurrence wins, at most DEEPER_WEB_MAX); the stored URL is
 * the normalised one and a blank title becomes the host. `reach`: 'web' with no search becomes
 * 'general'; 'material' with kept pages becomes 'web'; otherwise the model's value stands.
 * Citation tags are stripped from the topic and the paragraphs (`stripCiteTags`).
 */
export function finalizeDeeperAnswer(
  draft: SectionDeeperAnswerDraft,
  webSources: readonly WebSource[],
  webSearches: number,
): SectionDeeperAnswerDraft {
  const reported = new Set<string>();
  for (const w of webSources) {
    const n = normalizeWebUrl(w.url);
    if (n !== null) reported.add(n);
  }
  const web: SectionDeeperAnswerDraft['web'] = [];
  const seen = new Set<string>();
  for (const w of draft.web) {
    if (web.length >= DEEPER_WEB_MAX) break;
    const url = normalizeWebUrl(w.url);
    if (url === null || !reported.has(url) || seen.has(url)) continue;
    seen.add(url);
    web.push({ title: capTitle(w.title) || new URL(url).host, url });
  }
  let reach = draft.reach;
  if (reach === 'web' && webSearches === 0) reach = 'general';
  if (reach === 'material' && web.length > 0) reach = 'web';
  return {
    ...draft,
    topic: stripCiteTags(draft.topic),
    paragraphs: draft.paragraphs.map(stripCiteTags),
    reach,
    web,
  };
}
