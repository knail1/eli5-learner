import { log } from '../security';

export interface QuitStep {
  /** Log label only. */
  name: string;
  run(): Promise<void> | void;
}

export interface QuitHandlerOptions {
  /** Run in order on the first quit; read at quit time, so bootstrap may add steps later. */
  steps: readonly QuitStep[];
  /** Ends the process without closing windows first (Electron `app.exit(0)`). */
  exit(): void;
  /** 11 §3.2 step 4: an OS-initiated quit is never held longer than this. */
  boundMs?: number;
}

export const QUIT_BOUND_MS = 2000;

/**
 * `before-quit` handler (06 §4.3, §9.1, 11 §3.2). It holds the quit once, flushes job records and
 * releases the Library lock in order, then exits directly. Exiting before Electron closes the job
 * windows and ends the extract workers means a running job cannot be failed by the teardown: its
 * last checkpoint stays on disk and crash recovery (06 §9.4) resumes it.
 */
export function createQuitHandler(o: QuitHandlerOptions): (e: { preventDefault(): void }) => void {
  let started = false;
  return (e) => {
    e.preventDefault();
    if (started) return;
    started = true;
    const steps = async (): Promise<void> => {
      for (const step of o.steps) {
        try {
          await step.run();
        } catch (err) {
          log.error('app.quit-step-failed', { step: step.name }, err);
        }
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log.warn('app.quit-bound-reached', {});
        resolve();
      }, o.boundMs ?? QUIT_BOUND_MS);
    });
    void Promise.race([steps(), bound]).then(() => {
      clearTimeout(timer);
      o.exit();
    });
  };
}
