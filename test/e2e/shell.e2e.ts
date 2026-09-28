import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * M1b shell skeleton (11 §3–6, 13 §8 E12/E14): layout and empty states against the stubbed
 * handlers, viewer attach/detach, inline input hints, close-to-hide, and the Tray driven through
 * the test-only `eli5:test:tray-click` channel. Requires a test build (ELI5_TEST_BUILD=1).
 */

let app: ElectronApplication;
let win: Page;
let userData: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'eli5-e2e-shell-'));
  app = await electron.launch({
    args: [path.resolve('.')],
    env: {
      ...process.env,
      ELI5_USER_DATA_DIR: userData,
      ELI5_LIBRARY_DIR: path.join(userData, 'library'),
      ELI5_KEYSTORE: 'memory',
      TZ: 'UTC',
    },
  });
  win = await app.firstWindow();
  testBuild = await app.evaluate(({ ipcMain }) => ipcMain.listenerCount('eli5:test:tray-click') > 0);
});

/** The Tray driver channel exists only in ELI5_TEST_BUILD=1 builds (`npm run test:e2e`). */
let testBuild = false;
const requireTestBuild = (): void => test.skip(!testBuild, 'needs an ELI5_TEST_BUILD=1 build (npm run test:e2e)');

test.afterAll(async () => {
  await app?.close().catch(() => {});
  await rm(userData, { recursive: true, force: true });
});

interface TrayState {
  labels: string[];
  tooltip: string;
  quit: string;
}

async function tray(req: { click?: string } = {}): Promise<TrayState> {
  return app.evaluate(({ ipcMain }, r) => {
    let state: TrayState = { labels: [], tooltip: '', quit: '' };
    ipcMain.emit('eli5:test:tray-click', {}, { ...r, inspect: (s: TrayState) => (state = s) });
    return state;
  }, req);
}

const windowState = () =>
  app.evaluate(({ BrowserWindow, app: a }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { count: BrowserWindow.getAllWindows().length, visible: w?.isVisible() ?? false, dock: a.dock?.isVisible() };
  });

const clickMenu = (id: string) =>
  app.evaluate(({ Menu }, menuId) => {
    Menu.getApplicationMenu()?.getMenuItemById(menuId)?.click();
  }, id);

test('layout regions and empty states render against stubbed handlers', async () => {
  await expect(win.getByRole('navigation', { name: 'Library' })).toBeVisible();
  await expect(win.getByRole('main', { name: 'Viewer' })).toBeVisible();
  await expect(win.getByRole('form', { name: 'New explainer' })).toBeVisible();
  await expect(win.getByRole('region', { name: 'Jobs' })).toBeAttached();
  // library:list is an M2 handler; the sidebar degrades to its inline error with Retry (11 §13).
  await expect(win.getByText('Could not load the Library')).toBeVisible();
  await expect(win.getByRole('button', { name: 'Retry' })).toBeVisible();
  // First run, no key (11 §8).
  await expect(win.getByRole('heading', { name: 'Turn anything into an explainer.' })).toBeVisible();
  await expect(win.getByRole('button', { name: 'Add an API key' })).toBeVisible();
  // No suggestions heading, no job lines, no enterprise UI (HOOK-UI-01).
  await expect(win.getByText(/^Suggestions/)).toHaveCount(0);
  await expect(win.locator('.job-line')).toHaveCount(0);
  await expect(win.getByRole('button', { name: /sign in/i })).toHaveCount(0);
  await expect(win.getByRole('button', { name: /publish/i })).toHaveCount(0);

  // Status area sits in the lower right.
  const status = await win.getByRole('region', { name: 'Jobs' }).boundingBox();
  const input = await win.getByRole('form', { name: 'New explainer' }).boundingBox();
  const viewport = win.viewportSize() ?? { width: 1280, height: 820 };
  expect(status && input && status.x > input.x).toBe(true);
  expect(status && status.x + status.width).toBeGreaterThan(viewport.width - 5);
});

