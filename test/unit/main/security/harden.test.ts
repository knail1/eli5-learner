import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** hardenApp's per-webContents guards (12 §7.2, §9): WebRTC IP policy and viewer subframe rule. */

const appEvents = new EventEmitter();
vi.mock('electron', () => ({
  app: {
    enableSandbox: vi.fn(),
    on: (name: string, fn: (...a: unknown[]) => void) => appEvents.on(name, fn),
    whenReady: () => Promise.resolve(),
    isPackaged: false,
  },
  session: {
    defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn() },
  },
  shell: { openExternal: vi.fn() },
}));

const { hardenApp, isViewerSubframeNavigationAllowed, registerSurface } =
  await import('../../../../src/main/security/harden');

let nextId = 1;
function fakeWebContents() {
  const ev = new EventEmitter();
  const mainFrame = { name: 'main' };
  const wc = Object.assign(ev, {
    id: nextId++,
    mainFrame,
    setWebRTCIPHandlingPolicy: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    closeDevTools: vi.fn(),
  });
  return wc;
}
type FakeWc = ReturnType<typeof fakeWebContents>;

function frameNav(wc: FakeWc, url: string, parent: unknown, isMainFrame = false): boolean {
  const preventDefault = vi.fn();
  wc.emit('will-frame-navigate', { url, isMainFrame, frame: { parent }, preventDefault });
  return preventDefault.mock.calls.length === 0;
}

describe('hardenApp per-webContents guards', () => {
  let wc: FakeWc;
  beforeEach(() => {
    appEvents.removeAllListeners();
    hardenApp();
    wc = fakeWebContents();
    appEvents.emit('web-contents-created', {}, wc);
  });

  it('turns off non-proxied WebRTC UDP on every webContents (12 §9)', () => {
    expect(wc.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp');
    const other = fakeWebContents();
    appEvents.emit('web-contents-created', {}, other);
    expect(other.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp');
  });

  it('lets a viewer load only about:srcdoc, only in a direct child frame (07 §7.1)', () => {
    registerSurface(wc as never, 'viewer', () => true);
    expect(frameNav(wc, 'about:srcdoc', wc.mainFrame)).toBe(true);
    // A grandchild (a frame the animation itself made) cannot load even a srcdoc.
    expect(frameNav(wc, 'about:srcdoc', { name: 'child' })).toBe(false);
    // Any other target in a direct child is denied, even one the viewer's main frame may navigate to.
    for (const url of ['https://x.example/', 'data:text/html,x', 'about:blank', 'file:///etc/hosts'])
      expect(frameNav(wc, url, wc.mainFrame), url).toBe(false);
    // The main frame is left to will-navigate.
    expect(frameNav(wc, 'https://x.example/', null, true)).toBe(true);
  });

  it('other surfaces use their own navigation allowlist for subframes', () => {
    registerSurface(wc as never, 'app', (u) => u.protocol === 'app:');
    expect(frameNav(wc, 'app://bundle/x.html', wc.mainFrame)).toBe(true);
    expect(frameNav(wc, 'about:srcdoc', wc.mainFrame)).toBe(false);
  });

  it('isViewerSubframeNavigationAllowed is exact', () => {
    expect(isViewerSubframeNavigationAllowed('about:srcdoc', true)).toBe(true);
    expect(isViewerSubframeNavigationAllowed('about:srcdoc', false)).toBe(false);
    expect(isViewerSubframeNavigationAllowed('about:srcdoc#x', true)).toBe(false);
    expect(isViewerSubframeNavigationAllowed('about:blank', true)).toBe(false);
  });
});
