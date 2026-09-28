import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

/** M0 acceptance: the public build boots, exposes window.eli5, and hides (not quits) on close. */

let app: ElectronApplication;
let userData: string;

test.beforeAll(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'eli5-e2e-'));
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
});

test.afterAll(async () => {
  await app?.close();
  await rm(userData, { recursive: true, force: true });
});

test('boots the public edition with a secure main window', async () => {
  const win = await app.firstWindow();
  await expect(win).toHaveTitle('ELI5 Learner');
  await expect(win.getByRole('heading', { name: 'Turn anything into an explainer.' })).toBeVisible();
  await win.getByRole('button', { name: 'Settings' }).click();
  await expect(win.getByText('Public edition')).toBeVisible();

  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    // Internal but stable Electron API used by 12 §14; not in the public typings.
    const wc = w.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> };
    return wc.getLastWebPreferences();
  });
  expect(prefs).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true });

  const hasNode = await win.evaluate(() => typeof (globalThis as { require?: unknown }).require);
  expect(hasNode).toBe('undefined');
});

test('window.eli5 answers IPC with IpcResult envelopes', async () => {
  const win = await app.firstWindow();
  const info = await win.evaluate(() => window.eli5.edition.info());
  expect(info).toMatchObject({ ok: true, value: { edition: 'public', overlayLoaded: false, uiFeatures: [] } });

  const signIn = await win.evaluate(() => window.eli5.auth.signIn());
  expect(signIn).toMatchObject({ ok: false, error: { code: 'E_NOT_AVAILABLE_IN_EDITION', hookId: 'HOOK-AUTH-01' } });

  // A fresh Library lists no documents (09 §11).
  const list = await win.evaluate(() => window.eli5.library.list());
  expect(list).toMatchObject({ ok: true, value: [] });
});

test('API key goes to the key store, never to settings.json', async () => {
  const win = await app.firstWindow();
  await expect(win.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  const fakeKey = 'sk-ant-test-' + 'k'.repeat(24);
  await win.getByLabel('API key').fill(fakeKey);
  await win.getByRole('button', { name: 'Save key' }).click();
  await expect(win.getByText('Key saved').first()).toBeVisible();
  // Controlled by settings: the radio updates after the eli5:settings:changed round trip.
  await win.getByLabel('OpenAI').click();
  await expect(win.getByLabel('OpenAI')).toBeChecked();
  await expect(win.getByText('No key')).toBeVisible();

  const settings = await readFile(path.join(userData, 'settings.json'), 'utf8');
  expect(JSON.parse(settings)).toMatchObject({ llm: { provider: 'openai', model: null } });
  expect(settings).not.toContain(fakeKey);
  const log = await readFile(path.join(userData, 'logs', 'main.log'), 'utf8');
  expect(log).toContain('"event":"app.ready"');
  expect(log).not.toContain(fakeKey);
});

test('closing the window hides it; the app keeps running', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  const state = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { exists: !!w, visible: w?.isVisible() ?? false };
  });
  expect(state).toEqual({ exists: true, visible: false });
});

test('bootstrap opens the Library and serves eli5doc:// on the viewer session only', async () => {
  const root = path.join(userData, 'library');
  await access(path.join(root, 'catalog.json'));
  await access(path.join(root, '.eli5', 'library.lock'));
  const status = await app.evaluate(async ({ session }) => {
    const viewer = session.fromPartition('eli5-viewer');
    const res = await viewer.fetch('eli5doc://doc/not-catalogued/index.html');
    return { viewer: res.status, defaultHandled: session.defaultSession.protocol.isProtocolHandled('eli5doc') };
  });
  expect(status).toEqual({ viewer: 404, defaultHandled: false });
});
