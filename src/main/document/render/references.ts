// References section body (07 §10): "Used" in input order, "Skipped" with reasons, "Added by merge".
import { attrs, esc } from '../html';
import { SKIPPED_REASON_FALLBACK } from '../references';
import { formatDate } from './date';
import type { ReferenceEntry } from '../types';

function httpHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function link(href: string, text: string, cls: string): string {
  return `<a${attrs([
    ['class', cls],
    ['href', href],
    ['target', '_blank'],
    ['rel', 'noopener noreferrer'],
  ])}>${esc(text)}</a>`;
}

function item(e: ReferenceEntry): string {
  const href = httpHref(e.href);
  let out = href ? link(href, e.label, 'ref-label') : `<span class="ref-label">${esc(e.label)}</span>`;
  // URLs are shown as text and as a link (07 §10).
  if (href && href !== e.label) out += ` <span class="ref-url">${esc(href)}</span>`;
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

export function renderReferencesBody(refs: readonly ReferenceEntry[]): string {
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
  return out;
}
