import { LLMError } from './errors';
import { cancelled } from './retry';

/** 02 §7.2: every call streams, so liveness is an idle timer; the total cap is a backstop. */
export interface TimeoutOptions {
  idleMs: number;
  totalMs: number;
}

export const DEFAULT_TIMEOUTS: TimeoutOptions = Object.freeze({ idleMs: 120_000, totalMs: 1_800_000 });
export const TEST_CONNECTION_TIMEOUT_MS = 20_000;

export interface AttemptContext {
  /** Aborted on job cancel, idle timeout or total cap; pass to the SDK request. */
  signal: AbortSignal;
  /** Call on every received stream event (including thinking and keep-alives). */
  touch: () => void;
}

/**
 * Runs one attempt under the idle and total timers. A fired timer aborts the attempt signal with
 * LLMError('timeout'); the outer signal aborts it with 'cancelled'. Whatever the SDK throws after an
 * abort is replaced by that reason so classification is exact.
 */
export async function withTimeouts<T>(
  outer: AbortSignal | undefined,
  opts: TimeoutOptions,
  fn: (ctx: AttemptContext) => Promise<T>,
): Promise<T> {
  if (outer?.aborted) throw cancelled();
  const ctrl = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const fire = (what: string) => () =>
    ctrl.abort(new LLMError('timeout', `The model provider did not respond in time (${what}).`));
  const touch = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(fire('idle'), opts.idleMs);
  };
  const total = setTimeout(fire('total'), opts.totalMs);
  const onOuter = (): void => ctrl.abort(cancelled());
  outer?.addEventListener('abort', onOuter, { once: true });
  touch();
  const aborted = new Promise<never>((_, reject) => {
    ctrl.signal.addEventListener('abort', () => reject(ctrl.signal.reason as Error), { once: true });
  });
  aborted.catch(() => undefined);
  try {
    return await Promise.race([fn({ signal: ctrl.signal, touch }), aborted]);
  } catch (e) {
    if (ctrl.signal.aborted && ctrl.signal.reason instanceof LLMError) throw ctrl.signal.reason;
    throw e;
  } finally {
    clearTimeout(total);
    if (idle) clearTimeout(idle);
    outer?.removeEventListener('abort', onOuter);
  }
}
