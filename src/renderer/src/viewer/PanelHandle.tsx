/**
 * Keyboard `separator` that resizes a side column (11 §5.2, §5.7): arrow keys move `step` px and
 * pointer drag follows the cursor. `side` names where the panel sits: a left panel (the sidebar)
 * grows to the right, a right panel (Versions) grows to the left.
 */
export function PanelHandle(p: {
  side: 'left' | 'right';
  label: string;
  className: string;
  width: number;
  min: number;
  max: number;
  step: number;
  onChange(w: number): void;
}) {
  const sign = p.side === 'left' ? 1 : -1;
  return (
    <div
      className={p.className}
      role="separator"
      aria-orientation="vertical"
      aria-label={p.label}
      aria-valuenow={p.width}
      aria-valuemin={p.min}
      aria-valuemax={p.max}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          p.onChange(p.width + sign * (e.key === 'ArrowRight' ? p.step : -p.step));
        }
      }}
      onPointerDown={(e) => {
        const startX = e.clientX;
        const startW = p.width;
        const el = e.currentTarget;
        el.setPointerCapture?.(e.pointerId);
        const move = (ev: PointerEvent) => p.onChange(startW + sign * (ev.clientX - startX));
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
