/**
 * Quit flag and app lifecycle (11 §3.2). Kept free of Electron runtime imports so the rules are
 * unit-testable with a fake `app`.
 */

/** Set by Tray > Quit and by `before-quit`. Electron's app has no isQuitting; do not add one. */
export const shell = { isQuitting: false };

/** The slice of Electron's `app` the lifecycle uses. */
export interface LifecycleApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: 'second-instance' | 'window-all-closed' | 'activate' | 'before-quit', listener: () => void): unknown;
}

/**
 * Single-instance lock plus the lifecycle handlers (11 §3.2 steps 2, 4, 6, 7). Returns false when
 * another instance holds the lock; the caller then exits without bootstrapping.
 */
export function installLifecycle(a: LifecycleApp, onShow: () => void): boolean {
  if (!a.requestSingleInstanceLock()) {
    a.quit();
    return false;
  }
  a.on('second-instance', onShow);
  // Present and empty so Electron never auto-quits when the window is hidden (step 2).
  a.on('window-all-closed', () => {});
  a.on('activate', onShow);
  // OS-initiated quits (log out, shut down, Dock > Quit) are never blocked (step 4).
  a.on('before-quit', () => {
    shell.isQuitting = true;
  });
  return true;
}

/** Tray > Quit: no confirmation; active jobs resume on next launch (11 §3.2 step 3, 06 §4.3). */
export function quitApp(a: Pick<LifecycleApp, 'quit'>): void {
  shell.isQuitting = true;
  a.quit();
}

/** Close is a hide unless quitting (step 1), or unless there is no Tray to come back from (11 §13). */
export function closeAction(o: { isQuitting: boolean; trayAvailable: boolean }): 'close' | 'hide' | 'quit' {
  if (o.isQuitting) return 'close';
  return o.trayAvailable ? 'hide' : 'quit';
}

/**
 * Renderer crash policy (11 §3.2): reload once; a second crash within 60 s shows the inline
 * error page instead.
 */
export function crashTracker(windowMs = 60_000): { record(now: number): 'reload' | 'error-page' } {
  let last: number | undefined;
  return {
    record(now) {
      const repeat = last !== undefined && now - last < windowMs;
      last = now;
      return repeat ? 'error-page' : 'reload';
    },
  };
}

/** In-page fragment the error page's Reload link navigates to; main watches for it (11 §3.2). */
export const RELOAD_FRAGMENT = '#eli5-reload';

/** Static, script-free page: the Reload link is a same-document fragment, so no JS or preload. */
export const ERROR_PAGE =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    '<!doctype html><meta charset="utf-8"><title>ELI5 Learner</title>' +
      '<body style="font:15px -apple-system,sans-serif;display:grid;place-items:center;height:100vh;margin:0">' +
      '<p>Something went wrong. ' +
      `<a href="${RELOAD_FRAGMENT}" role="button" autofocus style="margin-left:.5em">Reload</a></p></body>`,
  );