test('application menu has no quit role and binds Cmd+Q/Cmd+W to Close Window', async () => {
  const menu = await app.evaluate(({ Menu }) => {
    const out: { role?: string; label: string; accelerator?: string; enabled: boolean }[] = [];
    const walk = (m: Electron.Menu | null) =>
      m?.items.forEach((i) => {
        out.push({
          role: i.role ?? undefined,
          label: i.label,
          accelerator: i.accelerator ?? undefined,
          enabled: i.enabled,
        });
        walk(i.submenu ?? null);
      });
    walk(Menu.getApplicationMenu());
    return out;
  });
  expect(menu.some((i) => i.role?.toLowerCase() === 'quit')).toBe(false);
  expect(menu.some((i) => i.role?.toLowerCase() === 'reload')).toBe(false);
  expect(menu.filter((i) => i.label === 'Close Window').map((i) => i.accelerator)).toEqual([
    'CmdOrCtrl+Q',
    'CmdOrCtrl+W',
  ]);
  expect(menu.find((i) => i.label === 'Quit from the menu bar icon')?.enabled).toBe(false);
});

test('Enter never starts a job without sources, with an invalid URL, or without a key', async () => {
  const url = win.getByLabel('URL', { exact: true });
  await url.click();
  await url.press('Enter');
  await expect(win.getByText('Add a file, paste, or URL first')).toBeVisible();

  await url.fill('not a url');
  await url.press('Enter');
  await expect(win.getByText('Enter a web address that starts with http:// or https://')).toBeVisible();
  await expect(url).toBeFocused();
  await expect(url).toHaveValue('not a url');

  await url.fill('https://example.com/article');
  await url.press('Enter');
  await expect(win.getByText('Add an API key in Settings to start')).toBeVisible();
  await expect(win.getByRole('list', { name: 'Added sources' }).getByText('example.com/article')).toBeVisible();
});

test('with a key, the start request reaches main and an error keeps the draft', async () => {
  const key = 'sk-ant-test-' + 'k'.repeat(24);
  await win.evaluate((k) => window.eli5.settings.setApiKey('claude', k), key);
  await win.getByLabel('Specifics').fill('Focus on the pricing section');
  await win.getByRole('button', { name: 'Start' }).click();
  // eli5:jobs:start is an M2 handler: the stub error renders inline, the draft is kept (11 §5.4 step 6).
  await expect(win.getByText('Not implemented yet')).toBeVisible();
  await expect(win.getByRole('list', { name: 'Added sources' }).getByText('example.com/article')).toBeVisible();
  await expect(win.getByLabel('Specifics')).toHaveValue('Focus on the pricing section');
});

test('doc route attaches the viewer and reports its bounds; settings detaches it', async () => {
  const children = () =>
    app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      return w.contentView.children.map((c) => c.getBounds());
    });
  expect(await children()).toHaveLength(0);

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.send('eli5:app:navigate', {
      route: { view: 'doc', slug: 'topic-a' },
    }),
  );
  const slot = win.getByTestId('viewer-slot');
  await expect(slot).toBeAttached();
  await expect.poll(async () => (await children()).length).toBe(1);
  const box = await slot.boundingBox();
  await expect
    .poll(async () => {
      const b = (await children())[0];
      return b && box ? Math.abs(b.x - box.x) + Math.abs(b.y - box.y) + Math.abs(b.width - box.width) : 999;
    })
    .toBeLessThan(3);

  await win.keyboard.press('Meta+,');
  await expect(win.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect.poll(async () => (await children()).length).toBe(0);
  await win.keyboard.press('Escape');
  await expect(slot).toBeAttached();
  await expect.poll(async () => (await children()).length).toBe(1);
});

test('close hides the window and the Dock icon; the Tray brings it back', async () => {
  requireTestBuild();
  expect(await tray()).toMatchObject({
    labels: ['No documents yet', 'Open ELI5 Learner', 'Settings…', 'Quit'],
    tooltip: 'ELI5 Learner',
    quit: 'Quit',
  });

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect.poll(windowState).toMatchObject({ count: 1, visible: false, dock: false });

  await tray({ click: 'Open ELI5 Learner' });
  await expect.poll(windowState).toMatchObject({ count: 1, visible: true, dock: true });

  await clickMenu('close-window-w');
  await expect.poll(windowState).toMatchObject({ visible: false, dock: false });
  await tray({ click: 'Settings…' });
  await expect.poll(windowState).toMatchObject({ visible: true, dock: true });
  await expect(win.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

  await clickMenu('close-window-q');
  await expect.poll(windowState).toMatchObject({ count: 1, visible: false });
});

test('Tray > Quit exits without confirmation', async () => {
  requireTestBuild();
  const closed = app.waitForEvent('close');
  await tray({ click: 'Quit' });
  await closed;
});
