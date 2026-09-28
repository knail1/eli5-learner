import type { MenuItemConstructorOptions } from 'electron';

/**
 * macOS application menu (11 §3.2 step 5, §9). There is no `role: 'quit'` item: Cmd+Q and Cmd+W
 * hide the window, and quitting happens only from the menu bar item. There is no `reload` role
 * either, so Cmd+R never reloads the app renderer.
 */

export interface AppMenuActions {
  hideWindow(): void;
  openSettings(): void;
}

export const MENU_IDS = {
  closeQ: 'close-window-q',
  closeW: 'close-window-w',
  quitHint: 'quit-hint',
  settings: 'settings',
} as const;

export function appMenuTemplate(
  actions: AppMenuActions,
  opts: { appName: string; devTools: boolean },
): MenuItemConstructorOptions[] {
  return [
    {
      label: opts.appName,
      submenu: [
        { role: 'about', label: `About ${opts.appName}` },
        { type: 'separator' },
        { id: MENU_IDS.settings, label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => actions.openSettings() },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          id: MENU_IDS.closeQ,
          label: 'Close Window',
          accelerator: 'CmdOrCtrl+Q',
          click: () => actions.hideWindow(),
        },
        { id: MENU_IDS.quitHint, label: 'Quit from the menu bar icon', enabled: false },
      ],
    },
    {
      // Standard edit roles; without them text fields lose copy and paste on macOS. The paste role
      // fires a DOM `paste` event that the input zone turns into a clipboard source (11 §5.4).
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        // 200% zoom support (11 §12).
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        ...(opts.devTools ? [{ type: 'separator' as const }, { role: 'toggleDevTools' as const }] : []),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        {
          id: MENU_IDS.closeW,
          label: 'Close Window',
          accelerator: 'CmdOrCtrl+W',
          click: () => actions.hideWindow(),
        },
      ],
    },
    { role: 'help', submenu: [] },
  ];
}

export interface LibraryItemMenuActions {
  open(slug: string): void;
  reveal(slug: string): void;
}

/**
 * Native context menu for a Library item (11 §5.2, `eli5:app:context-menu`). Enterprise publish
 * items are appended by the caller only when HOOK-UI-01 enables them.
 */
export function libraryItemMenuTemplate(slug: string, a: LibraryItemMenuActions): MenuItemConstructorOptions[] {
  return [
    { label: 'Open', click: () => a.open(slug) },
    { label: 'Reveal in Finder', click: () => a.reveal(slug) },
  ];
}
