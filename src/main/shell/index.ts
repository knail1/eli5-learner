/**
 * App shell (11): main window that hides on close, the viewer WebContentsView, the application
 * menu without a quit role, the menu bar item with recents, and the lifecycle rules.
 */
export {
  VIEWER_PARTITION,
  initShell,
  mainWebContents,
  viewerWebContents,
  isAppUrl,
  createMainWindow,
  setViewerBounds,
  setViewerVisible,
  isViewerAttached,
  showMainWindow,
  hideMainWindow,
  navigate,
  installAppMenu,
  showLibraryItemMenu,
  requestCloseMainWindow,
} from './window';
export { ContextMenuRequest, handleContextMenu, observeAppEvent, seedTray } from './events';
export type { ShellPaths, ShellHooks } from './window';
export { createTray, rebuildTrayMenu, buildTrayMenu, setTrayCatalog, setTrayActiveJobs, trayModel } from './tray';
export {
  activeJobCounter,
  trayMenuTemplate,
  trayLabel,
  trayTooltip,
  quitLabel,
  recentFromCatalog,
  libraryOrder,
} from './tray-model';
export type { TrayEntry, TrayModel, TrayActions } from './tray-model';
export { shell, installLifecycle, quitApp, closeAction, crashTracker, ERROR_PAGE, RELOAD_FRAGMENT } from './lifecycle';
export type { LifecycleApp } from './lifecycle';
export { appMenuTemplate, libraryItemMenuTemplate, MENU_IDS } from './app-menu';
export type { AppMenuActions, LibraryItemMenuActions } from './app-menu';
export {
  parseWindowState,
  fitToDisplays,
  loadWindowState,
  saveWindowState,
  DEFAULT_WINDOW_STATE,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  SIDEBAR_DEFAULT,
} from './window-state';
export type { WindowState } from './window-state';
