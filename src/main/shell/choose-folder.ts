import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ChooseFolderResult, FolderSettingKey } from '../../preload/contract';
import { SettingsError, type SettingsStore } from '../config';
import { abbreviateHome, expandHome } from '../publish';

/**
 * Settings folder chooser (11 §7 Publishing, §10): the app's only native panel, user-initiated
 * from Settings. Main shows the panel, validates the choice (10 §5.1 step 1: writable, outside the
 * Library) and saves the key. A rejection throws SettingsError, which IPC maps and the renderer
 * shows inline. Re-exported from src/main/shell/index.ts; bootstrap plugs it into the `folders` slot.
 */

export interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export interface FolderChooserDeps {
  /** `dialog.showOpenDialog` bound to the main window. */
  showOpenDialog(opts: {
    title: string;
    buttonLabel: string;
    defaultPath: string;
    properties: ('openDirectory' | 'createDirectory')[];
  }): Promise<OpenDialogResult>;
  settings: Pick<SettingsStore, 'get' | 'set' | 'describe'>;
  /** The Library root (09 §3.1); exports may not land inside it. */
  libraryRoot: string;
  home?: string;
}

export interface FolderChooserService {
  chooseFolder(key: FolderSettingKey): Promise<ChooseFolderResult>;
}

const LOCKED_MESSAGE = 'This setting is managed by your organization';

export function createFolderChooser(d: FolderChooserDeps): FolderChooserService {
  const home = d.home ?? homedir();
  // One panel at a time: a second request while it is open shares the first result.
  let open: Promise<ChooseFolderResult> | null = null;

  const run = async (key: FolderSettingKey): Promise<ChooseFolderResult> => {
    const entry = d.settings.describe(true).keys.find((k) => k.path === key);
    if (entry?.locked) throw new SettingsError('E_SETTINGS_LOCKED', LOCKED_MESSAGE, [{ path: key, message: 'locked' }]);

    const r = await d.showOpenDialog({
      title: 'Choose export folder',
      buttonLabel: 'Choose',
      defaultPath: expandHome(d.settings.get().publish.local.dir, home),
      properties: ['openDirectory', 'createDirectory'],
    });
    const chosen = r.filePaths[0];
    if (r.canceled || !chosen) return { cancelled: true };

    await validate(chosen, d.libraryRoot, key);
    const saved = abbreviateHome(path.resolve(chosen), home);
    await d.settings.set({ publish: { local: { dir: saved } } });
    return { path: saved };
  };

  return {
    chooseFolder(key) {
      open ??= run(key).finally(() => {
        open = null;
      });
      return open;
    },
  };
}

async function validate(chosen: string, libraryRoot: string, key: FolderSettingKey): Promise<void> {
  const invalid = (message: string) => new SettingsError('E_SETTINGS_INVALID', message, [{ path: key, message }]);
  let real: string;
  try {
    real = await realpath(chosen);
    if (!(await stat(real)).isDirectory()) throw new Error('not a directory');
    await access(real, constants.W_OK);
  } catch {
    throw invalid("You can't save to that folder");
  }
  // Compare real paths so a symlink into the Library is caught too (10 §5.1 step 1).
  const lib = await realpath(libraryRoot).catch(() => path.resolve(libraryRoot));
  if (real === lib || real.startsWith(lib + path.sep)) throw invalid('Choose a folder outside the Library');
}
