import { expect, test, type ElectronApplication } from '@playwright/test';
import { Harness, generate, type Launched } from './harness';

/**
 * Settings > Sync end to end (16 §8, §12; 11 §7): turn Sync on, save the Google client, connect
 * (the real loopback sign-in against the test build's stand-in for the browser and Google), Sync
 * now, the document's files appear in the in-memory store, the sidebar indicator, and Delete cloud
 * copy. Test builds with ELI5_SYNC_FAKE=1 swap in the store and the stand-in (13 §6.1); no request
 * leaves the machine. Client values are assembled at runtime (13 §3).
 */

test.describe.configure({ mode: 'serial' });

const h = new Harness();
test.afterAll(() => h.cleanup());
test.afterEach(() => h.assertNoModals());

const CLIENT_ID = ['123456789012', 'e2e0'.repeat(8)].join('-') + '.apps.' + 'googleusercontent.com';
const CLIENT_SECRET = ['e2e', 'client', 'secret', 'x'.repeat(16)].join('-');
const CLIENT_JSON = JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } });

interface StoredFile {
  id: string;
  name: string;
  props: { k: string; dev: string; d?: string };
}

const storeFiles = (app: ElectronApplication): Promise<StoredFile[]> =>
  app.evaluate(() => {
    const s = (globalThis as { __eli5FakeSyncStore?: { snapshot(): StoredFile[] } }).__eli5FakeSyncStore;
    return s ? s.snapshot() : [];
  });

const storeText = (app: ElectronApplication, id: string): Promise<string> =>
  app.evaluate((_e, fileId) => {
    const s = (globalThis as { __eli5FakeSyncStore?: { text(id: string): string | undefined } }).__eli5FakeSyncStore;
    return s?.text(fileId) ?? '';
  }, id);

let l: Launched;

test('Sync is off by default: no indicator, the section shows the privacy line', async () => {
  const dirs = await h.tempDirs('eli5-e2e-sync-');
  l = await h.launch(dirs, {
    env: { ELI5_SYNC_FAKE: '1', ELI5_GOOGLE_CLIENT_ID: '', ELI5_GOOGLE_CLIENT_SECRET: '' },
  });
  await generate(l);
  await expect(l.win.locator('.sync-indicator')).toHaveCount(0);
  await l.win.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = l.win.locator('#settings-sync');
  await expect(section.getByRole('heading', { name: 'Sync' })).toBeVisible();
  await expect(section).toContainText('Turning this on copies your learnings (not your sources or notes)');
  await expect(section.getByRole('switch', { name: 'Sync with my Google Drive' })).not.toBeChecked();
  await expect(section.getByRole('button', { name: 'Connect Google Drive' })).toBeDisabled();
  expect(await storeFiles(l.app)).toEqual([]);
});

test('turn on, save the client, connect, and the document reaches the store', async () => {
  const section = l.win.locator('#settings-sync');
  await section.getByRole('switch', { name: 'Sync with my Google Drive' }).check();
  await section.getByLabel('Google client JSON').fill(CLIENT_JSON);
  await section.getByRole('button', { name: 'Save client' }).click();
  await expect(section).toContainText('Client saved in Keychain');
  await expect(section.getByLabel('Google client JSON')).toHaveCount(0);

  await section.getByRole('button', { name: 'Connect Google Drive' }).click();
  await expect(section.getByTestId('sync-account')).toHaveText('Connected as tester@example.com');

  await section.getByRole('button', { name: 'Sync now' }).click();
  await expect
    .poll(async () => new Set((await storeFiles(l.app)).map((f) => f.props.k)), { timeout: 20_000 })
    .toEqual(new Set(['info', 'claim', 'device', 'lib', 'tree', 'blob']));
  const lib = (await storeFiles(l.app)).find((f) => f.props.k === 'lib');
  const manifest = JSON.parse(await storeText(l.app, lib!.id)) as { docs: { title: string }[] };
  const entries = await l.win.evaluate(() => window.eli5.library.list());
  expect(entries.ok && manifest.docs.map((d) => d.title)).toEqual(entries.ok ? entries.value.map((e) => e.title) : []);
  await expect(section.getByTestId('sync-status')).toContainText(/Last synced/);
  await expect(section.getByRole('list', { name: 'Devices' })).toContainText('primary (this Mac)');

  // No sync answer carries the client or a token (16 §3.2, 01 §5.2).
  const status = JSON.stringify(await l.win.evaluate(() => window.eli5.sync.status()));
  expect(status).not.toContain(CLIENT_ID);
  expect(status).not.toContain(CLIENT_SECRET);
  expect(status).not.toMatch(/fake-grant|fake-access/);
});

test('the sidebar indicator shows synced and opens Settings > Sync', async () => {
  const indicator = l.win.locator('.sync-indicator');
  await expect(indicator).toHaveAttribute('data-state', 'synced');
  await l.win.getByRole('button', { name: 'Settings', exact: true }).click(); // leave Settings
  await expect(l.win.locator('#settings-sync')).toHaveCount(0);
  await indicator.click();
  await expect(l.win.locator('#settings-sync')).toBeVisible();
});

test('Delete cloud copy empties the store and turns Sync off; the library stays', async () => {
  const section = l.win.locator('#settings-sync');
  const before = await l.win.evaluate(() => window.eli5.library.list());
  await section.getByRole('button', { name: 'Delete cloud copy' }).click();
  await section
    .getByRole('group', { name: 'Confirm delete cloud copy' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(section).toContainText('Cloud copy deleted. Sync is off.');
  await expect.poll(() => storeFiles(l.app)).toEqual([]);
  await expect(section.getByRole('switch', { name: 'Sync with my Google Drive' })).not.toBeChecked();
  await expect(l.win.locator('.sync-indicator')).toHaveCount(0);
  expect(await l.win.evaluate(() => window.eli5.library.list())).toEqual(before);
});
