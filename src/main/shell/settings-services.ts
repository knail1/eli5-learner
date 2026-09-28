import { createFolderChooser, type FolderChooserDeps, type FolderChooserService } from './choose-folder';
import type { HelpOpener } from './menu-help';

/**
 * The 11 §7 Settings slots (`folders`, `help`) as bootstrap plugs them into IpcServices. The help
 * opener is the same instance the Help menu uses (window.ts `helpOpener()`).
 */

export interface SettingsServicesDeps extends FolderChooserDeps {
  help: HelpOpener;
}

export function createSettingsServices(d: SettingsServicesDeps): {
  folders: FolderChooserService;
  help: HelpOpener;
} {
  const { help, ...folderDeps } = d;
  return { folders: createFolderChooser(folderDeps), help };
}
