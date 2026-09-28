import { useEffect, useRef, type Ref } from 'react';
import type { ViewerBounds } from '../../../preload/contract';

/**
 * Placeholder rectangle for the native viewer (11 §5.1). The WebContentsView is layered above the
 * renderer, so this element only reports its rect: on mount, on ResizeObserver changes, after
 * window resize, and when the layout key (sidebar width/collapse) changes, at most once per frame.
 * Mounting attaches the viewer; unmounting (any non-doc route) detaches it.
 */
export function ViewerSlot(p: { slug: string; layoutKey: string; slotRef?: Ref<HTMLDivElement> }) {
  const el = useRef<HTMLDivElement | null>(null);
  const frame = useRef(0);

  const measure = (): ViewerBounds | null => {
    const node = el.current;
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  };

  const report = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const b = measure();
      if (b) void window.eli5.viewer.setBounds(b);
    });
  };

  useEffect(() => {
    const b = measure();
    if (b) void window.eli5.viewer.setBounds(b);
    void window.eli5.viewer.setVisible(true);
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(report);
    if (el.current) ro?.observe(el.current);
    window.addEventListener('resize', report);
    return () => {
      cancelAnimationFrame(frame.current);
      ro?.disconnect();
      window.removeEventListener('resize', report);
      void window.eli5.viewer.setVisible(false);
    };
    // Mount-only: report/measure read refs.
  }, []);

  useEffect(() => {
    report();
  }, [p.layoutKey, p.slug]);

  return (
    <div
      ref={(node) => {
        el.current = node;
        if (typeof p.slotRef === 'function') p.slotRef(node);
        else if (p.slotRef) p.slotRef.current = node;
      }}
      className="viewer-slot"
      data-testid="viewer-slot"
      tabIndex={-1}
      aria-label="Document"
    />
  );
}
