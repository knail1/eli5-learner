import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WINDOW_STATE,
  debounce,
  fitToDisplays,
  loadWindowState,
  parseWindowState,
  saveWindowState,
  windowStatePath,
} from '../../../../src/main/shell/window-state';

const primary = { x: 0, y: 25, width: 1440, height: 875 };

describe('parseWindowState (11 §3.1)', () => {
  it('defaults on garbage', () => {
    expect(parseWindowState(null)).toEqual(DEFAULT_WINDOW_STATE);
    expect(parseWindowState({ width: 'wide' })).toEqual(DEFAULT_WINDOW_STATE);
  });

  it('enforces minimum size and clamps the sidebar to 200..420', () => {
    const s = parseWindowState({ x: 10, y: 20, width: 300, height: 100, sidebarWidth: 999 });
    expect(s).toMatchObject({ x: 10, y: 20, width: 900, height: 600, sidebarWidth: 420, maximized: false });
    expect(parseWindowState({ width: 1000, height: 700, sidebarWidth: 10 }).sidebarWidth).toBe(200);
  });
});

describe('fitToDisplays', () => {
  it('keeps a rectangle that is visible on some display', () => {
    const s = { ...DEFAULT_WINDOW_STATE, x: 100, y: 100 };
    expect(fitToDisplays(s, [primary], primary)).toBe(s);
  });

  it('keeps a window on a secondary display', () => {
    const second = { x: 1440, y: 0, width: 1920, height: 1080 };
    const s = { ...DEFAULT_WINDOW_STATE, x: 1600, y: 100 };
    expect(fitToDisplays(s, [primary, second], primary)).toBe(s);
  });

  it('recentres when less than 100×100 px is visible (disconnected display)', () => {
    const s = { ...DEFAULT_WINDOW_STATE, x: 1400, y: 100 };
    const r = fitToDisplays(s, [primary], primary);
    expect(r).toMatchObject({ width: 1280, height: 820, x: 80, y: 53 });
  });

  it('centres a first launch and fits small screens', () => {
    const small = { x: 0, y: 0, width: 1024, height: 700 };
    expect(fitToDisplays(DEFAULT_WINDOW_STATE, [small], small)).toMatchObject({ x: 0, y: 0, width: 1024, height: 700 });
  });
});

describe('load/save', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('round-trips and ignores a corrupt file', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'eli5-ws-'));
    const file = windowStatePath(dir);
    expect(loadWindowState(file)).toEqual(DEFAULT_WINDOW_STATE);
    await writeFile(file, '{not json');
    expect(loadWindowState(file)).toEqual(DEFAULT_WINDOW_STATE);
    const s = { ...DEFAULT_WINDOW_STATE, x: 5, y: 6, maximized: true };
    saveWindowState(file, s);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(s);
    expect(loadWindowState(file)).toEqual(s);
  });
});

describe('debounce', () => {
  it('coalesces calls and flushes on demand', () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const d = debounce(fn, 500);
      d(1);
      d(2);
      vi.advanceTimersByTime(499);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledExactlyOnceWith(2);
      d(3);
      d.flush();
      expect(fn).toHaveBeenLastCalledWith(3);
      d.flush();
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
