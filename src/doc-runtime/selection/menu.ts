// Menu geometry (08 §5.2 step 6): pure, so it is testable without layout.

/** Below this viewport width the menu is full width minus 16 px. */
export const NARROW_WIDTH = 480;
const GAP = 8;
const MARGIN = 8;

export interface PlaceInput {
  /** Last client rect of the selection. */
  anchor: { left: number; top: number; bottom: number; width: number };
  menu: { width: number; height: number };
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  /** Bottom edge of the sticky tab bar in client coordinates. */
  tabbarBottom: number;
}

export interface Placement {
  /** Document coordinates, so the menu scrolls with the content. */
  left: number;
  top: number;
  /** Set on narrow viewports only. */
  width?: number;
  below: boolean;
}

/** Centred 8 px above the anchor; flipped below when it would hit the tab bar or the viewport top. */
export function placeMenu(o: PlaceInput): Placement {
  const narrow = o.viewport.width < NARROW_WIDTH;
  const width = narrow ? o.viewport.width - 2 * MARGIN : o.menu.width;
  const centre = o.anchor.left + o.anchor.width / 2;
  const maxLeft = Math.max(MARGIN, o.viewport.width - MARGIN - width);
  const left = narrow ? MARGIN : Math.min(maxLeft, Math.max(MARGIN, Math.round(centre - width / 2)));
  const aboveTop = o.anchor.top - GAP - o.menu.height;
  const below = aboveTop < Math.max(0, o.tabbarBottom);
  const top = below ? o.anchor.bottom + GAP : aboveTop;
  return {
    left: left + o.scroll.x,
    top: Math.round(top + o.scroll.y),
    ...(narrow ? { width } : {}),
    below,
  };
}
