/**
 * Swipe on a Library row (11 §5.2): a two-finger trackpad swipe (wheel deltaX) or a horizontal
 * pointer drag. Left (negative offset) reveals Archive on the right; right (positive) reveals Trash
 * on the left. Past the commit distance the action runs; a shorter swipe rests with the action
 * button showing; a tiny one closes. Pure, so the thresholds are unit tested.
 */

export const SWIPE = {
  /** Width of the revealed action button; a short swipe rests the row this far over. */
  actionWidth: 76,
  /** Below this the row closes again. */
  revealMin: 28,
  /** Commit at half the row width, and never under `commitMin` px. */
  commitFraction: 0.5,
  commitMin: 120,
  /** Pointer movement before a press becomes a swipe or a drag (a click moves less). */
  startSlop: 8,
  /** A wheel gesture ends after this long without events. */
  wheelSettleMs: 140,
  /** Momentum wheel events right after a gesture ends are ignored this long. */
  wheelLockoutMs: 350,
} as const;

export type SwipeSide = 'archive' | 'trash';
export type SwipeOutcome = { kind: 'commit' | 'reveal'; side: SwipeSide } | { kind: 'close' };

export const sideOf = (offset: number): SwipeSide | null => (offset < 0 ? 'archive' : offset > 0 ? 'trash' : null);

export function commitDistance(width: number): number {
  return Math.max(SWIPE.commitMin, width * SWIPE.commitFraction);
}

export function clampOffset(offset: number, width: number): number {
  const w = Math.max(width, SWIPE.actionWidth);
  return Math.max(-w, Math.min(w, offset));
}

/** What a released swipe does. */
export function swipeOutcome(offset: number, width: number): SwipeOutcome {
  const side = sideOf(offset);
  const d = Math.abs(offset);
  if (!side || d < SWIPE.revealMin) return { kind: 'close' };
  return d >= commitDistance(width) ? { kind: 'commit', side } : { kind: 'reveal', side };
}

/** Where the row comes to rest for an outcome (a commit slides fully out). */
export function restingOffset(o: SwipeOutcome, width: number): number {
  if (o.kind === 'close') return 0;
  const sign = o.side === 'archive' ? -1 : 1;
  return sign * (o.kind === 'reveal' ? SWIPE.actionWidth : Math.max(width, SWIPE.actionWidth));
}

/** A press that moved: a horizontal swipe, a move-to-folder drag, or still undecided (null). */
export function classifyDrag(dx: number, dy: number): 'swipe' | 'drag' | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < SWIPE.startSlop && ay < SWIPE.startSlop) return null;
  return ax > ay * 1.5 ? 'swipe' : 'drag';
}

/**
 * One wheel event. Not yet tracking: only a mostly horizontal event starts a swipe (null lets the
 * list scroll). Tracking: deltaX moves the row the opposite way, as content follows the fingers.
 */
export function wheelStep(
  offset: number,
  d: { deltaX: number; deltaY: number },
  width: number,
  tracking: boolean,
): number | null {
  if (!tracking && Math.abs(d.deltaX) <= Math.abs(d.deltaY)) return null;
  return clampOffset(offset - d.deltaX, width);
}
