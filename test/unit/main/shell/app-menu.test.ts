import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  appMenuTemplate,
  libraryItemMenuTemplate,
  MENU_IDS,
  MENU_SHORTCUT_KEYS,
  type MenuShortcutId,
} from '../../../../src/main/shell/app-menu';

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flatten(i.submenu) : [])]);
}

const click = (i: MenuItemConstructorOptions | undefined) =>
  i?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);

describe('appMenuTemplate (11 §3.2 step 5, §9)', () => {
  const actions = {
    hideWindow: vi.fn(),
    openSettings: vi.fn(),
    shortcut: vi.fn(),
    reloadViewer: vi.fn(),
    openHelp: vi.fn(),
  };
  const all = flatten(appMenuTemplate(actions, { appName: 'ELI5 Learner', devTools: false }));

  it('has no quit or reload role', () => {
    const roles = all.map((i) => i.role).filter(Boolean);
    expect(roles).not.toContain('quit');
    expect(roles).not.toContain('reload');
    expect(roles).not.toContain('forceReload');
    expect(roles).not.toContain('toggleDevTools');
  });

  it('binds Cmd+Q and Cmd+W to Close Window (hide)', () => {
    const q = all.find((i) => i.id === MENU_IDS.closeQ);
    const w = all.find((i) => i.id === MENU_IDS.closeW);
    expect(q).toMatchObject({ label: 'Close Window', accelerator: 'CmdOrCtrl+Q' });
    expect(w).toMatchObject({ label: 'Close Window', accelerator: 'CmdOrCtrl+W' });
    click(q);
    click(w);
    expect(actions.hideWindow).toHaveBeenCalledTimes(2);
  });

  it('shows the quit hint as a disabled item under Close Window', () => {
    const app = appMenuTemplate(actions, { appName: 'ELI5 Learner', devTools: false })[0]!;
    const sub = app.submenu as MenuItemConstructorOptions[];
    const qi = sub.findIndex((i) => i.id === MENU_IDS.closeQ);
    expect(sub[qi + 1]).toMatchObject({ label: 'Quit from the menu bar icon', enabled: false });
  });

  it('Cmd+, opens Settings', () => {
    const s = all.find((i) => i.id === MENU_IDS.settings);
    expect(s?.accelerator).toBe('CmdOrCtrl+,');
    click(s);
    expect(actions.openSettings).toHaveBeenCalledOnce();
  });

  it('keeps the Edit roles so text fields can paste', () => {
    expect(all.map((i) => i.role)).toEqual(expect.arrayContaining(['copy', 'paste', 'cut', 'selectAll']));
  });

  it('adds DevTools only in dev builds', () => {
    const dev = flatten(appMenuTemplate(actions, { appName: 'ELI5 Learner', devTools: true }));
    expect(dev.map((i) => i.role)).toContain('toggleDevTools');
  });
});

describe('application menu mirrors the window shortcuts (11 §9)', () => {
  const actions = {
    hideWindow: vi.fn(),
    openSettings: vi.fn(),
    shortcut: vi.fn(),
    reloadViewer: vi.fn(),
    openHelp: vi.fn(),
  };
  const all = flatten(appMenuTemplate(actions, { appName: 'ELI5 Learner', devTools: false }));

  const mirrored: [MenuShortcutId, string][] = [
    ['new-draft', 'CmdOrCtrl+N'],
    ['focus-url', 'CmdOrCtrl+L'],
    ['focus-filter', 'CmdOrCtrl+F'],
    ['toggle-sidebar', 'CmdOrCtrl+\\'],
    ['prev-doc', 'CmdOrCtrl+['],
    ['next-doc', 'CmdOrCtrl+]'],
  ];

  it.each(mirrored)('%s has a menu item with accelerator %s that runs the shortcut in the app', (id, accel) => {
    const item = all.find((i) => i.id === `shortcut-${id}`);
    expect(item?.accelerator).toBe(accel);
    actions.shortcut.mockClear();
    click(item);
    expect(actions.shortcut).toHaveBeenCalledWith(id);
  });

  it('forwards each shortcut as the Cmd+key its accelerator names (the renderer maps it back, settings-shortcuts test)', () => {
    for (const [id, accel] of mirrored) expect(`CmdOrCtrl+${MENU_SHORTCUT_KEYS[id]}`, id).toBe(accel);
  });

  it('Cmd+R reloads the viewer, never the app renderer', () => {
    const r = all.find((i) => i.accelerator === 'CmdOrCtrl+R');
    expect(r).toMatchObject({ id: MENU_IDS.reloadViewer, label: 'Reload Document' });
    expect(r?.role).toBeUndefined();
    click(r);
    expect(actions.reloadViewer).toHaveBeenCalledOnce();
  });

  it('every accelerator is unique', () => {
    const accels = all.map((i) => i.accelerator).filter(Boolean);
    expect(new Set(accels).size).toBe(accels.length);
  });

  it('the Help menu opens the README, the Pages help page and the license notices (HOOK-UI-02)', () => {
    const help = appMenuTemplate(actions, { appName: 'ELI5 Learner', devTools: false }).find((m) => m.role === 'help');
    const items = (help?.submenu as MenuItemConstructorOptions[]).filter((i) => i.type !== 'separator');
    items.forEach(click);
    expect(actions.openHelp.mock.calls.map((c: unknown[]) => c[0])).toEqual(['readme', 'publish-pages', 'licenses']);
  });
});

describe('libraryItemMenuTemplate (11 §5.2)', () => {
  it('offers Open and Reveal in Finder only in the public build', () => {
    const a = { open: vi.fn(), reveal: vi.fn() };
    const items = libraryItemMenuTemplate('topic-a', a);
    expect(items.map((i) => i.label)).toEqual(['Open', 'Reveal in Finder']);
    items.forEach(click);
    expect(a.open).toHaveBeenCalledWith('topic-a');
    expect(a.reveal).toHaveBeenCalledWith('topic-a');
  });
});
