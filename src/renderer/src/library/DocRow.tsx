import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { CatalogEntry } from '../../../preload/contract';
import { matchLibraryKey } from '../a11y/shortcuts';
import { relativeDate } from './order';
import {
  SWIPE,
  classifyDrag,
  clampOffset,
  restingOffset,
  sideOf,
  swipeOutcome,
  wheelStep,
  type SwipeSide,
} from './swipe';

/**
 * One Library row (11 §5.2). Click or Enter opens it. A two-finger horizontal swipe or a
 * horizontal pointer drag slides it: left reveals Archive, right reveals Trash; far enough commits,
 * a short swipe leaves the action button showing (Escape or a click elsewhere closes it). A
 * vertical pointer drag picks the row up to drop on a folder, the Archive or the Trash.
 */

export interface DocRowProps {
  entry: CatalogEntry;
  selected: boolean;
  fresh: boolean;
  /** The row whose swipe is open; any other row closes. */
  swipeOpen: boolean;
  onSwipeOpen(open: boolean): void;
  onOpen(): void;
  onContextMenu(): void;
  /** Archive, or Trash for a right swipe or Cmd+Backspace. Resolves false when the move failed. */
  onAction(side: SwipeSide): Promise<boolean>;
  onDragStart(): void;
  onDragMove(x: number, y: number): void;
  onDragEnd(drop: boolean): void;
  error?: string;
}

const reducedMotion = (): boolean => {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
};

/** How long a committed row takes to slide out before the move (0 under reduced motion). */
const COMMIT_SLIDE_MS = 160;

