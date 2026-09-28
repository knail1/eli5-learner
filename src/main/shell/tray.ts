import { Menu, Tray, app, ipcMain, nativeImage } from 'electron';
import { IPC, type CatalogEntry, type EditionInfo } from '../../preload/contract';
import { resourcePath } from '../config';
import { log } from '../security';
import { quitApp } from './lifecycle';
import {
  quitLabel,
  recentFromCatalog,
  trayMenuTemplate,
  trayTooltip,
  type TrayActions,
  type TrayModel,
} from './tray-model';
import { navigate, setTrayAvailable, shellHooks, showMainWindow } from './window';

/** Menu bar item (11 §4). The app's anchor: it outlives the window. */

let tray: Tray | undefined;
let model: TrayModel = { recent: [], activeJobs: 0 };
let catalog: readonly CatalogEntry[] = [];
let archived: ReadonlySet<string> = new Set();
let busyIcon = false;

const actions: TrayActions = {
  openDocument: (slug) => {
    showMainWindow();
    shellHooks().openDocument?.(slug);
    navigate({ view: 'doc', slug });
  },
  showWindow: () => showMainWindow(),
  openSettings: () => {
    showMainWindow();
    navigate({ view: 'settings' });
  },
  quit: () => quitApp(app),
};

/** The public build adds no edition-specific Tray items (11 §11: Tray has none). */
export function buildTrayMenu(m: TrayModel, _edition?: EditionInfo): Electron.Menu {
  return Menu.buildFromTemplate(trayMenuTemplate(m, actions));
}

function icon(busy: boolean): Electron.NativeImage {
  // "…Template" names plus @2x siblings: macOS tints them for light and dark menu bars.
  const img = nativeImage.createFromPath(resourcePath(busy ? 'tray/trayBusyTemplate.png' : 'tray/trayTemplate.png'));
  img.setTemplateImage(true);
  return img;
}

export function createTray(): Tray | undefined {
  try {
    const img = icon(false);
    tray = new Tray(img);
    // Text fallback only if the icon asset is missing, so the item is never invisible.
    if (img.isEmpty()) tray.setTitle('ELI5');
    setTrayAvailable(true);
  } catch (err) {
    // 11 §13: keep running with the window; closing it then quits.
    log.error('shell.tray-failed', {}, err);
    tray = undefined;
    setTrayAvailable(false);
    return undefined;
  }
  rebuildTrayMenu();
  if (__ELI5_TEST__) installTrayTestChannel();
  return tray;
}

/** Cheap and synchronous; called on library and job changes and at startup (11 §4.2). */
export function rebuildTrayMenu(): void {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildTrayMenu(model));
  tray.setToolTip(trayTooltip(model.activeJobs));
  const busy = model.activeJobs > 0;
  if (busy !== busyIcon) {
    busyIcon = busy;
    tray.setImage(icon(busy));
  }
}

/** Feed from `eli5:library:changed` (and the startup `library:list`). */
export function setTrayCatalog(entries: readonly CatalogEntry[]): void {
  catalog = [...entries];
  model = { ...model, recent: recentFromCatalog(catalog, archived) };
  rebuildTrayMenu();
}

/** Feed from `eli5:library:organization-changed`: archived documents leave the recents (09 §4.2). */
export function setTrayArchived(ids: ReadonlySet<string>): void {
  archived = new Set(ids);
  model = { ...model, recent: recentFromCatalog(catalog, archived) };
  rebuildTrayMenu();
}

/** Feed from `eli5:jobs:changed`; rebuilds only when the active count changes. */
export function setTrayActiveJobs(n: number): void {
  if (n === model.activeJobs) return;
  model = { ...model, activeJobs: n };
  rebuildTrayMenu();
}

export function trayModel(): TrayModel {
  return model;
}

/**
 * Test-only (13 §8.3, 01 §8.1): Playwright cannot click the Tray, so e2e specs emit
 * `eli5:test:tray-click` from main-process evaluation. Compiled out of packaged builds.
 */
interface TrayTestRequest {
  /** Menu item label to click. */
  click?: string;
  /** Receives the current labels, tooltip and Quit label. */
  inspect?: (s: { labels: string[]; tooltip: string; quit: string }) => void;
}

function installTrayTestChannel(): void {
  ipcMain.removeAllListeners(IPC.test.trayClick);
  ipcMain.on(IPC.test.trayClick, (_e: unknown, req: TrayTestRequest) => {
    const items = trayMenuTemplate(model, actions);
    req.inspect?.({
      labels: items.filter((i) => i.type !== 'separator').map((i) => i.label ?? ''),
      tooltip: trayTooltip(model.activeJobs),
      quit: quitLabel(model.activeJobs),
    });
    if (req.click) {
      const item = items.find((i) => i.label === req.click && i.enabled !== false);
      item?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
    }
  });
}
