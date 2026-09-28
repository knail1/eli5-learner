import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The app preload (01 §5.3, 06 §11): marshalling only, plus the trusted-drop listener that
 * registers dropped paths with main so `eli5:jobs:start` can refuse forged paths.
 */

const invoke = vi.fn((ch: unknown, payload?: unknown): Promise<unknown> => {
  if (ch === 'eli5:sources:register-drop') {
    const paths = (payload as { paths: string[] }).paths;
    return Promise.resolve({ ok: true, value: paths.map((p, i) => ({ inputId: `drop-${String(i + 1)}`, path: p })) });
  }
  return Promise.resolve({ ok: true, value: undefined });
});
const exposed: Record<string, unknown> = {};
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (k: string, v: unknown) => (exposed[k] = v) },
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: (f: { fakePath: string }) => f.fakePath },
}));

type DropListener = (e: unknown) => void;
const listeners: { type: string; fn: DropListener; capture: unknown }[] = [];
const dispatched: Event[] = [];

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: (type: string, fn: DropListener, capture: unknown) => listeners.push({ type, fn, capture }),
    dispatchEvent: (e: Event) => dispatched.push(e),
  };
  await import('../../../src/preload/app');
});

const { IPC } = await import('../../../src/preload/contract');

function drop(e: unknown): void {
  const l = listeners.find((x) => x.type === 'drop');
  if (!l) throw new Error('no drop listener');
  l.fn(e);
}

describe('app preload', () => {
  it('exposes window.eli5 and maps jobs.cancel to its channel', async () => {
    const api = exposed.eli5 as { jobs: { cancel(id: string): Promise<unknown> } };
    await api.jobs.cancel('job-1');
    expect(invoke).toHaveBeenCalledWith(IPC.jobs.cancel, { jobId: 'job-1' });
  });

  it('listens for drops in the capture phase', () => {
    expect(listeners.find((x) => x.type === 'drop')?.capture).toBe(true);
  });

  it('registers the paths of trusted drops with main', () => {
    invoke.mockClear();
    drop({ isTrusted: true, dataTransfer: { files: [{ fakePath: '/a/deck.pptx' }, { fakePath: '/b/notes.md' }] } });
    expect(invoke).toHaveBeenCalledWith(IPC.sources.registerDrop, { paths: ['/a/deck.pptx', '/b/notes.md'] });
  });

  it('ignores untrusted drops, drops without files, and files without a path', () => {
    invoke.mockClear();
    drop({ isTrusted: false, dataTransfer: { files: [{ fakePath: '/a/deck.pptx' }] } });
    drop({ isTrusted: true, dataTransfer: { files: [] } });
    drop({ isTrusted: true, dataTransfer: null });
    drop({ isTrusted: true, dataTransfer: { files: [{ fakePath: '' }] } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sends main's drop ids for dropped files in jobs.start, after registration settles (06 §11)", async () => {
    invoke.mockClear();
    drop({ isTrusted: true, dataTransfer: { files: [{ fakePath: '/a/deck.pptx' }, { fakePath: '/b/notes.md' }] } });
    const api = exposed.eli5 as { jobs: { start(r: unknown): Promise<unknown> } };
    const options = { clarifyingInput: '', glossary: true };
    await api.jobs.start({
      inputs: [
        { id: 'chip-1', kind: 'file', origin: 'drop', path: '/b/notes.md' },
        { id: 'chip-2', kind: 'url', origin: 'url-field', url: 'https://example.com' },
        { id: 'chip-3', kind: 'file', origin: 'paste', path: '/c/pasted.md' },
      ],
      options,
    });
    expect(invoke).toHaveBeenLastCalledWith(IPC.jobs.start, {
      inputs: [
        { id: 'drop-2', kind: 'file', origin: 'drop', path: '/b/notes.md' },
        { id: 'chip-2', kind: 'url', origin: 'url-field', url: 'https://example.com' },
        { id: 'chip-3', kind: 'file', origin: 'paste', path: '/c/pasted.md' },
      ],
      options,
    });
  });

  it('passes jobs.start through unchanged when a registration fails', async () => {
    invoke.mockClear();
    invoke.mockImplementationOnce(() => Promise.resolve({ ok: false, error: { code: 'E_BAD_REQUEST' } }));
    drop({ isTrusted: true, dataTransfer: { files: [{ fakePath: '/z/other.md' }] } });
    const api = exposed.eli5 as { jobs: { start(r: unknown): Promise<unknown> } };
    const req = { inputs: [{ id: 'chip-9', kind: 'file', origin: 'drop', path: '/z/other.md' }], options: {} };
    await api.jobs.start(req);
    expect(invoke).toHaveBeenLastCalledWith(IPC.jobs.start, req);
  });

  it('test builds expose __eli5Test.dropPaths: registers like a trusted drop, then enters the input zone (13 §8.1)', async () => {
    invoke.mockClear();
    dispatched.length = 0;
    const t = exposed.__eli5Test as { dropPaths(paths: string[]): Promise<void> };
    await t.dropPaths(['/d/brief.md']);
    expect(invoke).toHaveBeenCalledWith(IPC.sources.registerDrop, { paths: ['/d/brief.md'] });
    const ev = dispatched.at(-1) as CustomEvent<unknown> | undefined;
    expect(ev?.type).toBe('eli5:test:drop-paths');
    expect(ev?.detail).toEqual(['/d/brief.md']);
    const api = exposed.eli5 as { jobs: { start(r: unknown): Promise<unknown> } };
    await api.jobs.start({
      inputs: [{ id: 'chip-4', kind: 'file', origin: 'drop', path: '/d/brief.md' }],
      options: {},
    });
    expect(invoke).toHaveBeenLastCalledWith(IPC.jobs.start, {
      inputs: [{ id: 'drop-1', kind: 'file', origin: 'drop', path: '/d/brief.md' }],
      options: {},
    });
  });
});
