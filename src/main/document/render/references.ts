// References section body (07 §10): "Used" in input order, "Skipped" with reasons, "Added by merge".
import { attrs, esc } from '../html';
import { SKIPPED_REASON_FALLBACK } from '../references';
import { formatDate } from './date';
import type { AssetCredit, ReferenceEntry } from '../types';
import { creditHtml } from './credit';

function httpHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function link(href: string, text: string, cls: string, title?: string): string {
  return `<a${attrs([
    ['class', cls],
    ['href', href],
    ['title', title],
    ['target', '_blank'],
    ['rel', 'noopener noreferrer'],
  ])}>${esc(text)}</a>`;
}

/**
 * "www.example.com/widgets/pricing": host plus path, no scheme, query or fragment (the same
 * host+path form skipped-source labels use, 07 §10, which validity.ts looks for).
 */
export function readableUrl(href: string): string {
  try {
    const u = new URL(href);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return href;
  }
}

/** The label is only the address (with or without scheme, `www.` or a trailing slash). */
function labelIsUrl(label: string, href: string): boolean {
  const norm = (s: string): string =>
    s
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '');
  const l = norm(label);
  return l === norm(href) || l === norm(readableUrl(href)) || label.includes(href);
}

function item(e: ReferenceEntry): string {
  const href = httpHref(e.href);
  let out: string;
  if (href && labelIsUrl(e.label, href)) {
    // 07 §10: an address-only label is shown once, readable, as the link; the full URL is its title.
    out = link(href, readableUrl(href), 'ref-label', href);
  } else if (href) {
    // A titled source: the title is the link, the address follows once as subtle text.
    out = `${link(href, e.label, 'ref-label', href)} <span class="ref-url">${esc(readableUrl(href))}</span>`;
  } else out = `<span class="ref-label">${esc(e.label)}</span>`;
  if (e.status === 'skipped')
    out += ` — <span class="ref-reason">${esc(e.reason?.trim() || SKIPPED_REASON_FALLBACK)}</span>`;
  else if (e.detail) out += ` <span class="ref-detail">${esc(e.detail)}</span>`;
  if (e.addedBy)
    out +=
      ` <span class="ref-added"><span class="enh-swatch" aria-hidden="true"></span>` +
      `Added in merge on ${esc(formatDate(e.addedBy.mergedAt))} from ${esc(e.addedBy.mergeFromTitle)}</span>`;
  return `<li${attrs([
    ['data-ref-status', e.status],
    ['data-merge', e.addedBy?.mergeId],
  ])}>${out}</li>`;
}

/** `credits`: the stock photos the document shows (07 §7.4), listed after the sources. */
export function renderReferencesBody(refs: readonly ReferenceEntry[], credits: readonly AssetCredit[] = []): string {
  const used = refs.filter((r) => r.status === 'used' && !r.addedBy);
  const skipped = refs.filter((r) => r.status === 'skipped' && !r.addedBy);
  const merged = refs.filter((r) => r.addedBy);
  let out = '';
  out += '<h3 class="ref-group">Used</h3>';
  out += used.length
    ? `<ol class="refs refs--used">${used.map(item).join('')}</ol>`
    : '<p class="refs-empty">No sources.</p>';
  if (skipped.length)
    out += `<h3 class="ref-group">Skipped</h3><ul class="refs refs--skipped">${skipped.map(item).join('')}</ul>`;
  if (merged.length)
    out += `<h3 class="ref-group">Added by merge</h3><ul class="refs refs--merged">${merged.map(item).join('')}</ul>`;
  if (credits.length)
    out +=
      '<h3 class="ref-group">Image credits</h3><ul class="refs refs--credits">' +
      credits.map((c) => `<li data-credit="stock-photo">${creditHtml(c)}</li>`).join('') +
      '</ul>';
  return out;
}
