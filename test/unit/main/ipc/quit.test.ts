import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: {}, session: {} }));

const { createQuitHandler } = await import('../../../../src/main/ipc/quit');

/**
 * Quit ordering (06 §4.3, §9.1, 11 §3.2): flush job records, release the Library lock, then exit
 * before Electron tears down job windows and workers, so a running job keeps its last checkpoint.
 */

function event() {
  return { preventDefault: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createQuitHandler', () => {
  it('holds the quit, runs the steps in order, then exits once', async () => {
    const order: string[] = [];
    let release!: () => void;
    const flushed = new Promise<void>((r) => (release = r));
    const exit = vi.fn(() => order.push('exit'));
    const quit = createQuitHandler({
      steps: [
        { name: 'jobs', run: () => flushed.then(() => void order.push('jobs')) },
        { name: 'library', run: () => void order.push('library') },
      ],
      exit,
    });
    const e1 = event();
    quit(e1);
    expect(e1.preventDefault).toHaveBeenCalled();
    // A second quit while flushing is held too and starts nothing new.
    const e2 = event();
    quit(e2);
    expect(e2.preventDefault).toHaveBeenCalled();
    expect(order).toEqual([]);
    release();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['jobs', 'library', 'exit']);
  });

  it('a failing step does not stop the later steps or the exit', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const quit = createQuitHandler({
      steps: [
        { name: 'jobs', run: () => Promise.reject(new Error('disk full')) },
        { name: 'library', run: () => void order.push('library') },
      ],
      exit,
    });
    quit(event());
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['library']);
  });

  it('never holds an OS-initiated quit longer than the bound (11 §3.2 step 4)', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const quit = createQuitHandler({
      steps: [{ name: 'jobs', run: () => new Promise<void>(() => {}) }],
      exit,
      boundMs: 1500,
    });
    quit(event());
    await vi.advanceTimersByTimeAsync(1499);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('steps added after creation run too (bootstrap registers them as they come up)', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const steps = [{ name: 'library', run: () => void order.push('library') }];
    const quit = createQuitHandler({ steps, exit });
    steps.unshift({ name: 'jobs', run: () => void order.push('jobs') });
    quit(event());
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(order).toEqual(['jobs', 'library']);
  });
});
