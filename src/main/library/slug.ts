/** Topic-slug rules (09 §6). Pure functions; reservations and I/O belong to allocateSlug (M1). */
import { randomUUID } from 'node:crypto';

/** Valid folder name / slug; also the docPath check (09 §9). */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 60;
/** 09 §6.3; any name starting with '.' is reserved too. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'catalog',
  'index',
  'sample',
  'assets',
  'static',
  'api',
  'docs',
]);
/** Numeric suffixes -2..-999 before falling back to -<8 hex> (09 §6.2 step 6). */
export const MAX_NUMERIC_SUFFIX = 999;

export function isValidSlug(s: string): boolean {
  return SLUG_PATTERN.test(s);
}

export function isReservedSlug(s: string): boolean {
  return s.startsWith('.') || RESERVED_SLUGS.has(s.toLowerCase());
}

const trimDashes = (s: string): string => s.replace(/^-+|-+$/g, '');

/** Cut at the last '-' at or before `max`, else hard cut; trim again (09 §6.1 step 5). */
function cutTo(s: string, max: number): string {
  if (s.length <= max) return s;
  const i = s.lastIndexOf('-', max);
  return trimDashes(i > 0 ? s.slice(0, i) : s.slice(0, max));
}

/** Steps 2-5 of 09 §6.1; '' when nothing survives. */
function slugCore(input: string): string {
  const s = input
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-');
  return cutTo(trimDashes(s), SLUG_MAX_LENGTH);
}

function yyyymmdd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 09 §6.1. Falls back to `learning-<yyyymmdd>` (local date of `now`) when empty. */
export function slugify(input: string, now: Date = new Date()): string {
  return slugCore(input) || `learning-${yyyymmdd(now)}`;
}

/** Base slug from title and optional hint (09 §6.1 step 1, §6.2 step 1). */
export function baseSlug(title: string, hint?: string, now: Date = new Date()): string {
  const fromHint = hint ? slugCore(hint) : '';
  const base = fromHint || slugify(title, now);
  return isReservedSlug(base) ? `${base}-doc` : base;
}

/** Appends `suffix`, re-cutting the base so the result stays <= 60 chars. */
function withSuffix(base: string, suffix: string): string {
  return `${cutTo(base, SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
}

export interface ChooseSlugOptions {
  now?: Date;
  /** 8 lowercase hex chars; default from randomUUID (09 §6.2 step 6). */
  randomHex?: () => string;
}

/**
 * First free candidate among `base`, `base-2` ... `base-999`, then `base-<8 hex>` (09 §6.2 steps
 * 1-3, 6). `taken` holds folder names, catalog slugs and reservations; it is compared
 * case-insensitively because APFS is case-insensitive by default.
 */
export function chooseSlug(
  title: string,
  hint: string | undefined,
  taken: Iterable<string>,
  opts: ChooseSlugOptions = {},
): string {
  const base = baseSlug(title, hint, opts.now);
  const used = new Set<string>();
  for (const t of taken) used.add(t.toLowerCase());
  const free = (s: string) => !used.has(s) && !isReservedSlug(s);
  if (free(base)) return base;
  for (let n = 2; n <= MAX_NUMERIC_SUFFIX; n++) {
    const c = withSuffix(base, `-${n}`);
    if (free(c)) return c;
  }
  const hex = opts.randomHex ?? (() => randomUUID().replace(/-/g, '').slice(0, 8));
  for (;;) {
    const c = withSuffix(base, `-${hex()}`);
    if (free(c)) return c;
  }
}
