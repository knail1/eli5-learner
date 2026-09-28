/**
 * Viewer focus handoff (11 §9, §12). While the document viewer has focus its keys never reach the
 * app renderer, so main watches the viewer's `before-input-event`: F6 / Shift+F6 return focus to
 * the app and cycle on from the viewer region, and Cmd+1…9 are forwarded like menu shortcuts.
 * Every other key stays with the document.
 */

/** The fields of Electron's `Input` that the handoff reads. */
export interface ViewerKeyInput {
  type: string;
  key: string;
  shift: boolean;
  meta: boolean;
  control: boolean;
  alt: boolean;
}

export type ViewerKeyAction = { kind: 'region'; dir: 1 | -1 } | { kind: 'key'; keyCode: string };

export function viewerKeyAction(i: ViewerKeyInput): ViewerKeyAction | null {
  if (i.type !== 'keyDown' || i.control || i.alt) return null;
  if (i.key === 'F6' && !i.meta) return { kind: 'region', dir: i.shift ? -1 : 1 };
  if (i.meta && !i.shift && /^[1-9]$/.test(i.key)) return { kind: 'key', keyCode: i.key };
  return null;
}

export interface ViewerKeySource {
  on(event: 'before-input-event', fn: (e: { preventDefault(): void }, input: ViewerKeyInput) => void): unknown;
}

export interface AppKeyTarget {
  focus(): void;
  sendInputEvent(e: { type: 'keyDown' | 'keyUp'; keyCode: string; modifiers: 'meta'[] }): void;
}

export function installViewerKeyHandoff(
  viewer: ViewerKeySource,
  app: () => AppKeyTarget | undefined,
  cycleRegion: (dir: 1 | -1) => void,
): void {
  viewer.on('before-input-event', (e, input) => {
    const action = viewerKeyAction(input);
    const target = action ? app() : undefined;
    if (!action || !target) return;
    e.preventDefault();
    target.focus();
    if (action.kind === 'region') {
      cycleRegion(action.dir);
      return;
    }
    target.sendInputEvent({ type: 'keyDown', keyCode: action.keyCode, modifiers: ['meta'] });
    target.sendInputEvent({ type: 'keyUp', keyCode: action.keyCode, modifiers: ['meta'] });
  });
}
