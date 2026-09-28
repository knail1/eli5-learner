import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: {}, session: {} }));

const { makeHandle, toIpcError, fail } = await import('../../../../src/main/ipc/handle');
const { NotAvailableInEdition } = await import('../../../../src/main/editions/errors');
const { invokableChannels } = await import('../../../../src/main/ipc');
const { IPC } = await import('../../../../src/preload/contract');

type Listener = (event: unknown, payload: unknown) => Promise<unknown>;

function setup() {
  const handlers = new Map<string, Listener>();
  const app = { id: 1, mainFrame: { url: 'http://localhost:5173/' } };
  const viewer = { id: 2, mainFrame: { url: 'eli5doc://doc/my-doc/index.html' } };
  const handle = makeHandle(
    { handle: (ch, fn) => handlers.set(ch, fn as Listener) },
    {
      appWebContents: () => app as never,
      viewerWebContents: () => viewer as never,
      isAppUrl: (u) => u.origin === 'http://localhost:5173',
    },
  );
  const call = (ch: string, sender: typeof app, payload?: unknown, frame: unknown = sender.mainFrame) =>
    handlers.get(ch)!({ sender, senderFrame: frame }, payload);
  return { handle, call, app, viewer };
}

describe('IPC envelope (01 §5.1, 12 §7.2)', () => {
  it('wraps values in IpcResult and validates payloads', async () => {
    const { handle, call, app } = setup();
    handle(IPC.settings.hasApiKey, 'app', z.object({ provider: z.enum(['claude', 'openai']) }), () => true);
    expect(await call(IPC.settings.hasApiKey, app, { provider: 'claude' })).toEqual({ ok: true, value: true });
    expect(await call(IPC.settings.hasApiKey, app, { provider: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'E_BAD_REQUEST' },
    });
  });

  it('rejects the wrong sender, a null frame, a subframe, and the wrong scheme', async () => {
    const { handle, call, app, viewer } = setup();
    handle(IPC.doc.closeTab, 'viewer', z.unknown(), () => undefined);
    handle(IPC.settings.get, 'app', z.unknown(), () => 1);
    const forbidden = { ok: false, error: { code: 'E_FORBIDDEN', message: 'Forbidden' } };
    expect(await call(IPC.doc.closeTab, app)).toEqual(forbidden);
    expect(await call(IPC.settings.get, viewer as never)).toEqual(forbidden);
    expect(await call(IPC.settings.get, app, undefined, null)).toEqual(forbidden);
    expect(await call(IPC.settings.get, app, undefined, { url: 'http://localhost:5173/' })).toEqual(forbidden);
    viewer.mainFrame.url = 'eli5doc://help/about.html';
    expect(await call(IPC.doc.closeTab, viewer as never)).toEqual(forbidden);
  });

  it('maps errors without leaking unknown messages', async () => {
    expect(toIpcError(new NotAvailableInEdition('publisher:drive', 'HOOK-PUB-01', 'public'))).toMatchObject({
      code: 'E_NOT_AVAILABLE_IN_EDITION',
      capability: 'publisher:drive',
      hookId: 'HOOK-PUB-01',
    });
    expect(toIpcError(new Error('internal path /Users/x'))).toEqual({
      code: 'E_INTERNAL',
      message: 'Something went wrong',
    });
    const { handle, call, app } = setup();
    handle(IPC.library.list, 'app', z.unknown(), () => fail('E_NOT_FOUND', 'Gone'));
    expect(await call(IPC.library.list, app)).toEqual({ ok: false, error: { code: 'E_NOT_FOUND', message: 'Gone' } });
  });

  it('lists every invokable channel from the contract and no event channels', () => {
    const chans = invokableChannels();
    expect(chans).toContain(IPC.jobs.start);
    expect(chans).toContain(IPC.viewer.openExternal);
    expect(chans).not.toContain(IPC.jobs.changed);
    expect(chans).not.toContain(IPC.test.trayClick);
    for (const c of chans) expect(c).toMatch(/^eli5:[a-z]+:[a-z0-9-]+$/);
  });
});
