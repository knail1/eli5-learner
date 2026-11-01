import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import {
  BOTTOM_PANEL_KEY,
  BOTTOM_STEP_PX,
  bottomPosition,
  clampBottom,
  parseStoredBottom,
  restoredBottom,
} from './bottom-panel';

/** The auto-sized bottom row is capped at this share of the window by CSS (.bottom-row max-height). */
const NATURAL_MAX_SHARE = 0.45;

/** Height of an element's content, even when the element itself is stretched (min-height: 100%). */
function contentHeight(root: Element): number {
  const top = root.getBoundingClientRect().top;
  let bottom = top;
  for (const c of Array.from(root.children)) bottom = Math.max(bottom, c.getBoundingClientRect().bottom);
  const s = getComputedStyle(root);
  return bottom - top + (parseFloat(s.paddingBottom) || 0) + (parseFloat(s.borderBottomWidth) || 0);
}

/** The height the row would take on its own: its tallest region's content, as the CSS caps it. */
function measureNatural(row: HTMLElement): number {
  let h = 0;
  for (const region of Array.from(row.children)) {
    const root = region.firstElementChild;
    if (root) h = Math.max(h, contentHeight(root));
  }
  const border = parseFloat(getComputedStyle(row).borderTopWidth) || 0;
  return Math.round(Math.min(h, window.innerHeight * NATURAL_MAX_SHARE) + border);
}

function store(height: number | null, natural: number): void {
  try {
    if (height === null) window.localStorage.removeItem(BOTTOM_PANEL_KEY);
    else window.localStorage.setItem(BOTTOM_PANEL_KEY, JSON.stringify({ height, natural }));
  } catch {
    // per-viewer convenience only
  }
}

export interface BottomPanel {
  /** The chosen height, or null for the natural (auto) height. */
  height: number | null;
  natural: number;
  /** Requests a height; it is clamped (11 §5.1) and persisted. */
  set(requested: number): void;
  /** Back to the natural height (double-click). */
  reset(): void;
}

/** Owns the bottom row's height: measured natural height, clamping, and persistence (11 §5.1). */
export function useBottomPanel(row: RefObject<HTMLElement | null>): BottomPanel {
  const [natural, setNatural] = useState(0);
  const [height, setHeight] = useState<number | null>(null);
  const [restored, setRestored] = useState(false);

  // Track the natural height as content and the window change.
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => setNatural(measureNatural(el));
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    for (const region of Array.from(el.children)) {
      ro?.observe(region);
      const root = region.firstElementChild;
      if (root) ro?.observe(root);
    }
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [row]);

  // Restore once the natural height is known; bad stored data is ignored.
  useEffect(() => {
    if (restored || natural <= 0) return;
    setRestored(true);
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(BOTTOM_PANEL_KEY);
    } catch {
      // per-viewer convenience only
    }
    const stored = parseStoredBottom(raw);
    if (stored) setHeight(restoredBottom(stored, natural, window.innerHeight));
  }, [natural, restored]);

  // Keep a chosen height inside the limits when the window or the content changes.
  useEffect(() => {
    if (height === null || natural <= 0) return;
    const c = clampBottom(height, natural, window.innerHeight);
    if (c !== height) setHeight(c);
  }, [height, natural]);

  const set = useCallback(
    (requested: number) => {
      if (natural <= 0) return;
      const h = clampBottom(requested, natural, window.innerHeight);
      setHeight(h);
      store(h, natural);
    },
    [natural],
  );
  const reset = useCallback(() => {
    setHeight(null);
    store(null, natural);
  }, [natural]);
  return { height, natural, set, reset };
}

/**
 * The line above the input zone and status area: a keyboard-focusable separator (11 §5.1).
 * Drag up grows, down shrinks; Arrow Up / Down step 16 px; double-click resets.
 */
export function BottomHandle(p: { panel: BottomPanel }) {
  const { panel } = p;
  const current = panel.height ?? panel.natural;
  const value = bottomPosition(current, panel.natural, window.innerHeight);
  return (
    <div
      className="bottom-handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize input panel"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          panel.set(current + (e.key === 'ArrowUp' ? BOTTOM_STEP_PX : -BOTTOM_STEP_PX));
        }
      }}
      onDoubleClick={panel.reset}
      onPointerDown={(e) => {
        const startY = e.clientY;
        const startH = current;
        const el = e.currentTarget;
        // Capture keeps the drag when the pointer crosses the native viewer layer.
        el.setPointerCapture?.(e.pointerId);
        const move = (ev: PointerEvent) => panel.set(startH - (ev.clientY - startY));
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
    />
  );
}
