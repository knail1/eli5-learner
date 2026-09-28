import type { CatalogEntry } from '../../../preload/contract';

/**
 * Library order (11 §5.2): newest first by createdAt, ties by title ascending. Regeneration changes
 * updatedAt only, so it never reorders. The Tray uses the same order.
 */
export function sortCatalog(entries: readonly CatalogEntry[]): CatalogEntry[] {
  return [...entries].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.title.localeCompare(b.title);
  });
}

/** Case-insensitive substring match on title and summary, client side. */
export function filterCatalog(entries: readonly CatalogEntry[], query: string): CatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter((e) => e.title.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q));
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Compact relative date for the sidebar: "now", "2m", "5h", "3d", "1w", then "Mar 4". */
export function relativeDate(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = Math.max(0, now - t);
  if (d < MIN) return 'now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  if (d < WEEK) return `${Math.floor(d / DAY)}d`;
  if (d < 5 * WEEK) return `${Math.floor(d / WEEK)}w`;
  const date = new Date(t);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { dateStyle: 'medium' });
}

/** Long form for the document header: "Updated 3d ago" style without the jargon. */
export function updatedLabel(iso: string, now: number = Date.now()): string {
  const r = relativeDate(iso, now);
  if (!r) return '';
  if (r === 'now') return 'Updated just now';
  return /^\d+[mhdw]$/.test(r) ? `Updated ${r} ago` : `Updated ${r}`;
}
