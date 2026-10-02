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

  it('maps doc history, undo and redo to their app channels with the slug (09 §4.1)', async () => {
    const api = exposed.eli5 as { doc: Record<'history' | 'undo' | 'redo', (slug: string) => Promise<unknown>> };
    invoke.mockClear();
    await api.doc.history('widget-pricing');
    await api.doc.undo('widget-pricing');
    await api.doc.redo('widget-pricing');
    expect(invoke.mock.calls).toEqual([
      [IPC.doc.history, { slug: 'widget-pricing' }],
      [IPC.doc.undo, { slug: 'widget-pricing' }],
      [IPC.doc.redo, { slug: 'widget-pricing' }],
    ]);
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

  it("sources.release sends main's ids for leaving file chips, then forgets dropped paths (06 §11)", async () => {
    drop({ isTrusted: true, dataTransfer: { files: [{ fakePath: '/r/keep.md' }, { fakePath: '/r/gone.md' }] } });
    const api = exposed.eli5 as {
      sources: { release(i: unknown[]): Promise<unknown> };
      jobs: { start(r: unknown): Promise<unknown> };
    };
    invoke.mockClear();
    const r = await api.sources.release([
      { id: 'chip-1', kind: 'file', origin: 'drop', path: '/r/gone.md' },
      { id: 'drop-77', kind: 'file', origin: 'paste', path: '/c/pasted.md' },
      { id: 'chip-2', kind: 'url', origin: 'url-field', url: 'https://example.com' },
    ]);
    expect(r).toEqual({ ok: true, value: undefined });
    expect(invoke).toHaveBeenCalledWith(IPC.sources.releaseDrops, { inputIds: ['drop-2', 'drop-77'] });
    // The released path no longer maps to an id; the kept one still does.
    await api.jobs.start({
      inputs: [
        { id: 'chip-3', kind: 'file', origin: 'drop', path: '/r/keep.md' },
        { id: 'chip-1', kind: 'file', origin: 'drop', path: '/r/gone.md' },
      ],
      options: {},
    });
    expect(invoke).toHaveBeenLastCalledWith(IPC.jobs.start, {
      inputs: [
        { id: 'drop-1', kind: 'file', origin: 'drop', path: '/r/keep.md' },
        { id: 'chip-1', kind: 'file', origin: 'drop', path: '/r/gone.md' },
      ],
      options: {},
    });
    // Nothing to release: no IPC.
    invoke.mockClear();
    await api.sources.release([{ id: 'chip-2', kind: 'url', origin: 'url-field', url: 'https://example.com' }]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('maps the M3 methods to their channels (01 §5.3, 11 §10, 10 §6, 09 §11)', async () => {
    type Fn = (...a: unknown[]) => Promise<unknown>;
    const api = exposed.eli5 as Record<string, Record<string, Fn>>;
    const cases: [Fn, unknown[], string, unknown][] = [
      [api.app!.testNotification!, [], IPC.app.testNotification, undefined],
      [api.app!.openNotificationSettings!, [], IPC.app.openNotificationSettings, undefined],
      [api.settings!.chooseFolder!, ['publish.local.dir'], IPC.settings.chooseFolder, { key: 'publish.local.dir' }],
      [api.settings!.openHelp!, ['licenses'], IPC.settings.openHelp, { topic: 'licenses' }],
      [api.sources!.classifyText!, ['ABC-123'], IPC.sources.classifyText, { text: 'ABC-123' }],
      [api.library!.revealRoot!, [], IPC.library.revealRoot, undefined],
      [api.viewer!.focus!, [], IPC.viewer.focus, undefined],
      [api.viewer!.find!, ['widget'], IPC.viewer.find, { text: 'widget' }],
      [
        api.viewer!.find!,
        ['widget', { forward: false, again: true }],
        IPC.viewer.find,
        { text: 'widget', forward: false, again: true },
      ],
      [api.viewer!.stopFind!, [], IPC.viewer.stopFind, undefined],
      [api.suggestions!.accept!, ['s-1'], IPC.suggestions.accept, { suggestionId: 's-1' }],
      [api.publish!.run!, ['solar-power', 'local'], IPC.publish.run, { slug: 'solar-power', targetId: 'local' }],
      [api.publish!.reveal!, ['file:///x'], IPC.publish.reveal, { url: 'file:///x' }],
    ];
    for (const [fn, args, channel, payload] of cases) {
      invoke.mockClear();
      await fn(...args);
      expect(invoke).toHaveBeenCalledWith(channel, payload);
    }
  });

  it('subscribes find results and find menu commands to their events (11 §5.3)', async () => {
    const { ipcRenderer } = await import('electron');
    const api = exposed.eli5 as {
      viewer: { onFindResult(cb: (e: unknown) => void): () => void };
      app: { onFindCommand(cb: (e: unknown) => void): () => void };
    };
    api.viewer.onFindResult(() => {});
    api.app.onFindCommand(() => {});
    expect(ipcRenderer.on).toHaveBeenCalledWith(IPC.viewer.findResult, expect.any(Function));
    expect(ipcRenderer.on).toHaveBeenCalledWith(IPC.app.findCommand, expect.any(Function));
  });

  it('subscribes app.onCycleRegion to eli5:app:cycle-region (11 §12)', async () => {
    const { ipcRenderer } = await import('electron');
    const api = exposed.eli5 as { app: { onCycleRegion(cb: (e: unknown) => void): () => void } };
    api.app.onCycleRegion(() => {});
    expect(ipcRenderer.on).toHaveBeenCalledWith(IPC.app.cycleRegion, expect.any(Function));
  });
});
