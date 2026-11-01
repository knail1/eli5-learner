import { act, createElement, useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flush, key, loadRenderer, render } from './harness';

/** Resizable bottom panel (11 §5.1). */

const rule = await loadRenderer<{
  BOTTOM_PANEL_KEY: string;
  bottomCap(natural: number, windowHeight: number): number;
  clampBottom(requested: number, natural: number, windowHeight: number): number;
  bottomPosition(height: number, natural: number, windowHeight: number): number;
  parseStoredBottom(raw: string | null): { height: number; natural: number } | null;
  restoredBottom(s: { height: number; natural: number }, natural: number, windowHeight: number): number;
}>('layout/bottom-panel.ts');
const { BottomHandle, useBottomPanel } = await loadRenderer<{
  BottomHandle: (p: { panel: unknown }) => unknown;
  useBottomPanel: (row: { current: HTMLElement | null }) => { height: number | null; natural: number };
}>('layout/BottomPanel.tsx');

describe('height rule (pure)', () => {
  it.each([
    // requested, natural, window: clamped
    [100, 200, 1000, 200], // below natural
    [200, 200, 1000, 200], // at natural
    [333.4, 200, 1000, 333], // between: rounded to whole pixels
    [400, 200, 1000, 400], // at twice natural
    [900, 200, 1000, 400], // above: twice natural is the smaller cap
    [900, 200, 450, 360], // 80% of a short window is the smaller cap
    [900, 200, 200, 200], // tiny window: no room to grow
    [50, 200, 100, 200], // tiny window: never below natural
  ])('clampBottom(%d, natural %d, window %d) = %d', (req, natural, win, want) => {
    expect(rule.clampBottom(req, natural, win)).toBe(want);
  });

  it('position: 0 at natural, 100 at the cap, linear between, 0 with no room', () => {
    expect(rule.bottomPosition(200, 200, 1000)).toBe(0);
    expect(rule.bottomPosition(300, 200, 1000)).toBe(50);
    expect(rule.bottomPosition(400, 200, 1000)).toBe(100);
    expect(rule.bottomPosition(999, 200, 1000)).toBe(100);
    expect(rule.bottomPosition(250, 200, 200)).toBe(0);
  });

  it('stored values: missing, malformed or non-positive values are ignored', () => {
    expect(rule.parseStoredBottom(null)).toBeNull();
    expect(rule.parseStoredBottom('not json')).toBeNull();
    expect(rule.parseStoredBottom('[]')).toBeNull();
    expect(rule.parseStoredBottom('{"height":300}')).toBeNull();
    expect(rule.parseStoredBottom('{"height":-1,"natural":200}')).toBeNull();
    expect(rule.parseStoredBottom('{"height":300,"natural":0}')).toBeNull();
    expect(rule.parseStoredBottom('{"height":"300","natural":200}')).toBeNull();
    expect(rule.parseStoredBottom('{"height":300,"natural":200}')).toEqual({ height: 300, natural: 200 });
  });

  it('a restored height keeps its growth over a changed natural height, within the limits', () => {
    expect(rule.restoredBottom({ height: 300, natural: 200 }, 220, 1000)).toBe(320);
    expect(rule.restoredBottom({ height: 400, natural: 200 }, 300, 600)).toBe(480);
  });
});

describe('BottomHandle (11 §5.1)', () => {
  const NATURAL = 120;
  beforeEach(() => {
    window.localStorage.clear();
    // jsdom has no layout: every element's content ends 120 px below its top.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: NATURAL,
      left: 0,
      right: 0,
      width: 0,
      height: NATURAL,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
  });

  let panel: { height: number | null; natural: number } = { height: null, natural: 0 };
  function Harness() {
    const row = useRef<HTMLDivElement>(null);
    const p = useBottomPanel(row);
    panel = p;
    return createElement(
      'div',
      null,
      createElement(BottomHandle as never, { panel: p }),
      createElement(
        'div',
        { ref: row, className: 'bottom-row' },
        createElement('div', null, createElement('form', null, createElement('p', null, 'zone'))),
      ),
    );
  }
  const handle = (host: HTMLElement) => host.querySelector<HTMLElement>('[role="separator"]')!;

  it('is a keyboard-focusable separator valued 0 to 100; arrows step 16 px', async () => {
    const host = await render(Harness as never);
    const h = handle(host);
    expect(h.tabIndex).toBe(0);
    expect(h.getAttribute('aria-orientation')).toBe('horizontal');
    expect(panel.natural).toBe(NATURAL);
    expect(h.getAttribute('aria-valuenow')).toBe('0');
    await key(h, 'ArrowUp');
    expect(panel.height).toBe(NATURAL + 16);
    expect(h.getAttribute('aria-valuenow')).toBe(String(Math.round((100 * 16) / NATURAL)));
    await key(h, 'ArrowDown');
    await key(h, 'ArrowDown');
    expect(panel.height).toBe(NATURAL);
    for (let i = 0; i < 20; i++) await key(h, 'ArrowUp');
    expect(panel.height).toBe(NATURAL * 2);
    expect(h.getAttribute('aria-valuenow')).toBe('100');
  });

  it('double-click resets to natural; the chosen height persists and survives a reload', async () => {
    let host = await render(Harness as never);
    await key(handle(host), 'ArrowUp');
    await key(handle(host), 'ArrowUp');
    expect(JSON.parse(window.localStorage.getItem(rule.BOTTOM_PANEL_KEY) ?? 'null')).toEqual({
      height: NATURAL + 32,
      natural: NATURAL,
    });
    host.remove();
    host = await render(Harness as never);
    await flush();
    expect(panel.height).toBe(NATURAL + 32);
    await act(async () => handle(host).dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(panel.height).toBeNull();
    expect(window.localStorage.getItem(rule.BOTTOM_PANEL_KEY)).toBeNull();
  });

  it('bad stored data is ignored', async () => {
    window.localStorage.setItem(rule.BOTTOM_PANEL_KEY, '{"height":-5,"natural":120}');
    await render(Harness as never);
    expect(panel.height).toBeNull();
  });
});
