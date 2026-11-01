/**
 * Bottom panel height rule (11 §5.1): pure, so it is tested as a table. The panel is the input
 * zone and status area under the viewer.
 */

/** Arrow Up / Down step. */
export const BOTTOM_STEP_PX = 16;
/** The panel never grows past twice its natural height, nor past this share of the window. */
export const BOTTOM_MAX_FACTOR = 2;
export const BOTTOM_MAX_WINDOW_SHARE = 0.8;
export const BOTTOM_PANEL_KEY = 'eli5.bottomPanel';

/** The largest allowed height; equals `natural` when there is no room to grow. */
export function bottomCap(natural: number, windowHeight: number): number {
  const cap = Math.min(natural * BOTTOM_MAX_FACTOR, windowHeight * BOTTOM_MAX_WINDOW_SHARE);
  return Math.round(Math.max(natural, cap));
}

/** A requested height clamped to [natural, cap] and rounded to whole pixels. */
export function clampBottom(requested: number, natural: number, windowHeight: number): number {
  const lo = Math.round(natural);
  return Math.round(Math.min(bottomCap(natural, windowHeight), Math.max(lo, requested)));
}

/** The separator's value: 0 at natural height, 100 at the cap, linear between; 0 with no room. */
export function bottomPosition(height: number, natural: number, windowHeight: number): number {
  const cap = bottomCap(natural, windowHeight);
  if (cap <= natural) return 0;
  return Math.round((100 * (clampBottom(height, natural, windowHeight) - natural)) / (cap - natural));
}

export interface StoredBottom {
  /** The chosen height in px. */
  height: number;
  /** The natural height it was measured against. */
  natural: number;
}

/** Reads the stored height; a missing, malformed or non-positive value is ignored (null). */
export function parseStoredBottom(raw: string | null): StoredBottom | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return null;
    const { height, natural } = v as { height?: unknown; natural?: unknown };
    const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
    return ok(height) && ok(natural) ? { height, natural } : null;
  } catch {
    return null;
  }
}

/**
 * The extra height the user chose, re-applied to today's natural height: the panel keeps its
 * chosen growth when its content (and so its natural height) changes.
 */
export function restoredBottom(stored: StoredBottom, natural: number, windowHeight: number): number {
  return clampBottom(natural + (stored.height - stored.natural), natural, windowHeight);
}
