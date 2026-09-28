import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The viewer preload (08 §4.3): slug from the URL, user activation for paid actions, shape checks
 * before any IPC, and the scroll-to buffer.
 */

const invoke = vi.fn((_ch: unknown, _payload?: unknown): Promise<unknown> => Promise.resolve({ ok: true, value: {} }));
const listeners = new Map<string, (e: unknown, payload: unknown) => void>();
const exposed: Record<string, unknown> = {};
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (k: string, v: unknown) => (exposed[k] = v) },
  ipcRenderer: {
    invoke,
    on: vi.fn((ch: string, fn: (e: unknown, p: unknown) => void) => listeners.set(ch, fn)),
    removeListener: vi.fn(),
  },
}));

const activation = { isActive: true };
beforeAll(async () => {
  vi.useFakeTimers();
  (globalThis as unknown as { location: unknown }).location = new URL(
    'eli5doc://doc/example-widgets/index.html#tab=eli5',
  );
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userActivation: activation },
  });
  await import('../../../src/preload/doc');
});
afterEach(() => {
  invoke.mockClear();
  activation.isActive = true;
});

const { IPC } = await import('../../../src/preload/contract');

interface DocApi {
  regenerateSection(r: object): Promise<unknown>;
  createSectionEli5(r: object): Promise<unknown>;
  closeTab(tabKey: string): Promise<unknown>;
  openExternal(url: string): Promise<unknown>;
  onScrollTo(cb: (e: unknown) => void): () => void;
  onSectionBusy(cb: (e: unknown) => void): () => void;
}
const api = (): DocApi => exposed.eli5Doc as DocApi;
const act = {
  tabKey: 'indepth',
  sectionId: 'sec-indepth-3f9a1c2e',
  action: 'expand',
  selectionText: 'judges every channel',
};
const forbidden = { ok: false, error: { code: 'E_FORBIDDEN', message: 'Forbidden' } };

describe('doc preload (08 §4.3)', () => {
  it('fills slug from the loaded URL and ignores a slug from the page', async () => {
    await api().regenerateSection({ ...act, slug: 'someone-else' });
    expect(invoke).toHaveBeenCalledWith(IPC.doc.regenerateSection, { ...act, slug: 'example-widgets' });
    await api().closeTab('sx0a1b2c');
    expect(invoke).toHaveBeenCalledWith(IPC.doc.closeTab, { slug: 'example-widgets', tabKey: 'sx0a1b2c' });
  });

  it('refuses act and close-tab without transient user activation; no IPC is sent', async () => {
    activation.isActive = false;
    expect(await api().regenerateSection(act)).toEqual(forbidden);
    const { action: _a, ...eli5 } = act;
    expect(await api().createSectionEli5(eli5)).toEqual(forbidden);
    expect(await api().closeTab('sx0a1b2c')).toEqual(forbidden);
    expect(invoke).not.toHaveBeenCalled();
    // Opening links needs no activation.
    await api().openExternal('https://example.test/');
    expect(invoke).toHaveBeenCalledWith(IPC.viewer.openExternal, { url: 'https://example.test/' });
  });

  it('checks the request shape before sending', async () => {
    for (const bad of [
      { ...act, sectionId: 'sec-eli5-3f9a1c2e' },
      { ...act, action: 'summarize' },
      { ...act, selectionText: 'ab' },
      { ...act, note: 'two\nlines' },
      { ...act, note: 'x'.repeat(201) },
      { ...act, selectionText: 'x'.repeat(4001) },
    ]) {
      expect(await api().regenerateSection(bad)).toMatchObject({ ok: false, error: { code: 'E_BAD_REQUEST' } });
    }
    expect(await api().closeTab('notes')).toMatchObject({ ok: false, error: { code: 'E_BAD_REQUEST' } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('sends close-tab for any valid tab key, so main answers E_FORBIDDEN for fixed tabs (08 §7.2)', async () => {
    await api().closeTab('indepth');
    expect(invoke).toHaveBeenCalledWith(IPC.doc.closeTab, { slug: 'example-widgets', tabKey: 'indepth' });
  });

  it('buffers a scroll-to that arrives before the runtime subscribes, for 5 s', () => {
    const push = listeners.get(IPC.doc.scrollTo);
    const e = { sectionId: 'sec-indepth-3f9a1c2e', flash: true, loadSeq: 4 };
    push?.({}, e);
    const got: unknown[] = [];
    api().onScrollTo((x) => got.push(x));
    expect(got).toEqual([e]);
    // Only replayed once.
    api().onScrollTo((x) => got.push(x));
    expect(got).toEqual([e]);
    push?.({}, { ...e, loadSeq: 5 });
    expect(got).toHaveLength(3);
  });
});

describe('doc preload scroll buffer expiry', () => {
  it('drops a buffered scroll-to older than 5 s', async () => {
    vi.resetModules();
    listeners.clear();
    await import('../../../src/preload/doc');
    const push = listeners.get(IPC.doc.scrollTo);
    push?.({}, { tabKey: 'eli5', flash: true, loadSeq: 1 });
    vi.advanceTimersByTime(5001);
    const got: unknown[] = [];
    (exposed.eli5Doc as DocApi).onScrollTo((x) => got.push(x));
    expect(got).toEqual([]);
  });
});