export function DocRow(p: DocRowProps) {
  const rowRef = useRef<HTMLLIElement>(null);
  const [offset, setOffsetState] = useState(0);
  const [animate, setAnimate] = useState(false);
  const offsetRef = useRef(0);
  const setOffset = (v: number, smooth: boolean) => {
    offsetRef.current = v;
    setAnimate(smooth);
    setOffsetState(v);
  };
  const props = useRef(p);
  props.current = p;
  const width = () => rowRef.current?.clientWidth || 240;

  // A pointer press: undecided, a horizontal swipe, or a drag to a folder.
  const press = useRef<{ id: number; x: number; y: number; base: number; mode: 'swipe' | 'drag' | null } | null>(null);
  const suppressClick = useRef(false);
  const wheel = useRef({ tracking: false, timer: 0 as ReturnType<typeof setTimeout> | 0, lockUntil: 0 });

  const commit = async (side: SwipeSide) => {
    const w = width();
    setOffset(restingOffset({ kind: 'commit', side }, w), true);
    const wait = reducedMotion() ? 0 : COMMIT_SLIDE_MS;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const ok = await props.current.onAction(side);
    // On success the row leaves this list (or remounts in another group); on failure it comes back.
    if (!ok && rowRef.current) setOffset(0, true);
    props.current.onSwipeOpen(false);
  };

  const settle = () => {
    const w = width();
    const o = swipeOutcome(offsetRef.current, w);
    if (o.kind === 'commit') {
      void commit(o.side);
      return;
    }
    setOffset(restingOffset(o, w), true);
    props.current.onSwipeOpen(o.kind === 'reveal');
  };

  // Another row opened, or the list asked every row to close.
  useEffect(() => {
    if (!p.swipeOpen && offsetRef.current !== 0 && !press.current && !wheel.current.tracking) setOffset(0, true);
  }, [p.swipeOpen]);

  // Escape or a press outside closes an open row.
  useEffect(() => {
    if (!p.swipeOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setOffset(0, true);
      props.current.onSwipeOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (rowRef.current && e.target instanceof Node && rowRef.current.contains(e.target)) return;
      setOffset(0, true);
      props.current.onSwipeOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [p.swipeOpen]);

  // Two-finger trackpad swipe: horizontal wheel deltas. Non-passive so the list does not scroll sideways.
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const g = wheel.current;
    const onWheel = (e: WheelEvent) => {
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (!g.tracking && Date.now() < g.lockUntil) {
        if (horizontal) e.preventDefault();
        return;
      }
      const next = wheelStep(offsetRef.current, e, width(), g.tracking);
      if (next === null) return;
      e.preventDefault();
      if (!g.tracking) props.current.onSwipeOpen(true);
      g.tracking = true;
      setOffset(next, false);
      if (g.timer) clearTimeout(g.timer);
      g.timer = setTimeout(() => {
        g.tracking = false;
        g.timer = 0;
        g.lockUntil = Date.now() + SWIPE.wheelLockoutMs;
        settle();
      }, SWIPE.wheelSettleMs);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (g.timer) clearTimeout(g.timer);
    };
  }, []);

  // A press is followed on the window, not with pointer capture, so the pointer may leave the row
  // (a drag to a folder) and the row may re-render or move without losing the gesture.
  const detach = useRef<(() => void) | null>(null);
  useEffect(() => () => detach.current?.(), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || e.ctrlKey) return;
    detach.current?.();
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, base: offsetRef.current, mode: null };
    const move = (ev: PointerEvent) => onPointerMove(ev);
    const up = (ev: PointerEvent) => endPress(ev, false);
    const cancel = (ev: PointerEvent) => endPress(ev, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    detach.current = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      detach.current = null;
    };
  };

  const onPointerMove = (e: PointerEvent) => {
    const s = press.current;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (s.mode === null) {
      s.mode = classifyDrag(dx, dy);
      if (s.mode === null) return;
      if (s.mode === 'swipe') props.current.onSwipeOpen(true);
      else props.current.onDragStart();
    }
    e.preventDefault();
    if (s.mode === 'swipe') setOffset(clampOffset(s.base + dx, width()), false);
    else props.current.onDragMove(e.clientX, e.clientY);
  };

  const endPress = (e: PointerEvent, cancelled: boolean) => {
    const s = press.current;
    if (!s || s.id !== e.pointerId) return;
    press.current = null;
    detach.current?.();
    if (s.mode === null) return;
    suppressClick.current = true;
    // A click only follows a pointerup on the row; clear the flag if none comes.
    setTimeout(() => (suppressClick.current = false), 0);
    if (s.mode === 'drag') props.current.onDragEnd(!cancelled);
    else if (cancelled) setOffset(0, true);
    else settle();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      p.onContextMenu();
    } else if (matchLibraryKey(e) === 'trash') {
      e.preventDefault();
      void p.onAction('trash');
    }
  };

  const side = sideOf(offset);
  const revealed = side;
  const e = p.entry;
  const cls = ['doc-row', p.fresh ? 'fresh' : '', side ? `swiping-${side}` : ''].filter(Boolean).join(' ');
  return (
    <li ref={rowRef} className={cls} data-slug={e.topicSlug}>
      {revealed && (
        <div className={`swipe-action swipe-${revealed}`}>
          <button
            type="button"
            className={`swipe-button swipe-${revealed}`}
            tabIndex={p.swipeOpen ? 0 : -1}
            onClick={() => void commit(revealed)}
          >
            {revealed === 'archive' ? 'Archive' : 'Move to Trash'}
          </button>
        </div>
      )}
      <button
        type="button"
        className={`library-item${animate ? ' settling' : ''}`}
        style={offset ? { transform: `translateX(${offset}px)` } : undefined}
        aria-current={p.selected ? 'page' : undefined}
        aria-description={e.summary || undefined}
        title={e.summary || undefined}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          if (offsetRef.current !== 0) {
            setOffset(0, true);
            p.onSwipeOpen(false);
            return;
          }
          p.onOpen();
        }}
        onContextMenu={(ev) => {
          ev.preventDefault();
          p.onContextMenu();
        }}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
      >
        <span className="item-title">{e.title}</span>
        <span className="item-date">{relativeDate(e.createdAt)}</span>
      </button>
      {p.error && (
        <p className="inline-error" role="status">
          {p.error}
        </p>
      )}
    </li>
  );
}
