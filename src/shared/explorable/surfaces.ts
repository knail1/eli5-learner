// Fixed loss surfaces for the gradient-descent explorable (07 §7.1). The model chooses only the
// family and its scale; no expression is ever parsed. Pure math: no DOM or Node imports.

export const SURFACES = ['bowl', 'ravine', 'double-well', 'plateau'] as const;
export type Surface = (typeof SURFACES)[number];

/** f(x) for surface `s` with curvature `k`. */
export function loss(s: Surface, k: number, x: number): number {
  switch (s) {
    case 'bowl':
      return (k / 2) * x * x;
    case 'ravine':
      return (k / 2) * x * x + 0.075 * k * (1 - Math.cos(4 * x));
    case 'double-well': {
      const d = x * x - 4;
      return (k / 16) * d * d;
    }
    case 'plateau':
      return 4 * k * (1 - Math.exp((-x * x) / 4));
  }
}

/** f'(x), analytic. */
export function slope(s: Surface, k: number, x: number): number {
  switch (s) {
    case 'bowl':
      return k * x;
    case 'ravine':
      return k * x + 0.3 * k * Math.sin(4 * x);
    case 'double-well':
      return (k / 4) * x * (x * x - 4);
    case 'plateau':
      return 2 * k * x * Math.exp((-x * x) / 4);
  }
}

/** The minima of each surface (the ravine's ripples add no local minima: x + 0.3 sin 4x = 0 only at 0). */
export function minima(s: Surface): readonly number[] {
  return s === 'double-well' ? [-2, 2] : [0];
}

/** The minimum nearest to `x`. */
export function nearestMinimum(s: Surface, x: number): number {
  let best = 0;
  let d = Infinity;
  for (const m of minima(s)) {
    if (Math.abs(x - m) < d) {
      d = Math.abs(x - m);
      best = m;
    }
  }
  return best;
}
