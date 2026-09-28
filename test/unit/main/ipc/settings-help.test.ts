import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: {}, session: {} }));

const { IPC } = await import('../../../../src/preload/contract');
const { setup } = await import('./harness');

/** `eli5:settings:open-help` (11 §7 Publishing and About): fixed topics only, app renderer only. */

describe('eli5:settings:open-help (11 §7, HOOK-UI-02)', () => {
  it('delegates known topics to the help opener', async () => {
    const open = vi.fn(async () => true);
    const h = await setup({ services: { help: { open } } });
    for (const topic of ['readme', 'publish-pages', 'licenses']) {
      expect(await h.call(IPC.settings.openHelp, { topic }), topic).toEqual({ ok: true, value: undefined });
    }
    expect(open.mock.calls.map((c: unknown[]) => c[0])).toEqual(['readme', 'publish-pages', 'licenses']);
  });

  it('refuses unknown topics and extra fields never reach the opener as a path', async () => {
    const open = vi.fn(async () => true);
    const h = await setup({ services: { help: { open } } });
    for (const bad of [undefined, {}, { topic: 'x' }, { topic: '../etc/passwd' }, { path: '/etc/hosts' }]) {
      expect(await h.call(IPC.settings.openHelp, bad)).toMatchObject({ ok: false, error: { code: 'E_BAD_REQUEST' } });
    }
    await h.call(IPC.settings.openHelp, { topic: 'licenses', path: '/etc/hosts' });
    expect(open.mock.calls.every((c: unknown[]) => c.length === 1 && c[0] === 'licenses')).toBe(true);
  });

  it('answers E_NOT_FOUND when the help file is missing or the link was refused', async () => {
    const h = await setup({ services: { help: { open: async () => false } } });
    expect(await h.call(IPC.settings.openHelp, { topic: 'publish-pages' })).toEqual({
      ok: false,
      error: { code: 'E_NOT_FOUND', message: "That help page isn't available" },
    });
  });

  it('is refused for the viewer', async () => {
    const open = vi.fn(async () => true);
    const h = await setup({ services: { help: { open } } });
    expect(await h.call(IPC.settings.openHelp, { topic: 'readme' }, 'viewer')).toMatchObject({
      ok: false,
      error: { code: 'E_FORBIDDEN' },
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('answers "Not implemented yet" until a help opener is plugged in', async () => {
    const h = await setup();
    expect(await h.call(IPC.settings.openHelp, { topic: 'readme' })).toEqual({
      ok: false,
      error: { code: 'E_INTERNAL', message: 'Not implemented yet' },
    });
  });
});
