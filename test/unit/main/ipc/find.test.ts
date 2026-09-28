import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: {}, session: {} }));

const { IPC } = await import('../../../../src/preload/contract');
const { invokableChannels } = await import('../../../../src/main/ipc');
const { setup } = await import('./harness');

/** `eli5:viewer:find`, `eli5:viewer:stop-find` (11 §5.3 find bar, §10): app window only. */

const forbidden = { ok: false, error: { code: 'E_FORBIDDEN', message: 'Forbidden' } };

describe('find in document channels', () => {
  it('find passes a validated request to the viewer', async () => {
    const h = await setup();
    expect(await h.call(IPC.viewer.find, { text: 'widget' })).toEqual({ ok: true, value: undefined });
    expect(await h.call(IPC.viewer.find, { text: 'widget', forward: false, again: true })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(h.find.requests).toEqual([{ text: 'widget' }, { text: 'widget', forward: false, again: true }]);
  });

  it('refuses empty, over-long and malformed queries', async () => {
    const h = await setup();
    for (const bad of [
      { text: '' },
      { text: 'x'.repeat(201) },
      { text: 42 },
      undefined,
      { text: 'a', forward: 'no' },
    ]) {
      expect(await h.call(IPC.viewer.find, bad)).toMatchObject({ ok: false, error: { code: 'E_BAD_REQUEST' } });
    }
    expect(await h.call(IPC.viewer.find, { text: 'x'.repeat(200) })).toMatchObject({ ok: true });
    expect(h.find.requests).toHaveLength(1);
  });

  it('stop-find takes no payload and clears the search', async () => {
    const h = await setup();
    expect(await h.call(IPC.viewer.stopFind)).toEqual({ ok: true, value: undefined });
    expect(h.find.stops).toBe(1);
    expect(await h.call(IPC.viewer.stopFind, { text: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'E_BAD_REQUEST' },
    });
  });

  it('are app-only: the document viewer gets E_FORBIDDEN', async () => {
    const h = await setup();
    expect(await h.call(IPC.viewer.find, { text: 'widget' }, 'viewer')).toEqual(forbidden);
    expect(await h.call(IPC.viewer.stopFind, undefined, 'viewer')).toEqual(forbidden);
    expect(h.find.requests).toEqual([]);
    expect(h.find.stops).toBe(0);
  });

  it('the find result and menu command are events, not invokable', () => {
    const channels = invokableChannels();
    expect(channels).toContain(IPC.viewer.find);
    expect(channels).toContain(IPC.viewer.stopFind);
    expect(channels).not.toContain(IPC.viewer.findResult);
    expect(channels).not.toContain(IPC.app.findCommand);
  });
});
