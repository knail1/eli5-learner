import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The app preload (01 §5.3, 06 §11): marshalling only, plus the trusted-drop listener that
 * registers dropped paths with main so `eli5:jobs:start` can refuse forged paths.
 */

const invoke = vi.fn((..._a: unknown[]) => Promise.resolve({ ok: true, value: undefined }));
const exposed: Record<string, unknown> = {};
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (k: string, v: unknown) => (exposed[k] = v) },
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: (f: { fakePath: string }) => f.fakePath },
}));

type DropListener = (e: unknown) => void;
const listeners: { type: string; fn: DropListener; capture: unknown }[] = [];

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: (type: string, fn: DropListener, capture: unknown) => listeners.push({ type, fn, capture }),
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
});
