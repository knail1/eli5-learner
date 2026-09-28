import { describe, expect, it, vi } from 'vitest';
import { installViewerKeyHandoff, viewerKeyAction, type ViewerKeyInput } from '../../../../src/main/shell/viewer-keys';

/** Viewer focus handoff (11 §9, §12): F6, Shift+F6 and Cmd+1…9 pressed in the viewer reach the app. */

const input = (key: string, mods: Partial<ViewerKeyInput> = {}): ViewerKeyInput => ({
  type: 'keyDown',
  key,
  shift: false,
  meta: false,
  control: false,
  alt: false,
  ...mods,
});

function harness() {
  let listener: ((e: { preventDefault(): void }, i: ViewerKeyInput) => void) | undefined;
  const viewer = {
    on: (event: 'before-input-event', fn: typeof listener) => {
      expect(event).toBe('before-input-event');
      listener = fn;
    },
  };
  const app = { focus: vi.fn(), sendInputEvent: vi.fn() };
  const cycleRegion = vi.fn();
  installViewerKeyHandoff(viewer, () => app, cycleRegion);
  const press = (i: ViewerKeyInput): boolean => {
    const e = { preventDefault: vi.fn() };
    listener?.(e, i);
    return e.preventDefault.mock.calls.length > 0;
  };
  return { app, cycleRegion, press };
}

describe('viewerKeyAction', () => {
  it('maps F6 and Shift+F6 to region cycling and Cmd+1…9 to the nth document', () => {
    expect(viewerKeyAction(input('F6'))).toEqual({ kind: 'region', dir: 1 });
    expect(viewerKeyAction(input('F6', { shift: true }))).toEqual({ kind: 'region', dir: -1 });
    expect(viewerKeyAction(input('3', { meta: true }))).toEqual({ kind: 'key', keyCode: '3' });
  });

  it('ignores key-ups, other keys and other modifier combinations', () => {
    expect(viewerKeyAction(input('F6', { type: 'keyUp' }))).toBeNull();
    expect(viewerKeyAction(input('F6', { meta: true }))).toBeNull();
    expect(viewerKeyAction(input('F6', { alt: true }))).toBeNull();
    expect(viewerKeyAction(input('0', { meta: true }))).toBeNull();
    expect(viewerKeyAction(input('3'))).toBeNull();
    expect(viewerKeyAction(input('3', { meta: true, shift: true }))).toBeNull();
    expect(viewerKeyAction(input('c', { meta: true }))).toBeNull();
    expect(viewerKeyAction(input('Tab'))).toBeNull();
  });
});

describe('installViewerKeyHandoff', () => {
  it('F6 in the viewer hands focus back to the app renderer and cycles on from the viewer', () => {
    const h = harness();
    expect(h.press(input('F6'))).toBe(true);
    expect(h.app.focus).toHaveBeenCalledTimes(1);
    expect(h.cycleRegion).toHaveBeenCalledWith(1);
    expect(h.press(input('F6', { shift: true }))).toBe(true);
    expect(h.cycleRegion).toHaveBeenLastCalledWith(-1);
    expect(h.app.sendInputEvent).not.toHaveBeenCalled();
  });

  it('Cmd+digit in the viewer is forwarded to the app renderer as the same key', () => {
    const h = harness();
    expect(h.press(input('2', { meta: true }))).toBe(true);
    expect(h.app.focus).toHaveBeenCalledTimes(1);
    expect(h.app.sendInputEvent.mock.calls).toEqual([
      [{ type: 'keyDown', keyCode: '2', modifiers: ['meta'] }],
      [{ type: 'keyUp', keyCode: '2', modifiers: ['meta'] }],
    ]);
    expect(h.cycleRegion).not.toHaveBeenCalled();
  });

  it('leaves every other key to the document', () => {
    const h = harness();
    expect(h.press(input('ArrowRight'))).toBe(false);
    expect(h.press(input('c', { meta: true }))).toBe(false);
    expect(h.app.focus).not.toHaveBeenCalled();
  });
});
