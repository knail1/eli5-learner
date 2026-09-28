// Highlight-note layout (07 §7.2 rule 6). A note never shares space with marks or labels: it sits
// in a band reserved for it (above the plot, under the highlighted horizontal bar, or under a pie)
// and a leader line runs through empty space to the highlighted mark.
import { CHART_WIDTH, el, escSvg, r2, textWidth, truncate } from './common';

/** Band reserved above the plot for the note; the plot starts this far below the band's top. */
export const NOTE_ROW = 40;
/** Extra space under the highlighted row of a horizontal bar chart (and under a pie). */
export const NOTE_BELOW = 22;
const NOTE_MAX_CHARS = 60;
const MARGIN = 4;

/** Truncates the note to fit `maxWidth` at the chart font size (and to 60 characters). */
export function fitNote(note: string, maxWidth: number): string {
  const fit = Math.floor(maxWidth / textWidth('x', 12));
  return truncate(note, Math.max(4, Math.min(NOTE_MAX_CHARS, fit)));
}

function group(leader: string, x: number, y: number, text: string, anchor?: 'middle'): string {
  return el(
    'g',
    [['class', 'viz-annotation']],
    leader +
      el(
        'text',
        [
          ['x', r2(x)],
          ['y', r2(y)],
          ['text-anchor', anchor],
          ['class', 'viz-ink viz-note'],
        ],
        escSvg(text),
      ),
  );
}

function leaderLine(x1: number, y1: number, x2: number, y2: number): string {
  return el('line', [
    ['x1', r2(x1)],
    ['x2', r2(x2)],
    ['y1', r2(y1)],
    ['y2', r2(y2)],
    ['class', 'viz-leader'],
  ]);
}

/**
 * Note in the reserved band whose top is `rowTop` (the plot starts at rowTop + NOTE_ROW). The text
 * is centered on `x` where it fits; the leader drops from under the text to `targetY`, which the
 * caller sets above every mark and value label at `x`.
 */
export function noteAbove(note: string, x: number, rowTop: number, targetY: number): string {
  const text = fitNote(note, CHART_WIDTH - 2 * MARGIN);
  const w = textWidth(text, 12);
  const baseline = rowTop + 12;
  const tx = Math.max(MARGIN, Math.min(x - w / 2, CHART_WIDTH - w - MARGIN));
  const y1 = baseline + 5;
  return group(targetY > y1 ? leaderLine(x, y1, x, targetY) : '', tx, baseline, text);
}

/**
 * Note in the space reserved under a horizontal bar row (bottom edge `rowBottom`): a short leader
 * drops from the bar at `barStart`, and the text starts beside it. When the text does not fit to
 * the right of the leader (a bar near the right edge, e.g. negative values), it moves left, but not
 * past `plotStart`, and the leader stops above it. Returns the text's horizontal extent so the
 * caller can keep the zero axis out of it.
 */
export function noteBelow(
  note: string,
  barStart: number,
  rowBottom: number,
  plotStart: number,
): { svg: string; x0: number; x1: number } {
  const lx = barStart + 2;
  const right = CHART_WIDTH - MARGIN;
  // Fitted to the widest start; either position below leaves it that much room.
  const text = fitNote(note, right - Math.min(plotStart, lx + 6));
  const w = textWidth(text, 12);
  const beside = lx + 6 + w <= right;
  const tx = beside ? lx + 6 : Math.max(plotStart, right - w);
  const baseline = rowBottom + 16;
  const svg = group(leaderLine(lx, rowBottom, lx, baseline - (beside ? 4 : 12)), tx, baseline, text);
  return { svg, x0: tx, x1: tx + w };
}

/** Centered note under a pie (no leader: it would cross the slices). */
export function noteUnder(note: string, cx: number, top: number): string {
  const text = fitNote(note, CHART_WIDTH - 2 * MARGIN);
  return group('', cx, top + 12, text, 'middle');
}
