import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeepPartial, Settings } from '../../../../src/main/config';
import { DEFAULTS } from '../../../../src/main/config/schema';
import type { SettingsDescription } from '../../../../src/preload/contract';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() }, app: {}, session: {} }));

const { createFolderChooser } = await import('../../../../src/main/shell/choose-folder');
const { SettingsError } = await import('../../../../src/main/config');

/** Settings > Publishing folder chooser (11 §7, §10; 10 §5.1 step 1). All paths are temp dirs. */

let tmp: string;
let home: string;
let libraryRoot: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'eli5-choose-'));
  home = path.join(tmp, 'home');
  libraryRoot = path.join(tmp, 'library');
  await mkdir(path.join(home, 'Documents'), { recursive: true });
  await mkdir(libraryRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function fakeSettings(locked: string[] = []) {
  const current = structuredClone(DEFAULTS);
  return {
    current,
    get: vi.fn(() => current),
    set: vi.fn(async (patch: DeepPartial<Settings>): Promise<Settings> => {
      const dir = patch.publish?.local?.dir;
      if (typeof dir === 'string') current.publish.local.dir = dir;
      return current;
    }),
    describe: vi.fn((): SettingsDescription => ({
      keys: [
        { path: 'publish.local.dir', dormant: false, locked: locked.includes('publish.local.dir'), source: 'default' },
      ],
      loadIssues: [],
      keychain: { available: true },
    })),
  };
}

function setup(pick: () => string[] | undefined, locked: string[] = []) {
  const settings = fakeSettings(locked);
  const showOpenDialog = vi.fn(async () => {
    const chosen = pick();
    return { canceled: !chosen, filePaths: chosen ?? [] };
  });
  const chooser = createFolderChooser({ showOpenDialog, settings, libraryRoot, home });
  return { chooser, settings, showOpenDialog };
}

describe('createFolderChooser (11 §7 Publishing)', () => {
  it('opens a directory panel at the current export folder, saves the choice abbreviated and returns it', async () => {
    const target = path.join(home, 'Exports');
    await mkdir(target);
    const { chooser, settings, showOpenDialog } = setup(() => [target]);
    expect(await chooser.chooseFolder('publish.local.dir')).toEqual({ path: '~/Exports' });
    expect(showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: path.join(home, 'Documents', 'ELI5 Learner'),
        properties: expect.arrayContaining(['openDirectory', 'createDirectory']),
      }),
    );
    expect(settings.set).toHaveBeenCalledWith({ publish: { local: { dir: '~/Exports' } } });
  });

  it('keeps folders outside the home directory absolute', async () => {
    const target = path.join(tmp, 'outside');
    await mkdir(target);
    const { chooser, settings } = setup(() => [target]);
    const r = await chooser.chooseFolder('publish.local.dir');
    expect(r).toEqual({ path: expect.stringMatching(/outside$/) });
    expect(path.isAbsolute((r as { path: string }).path)).toBe(true);
    expect(settings.set).toHaveBeenCalledOnce();
  });

  it('returns {cancelled:true} and saves nothing when the panel is dismissed', async () => {
    const { chooser, settings } = setup(() => undefined);
    expect(await chooser.chooseFolder('publish.local.dir')).toEqual({ cancelled: true });
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('rejects the Library folder and anything inside it (10 §5.1 step 1), even through a symlink', async () => {
    const inside = path.join(libraryRoot, 'sub');
    await mkdir(inside);
    const link = path.join(home, 'lib-link');
    await symlink(libraryRoot, link);
    for (const chosen of [libraryRoot, inside, link]) {
      const { chooser, settings } = setup(() => [chosen]);
      const err = await chooser.chooseFolder('publish.local.dir').catch((e: unknown) => e);
      expect(err, chosen).toBeInstanceOf(SettingsError);
      expect(err).toMatchObject({
        code: 'E_SETTINGS_INVALID',
        message: 'Choose a folder outside the Library',
        issues: [{ path: 'publish.local.dir' }],
      });
      expect(settings.set).not.toHaveBeenCalled();
    }
  });

  it('does not treat a sibling that shares the Library name prefix as inside it', async () => {
    const sibling = `${libraryRoot}-exports`;
    await mkdir(sibling);
    const { chooser } = setup(() => [sibling]);
    expect(await chooser.chooseFolder('publish.local.dir')).toMatchObject({ path: expect.stringMatching(/-exports$/) });
  });

  it('rejects a folder that does not exist or cannot be written', async () => {
    const { chooser, settings } = setup(() => [path.join(tmp, 'missing')]);
    await expect(chooser.chooseFolder('publish.local.dir')).rejects.toMatchObject({
      code: 'E_SETTINGS_INVALID',
      message: "You can't save to that folder",
    });
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('refuses a locked key before showing the panel (HOOK-CFG-01)', async () => {
    const { chooser, showOpenDialog } = setup(() => [home], ['publish.local.dir']);
    await expect(chooser.chooseFolder('publish.local.dir')).rejects.toMatchObject({
      code: 'E_SETTINGS_LOCKED',
      message: 'This setting is managed by your organization',
    });
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it('shows one panel at a time: a second request while open shares the first result', async () => {
    const target = path.join(home, 'Exports');
    await mkdir(target);
    let release: () => void = () => {};
    const settings = fakeSettings();
    const showOpenDialog = vi.fn(
      () =>
        new Promise<{ canceled: boolean; filePaths: string[] }>((r) => {
          release = () => r({ canceled: false, filePaths: [target] });
        }),
    );
    const chooser = createFolderChooser({ showOpenDialog, settings, libraryRoot, home });
    const a = chooser.chooseFolder('publish.local.dir');
    const b = chooser.chooseFolder('publish.local.dir');
    await vi.waitFor(() => expect(showOpenDialog).toHaveBeenCalledOnce());
    release();
    expect(await a).toEqual({ path: '~/Exports' });
    expect(await b).toEqual({ path: '~/Exports' });
    // After it closes, a new request opens a new panel.
    const c = chooser.chooseFolder('publish.local.dir');
    await vi.waitFor(() => expect(showOpenDialog).toHaveBeenCalledTimes(2));
    release();
    await c;
  });
});
