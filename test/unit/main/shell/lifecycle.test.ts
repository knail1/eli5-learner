import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeAction,
  crashTracker,
  installLifecycle,
  quitApp,
  shell,
  type LifecycleApp,
} from '../../../../src/main/shell/lifecycle';

type Ev = Parameters<LifecycleApp['on']>[0];

function fakeApp(lock = true) {
  const listeners = new Map<Ev, (() => void)[]>();
  const a = {
    requestSingleInstanceLock: vi.fn(() => lock),
    quit: vi.fn(),
    on: vi.fn((ev: Ev, l: () => void) => {
      listeners.set(ev, [...(listeners.get(ev) ?? []), l]);
      return a;
    }),
    emit: (ev: Ev) => listeners.get(ev)?.forEach((l) => l()),
    has: (ev: Ev) => (listeners.get(ev)?.length ?? 0) > 0,
  };
  return a;
}

afterEach(() => {
  shell.isQuitting = false;
});

describe('installLifecycle (11 §3.2)', () => {
  it('exits when another instance holds the lock', () => {
    const a = fakeApp(false);
    expect(installLifecycle(a, () => {})).toBe(false);
    expect(a.quit).toHaveBeenCalledOnce();
    expect(a.on).not.toHaveBeenCalled();
  });

  it('shows the window on second-instance and activate', () => {
    const a = fakeApp();
    const show = vi.fn();
    expect(installLifecycle(a, show)).toBe(true);
    a.emit('second-instance');
    a.emit('activate');
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('keeps an empty window-all-closed handler so the app never auto-quits', () => {
    const a = fakeApp();
    installLifecycle(a, () => {});
    expect(a.has('window-all-closed')).toBe(true);
    a.emit('window-all-closed');
    expect(a.quit).not.toHaveBeenCalled();
  });

  it('before-quit sets isQuitting and never blocks', () => {
    const a = fakeApp();
    installLifecycle(a, () => {});
    expect(shell.isQuitting).toBe(false);
    a.emit('before-quit');
    expect(shell.isQuitting).toBe(true);
  });
});

describe('quitApp', () => {
  it('sets the flag before quitting, without confirmation', () => {
    const quit = vi.fn(() => expect(shell.isQuitting).toBe(true));
    quitApp({ quit });
    expect(quit).toHaveBeenCalledOnce();
  });
});

describe('closeAction', () => {
  it('hides unless quitting', () => {
    expect(closeAction({ isQuitting: false, trayAvailable: true })).toBe('hide');
    expect(closeAction({ isQuitting: true, trayAvailable: true })).toBe('close');
  });

  it('quits when there is no Tray to come back from (11 §13)', () => {
    expect(closeAction({ isQuitting: false, trayAvailable: false })).toBe('quit');
  });
});

describe('crashTracker', () => {
  it('reloads once, then shows the error page for a second crash within 60 s', () => {
    const t = crashTracker();
    expect(t.record(0)).toBe('reload');
    expect(t.record(30_000)).toBe('error-page');
  });

  it('reloads again after the window passes', () => {
    const t = crashTracker();
    expect(t.record(0)).toBe('reload');
    expect(t.record(60_001)).toBe('reload');
  });
});
