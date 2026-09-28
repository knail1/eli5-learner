import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** View state persisted to <userData>/window-state.json (11 §3.1). Not Settings. */
export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const WINDOW_DEFAULTS = { width: 1280, height: 820, minWidth: 900, minHeight: 600 } as const;
export const SIDEBAR_DEFAULT = 272;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 420;
/** Minimum visible overlap with a display's work area (11 §3.1). */
const MIN_VISIBLE = 100;

export const DEFAULT_WINDOW_STATE: WindowState = {
  width: WINDOW_DEFAULTS.width,
  height: WINDOW_DEFAULTS.height,
  maximized: false,
  sidebarWidth: SIDEBAR_DEFAULT,
  sidebarCollapsed: false,
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

const StateSchema = z.object({
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  width: z.number().finite(),
  height: z.number().finite(),
  maximized: z.boolean().default(false),
  sidebarWidth: z.number().finite().default(SIDEBAR_DEFAULT),
  sidebarCollapsed: z.boolean().default(false),
});

/** Parses and clamps a stored state; anything malformed yields the defaults. */
export function parseWindowState(raw: unknown): WindowState {
  const r = StateSchema.safeParse(raw);
  if (!r.success) return { ...DEFAULT_WINDOW_STATE };
  const s = r.data;
  const out: WindowState = {
    width: Math.round(Math.max(WINDOW_DEFAULTS.minWidth, s.width)),
    height: Math.round(Math.max(WINDOW_DEFAULTS.minHeight, s.height)),
    maximized: s.maximized,
    sidebarWidth: Math.round(clamp(s.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX)),
    sidebarCollapsed: s.sidebarCollapsed,
  };
  if (s.x !== undefined && s.y !== undefined) {
    out.x = Math.round(s.x);
    out.y = Math.round(s.y);
  }
  return out;
}

function overlap(a: Rect, b: Rect): { w: number; h: number } {
  return {
    w: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    h: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/**
 * Keeps the saved rectangle only if it overlaps some display's work area by at least 100×100;
 * otherwise the default size centred on the primary display (11 §3.1).
 */
export function fitToDisplays(s: WindowState, workAreas: Rect[], primary: Rect): WindowState {
  if (s.x !== undefined && s.y !== undefined) {
    const rect = { x: s.x, y: s.y, width: s.width, height: s.height };
    const visible = workAreas.some((wa) => {
      const o = overlap(rect, wa);
      return o.w >= MIN_VISIBLE && o.h >= MIN_VISIBLE;
    });
    if (visible) return s;
  }
  const width = Math.min(WINDOW_DEFAULTS.width, primary.width);
  const height = Math.min(WINDOW_DEFAULTS.height, primary.height);
  return {
    ...s,
    width,
    height,
    x: Math.round(primary.x + (primary.width - width) / 2),
    y: Math.round(primary.y + (primary.height - height) / 2),
  };
}

export function windowStatePath(userData: string): string {
  return path.join(userData, 'window-state.json');
}

/** A missing or corrupt file is ignored; the next save overwrites it (11 §13). */
export function loadWindowState(file: string): WindowState {
  try {
    return parseWindowState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

/** Atomic write: temp file then rename. */
export function saveWindowState(file: string, s: WindowState): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, file);
}

/** Trailing debounce used for resize/move persistence (500 ms, 11 §3.1). */
export function debounce<A extends unknown[]>(
  fn: (...a: A) => void,
  ms: number,
): { (...a: A): void; flush(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | undefined;
  const run = (): void => {
    timer = undefined;
    if (pending) {
      const a = pending;
      pending = undefined;
      fn(...a);
    }
  };
  const d = (...a: A): void => {
    pending = a;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  d.flush = (): void => {
    if (timer) clearTimeout(timer);
    run();
  };
  d.cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  return d;
}
