import type { MenuItemConstructorOptions } from 'electron';
import type { HelpTopic } from '../../preload/contract';

/**
 * macOS application menu (11 §3.2 step 5, §9). There is no `role: 'quit'` item: Cmd+Q and Cmd+W
 * hide the window, and quitting happens only from the menu bar item. There is no `reload` role
 * either, so Cmd+R never reloads the app renderer; it reloads the viewer.
 *
 * Window shortcuts that have a menu item are mirrored here so they show in Help menu search and
 * still work while the viewer has focus. Their items forward the key to the app renderer, whose
 * shortcut table (src/renderer/src/a11y/shortcuts.ts) is the one place the action is defined. When
 * the app renderer has focus it handles the key itself and prevents the default, so the item does
 * not fire a second time.
 */

/** Window shortcuts mirrored as menu items (11 §9). */
export type MenuShortcutId = 'new-draft' | 'focus-url' | 'focus-filter' | 'toggle-sidebar' | 'prev-doc' | 'next-doc';

/** `sendInputEvent` keyCode (with the `meta` modifier) that the renderer maps back to each id. */
export const MENU_SHORTCUT_KEYS: Record<MenuShortcutId, string> = {
  'new-draft': 'N',
  'focus-url': 'L',
  'focus-filter': 'F',
  'toggle-sidebar': '\\',
  'prev-doc': '[',
  'next-doc': ']',
};

export interface AppMenuActions {
  hideWindow(): void;
  openSettings(): void;
  /** Show the window and run the shortcut in the app renderer. */
  shortcut(id: MenuShortcutId): void;
  /** Cmd+R: reload the viewer (not the app) when a document is shown. */
  reloadViewer(): void;
  openHelp(topic: HelpTopic): void;
}

export const MENU_IDS = {
  closeQ: 'close-window-q',
  closeW: 'close-window-w',
  quitHint: 'quit-hint',
  settings: 'settings',
  reloadViewer: 'reload-viewer',
} as const;

const shortcutItem = (
  actions: AppMenuActions,
  id: MenuShortcutId,
  label: string,
  accelerator: string,
): MenuItemConstructorOptions => ({ id: `shortcut-${id}`, label, accelerator, click: () => actions.shortcut(id) });

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
      label: 'File',
      submenu: [
        shortcutItem(actions, 'new-draft', 'New Explainer', 'CmdOrCtrl+N'),
        shortcutItem(actions, 'focus-url', 'Add URL', 'CmdOrCtrl+L'),
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
        { type: 'separator' },
        shortcutItem(actions, 'focus-filter', 'Find in Library', 'CmdOrCtrl+F'),
      ],
    },
    {
      label: 'View',
      submenu: [
        shortcutItem(actions, 'toggle-sidebar', 'Toggle Sidebar', 'CmdOrCtrl+\\'),
        {
          id: MENU_IDS.reloadViewer,
          label: 'Reload Document',
          accelerator: 'CmdOrCtrl+R',
          click: () => actions.reloadViewer(),
        },
        { type: 'separator' },
        // 200% zoom support (11 §12).
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        ...(opts.devTools ? [{ type: 'separator' as const }, { role: 'toggleDevTools' as const }] : []),
      ],
    },
    {
      label: 'Go',
      submenu: [
        shortcutItem(actions, 'prev-doc', 'Previous Document', 'CmdOrCtrl+['),
        shortcutItem(actions, 'next-doc', 'Next Document', 'CmdOrCtrl+]'),
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
    {
      // HOOK-UI-02 public links; main maps each topic to a fixed URL or bundled file (menu-help.ts).
      role: 'help',
      submenu: [
        { label: 'ELI5 Learner Help', click: () => actions.openHelp('readme') },
        { label: 'How to Set Up a Pages Repository', click: () => actions.openHelp('publish-pages') },
        { type: 'separator' },
        { label: 'Third-Party Licenses', click: () => actions.openHelp('licenses') },
      ],
    },
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
