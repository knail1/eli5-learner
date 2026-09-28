import { describe, expect, it, vi } from 'vitest';
import { DEFAULTS } from '../../../../src/main/config/schema';
import type { IpcServices } from '../../../../src/main/ipc';
import type { SettingsDescription } from '../../../../src/preload/contract';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() }, app: {}, session: {} }));

const { IPC } = await import('../../../../src/preload/contract');
const { setup } = await import('../ipc/harness');
const { createSettingsServices } = await import('../../../../src/main/shell/settings-services');

/** Bootstrap wiring for the 11 §7 Settings slots: `folders` and `help` must never answer "Not implemented yet". */

function services(open = vi.fn(async () => true)) {
  const current = structuredClone(DEFAULTS);
  const settings = {
    get: () => current,
    set: async () => current,
    describe: (): SettingsDescription => ({ keys: [], loadIssues: [], keychain: { available: true } }),
  };
  const showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
  const s: Pick<IpcServices, 'folders' | 'help'> = createSettingsServices({
    showOpenDialog,
    settings,
    libraryRoot: '/nonexistent-library',
    help: { open },
  });
  return { s, open, showOpenDialog };
}

describe('createSettingsServices (11 §7 bootstrap wiring)', () => {
  it('plugs the help opener into eli5:settings:open-help', async () => {
    const { s, open } = services();
    const h = await setup({ services: s });
    for (const topic of ['readme', 'publish-pages', 'licenses']) {
      expect(await h.call(IPC.settings.openHelp, { topic }), topic).toEqual({ ok: true, value: undefined });
    }
    expect(open).toHaveBeenCalledTimes(3);
  });

  it('plugs the folder chooser into eli5:settings:choose-folder', async () => {
    const { s, showOpenDialog } = services();
    const h = await setup({ services: s });
    expect(await h.call(IPC.settings.chooseFolder, { key: 'publish.local.dir' })).toEqual({
      ok: true,
      value: { cancelled: true },
    });
    expect(showOpenDialog).toHaveBeenCalledOnce();
  });
});
