import { act, createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../../../../src/preload/contract';
import {
  button,
  click,
  flush,
  installFakeApi,
  loadRenderer,
  notImplemented,
  ok,
  render,
  settings,
  syncStatus,
  type,
  type Component,
  type FakeApi,
} from '../harness';

/** Settings > Sync (11 §7 "Sync section", 16 §8). */

const { SyncSection } = await loadRenderer<{ SyncSection: Component }>('settings/sections/SyncSection.tsx');
const { useSettingSaver } = await loadRenderer<{ useSettingSaver: () => unknown }>('settings/save.tsx');

let fake: FakeApi;

beforeEach(() => {
  fake = installFakeApi();
});

const on = (over: Partial<Settings['sync']> = {}): Settings => {
  const s = settings();
  s.sync = { ...s.sync, enabled: true, ...over };
  return s;
};

const mount = (s: Settings = settings(), locked: string[] = []) =>
  render(
    function Host(p: Record<string, unknown>) {
      const saver = useSettingSaver();
      return createElement(SyncSection, {
        settings: p.settings,
        saver,
        isLocked: (k: string) => locked.includes(k),
      });
    },
    { settings: s },
  );

const section = (host: HTMLElement) => host.querySelector<HTMLElement>('#settings-sync')!;
const toggle = (host: HTMLElement, label: string) =>
  Array.from(section(host).querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((i) =>
    i.closest('label')?.textContent?.includes(label),
  );
const settle = async () => {
  await act(async () => new Promise((r) => setTimeout(r, 30)));
  await flush();
};

describe('SyncSection (11 §7)', () => {
  it('is absent when the sync policy does not allow sync (HOOK-SYNC-01)', async () => {
    vi.mocked(fake.api.sync.status).mockResolvedValue({
      ok: false,
      error: { code: 'E_NOT_AVAILABLE_IN_EDITION', message: 'Not available in this edition', hookId: 'HOOK-SYNC-01' },
    });
    const host = await mount();
    expect(host.querySelector('#settings-sync')).toBeNull();
  });

  it('shows the privacy line first, the Sync switch off by default, and saves it at once', async () => {
    const host = await mount();
    const first = section(host).querySelector('p');
    expect(first?.textContent).toBe(
      'Turning this on copies your learnings (not your sources or notes) to a hidden folder in your Google Drive. Google can read them.',
    );
    const sw = toggle(host, 'Sync with my Google Drive')!;
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.checked).toBe(false);
    await click(sw);
    await settle();
    expect(fake.api.settings.set).toHaveBeenCalledWith({ sync: { enabled: true } });
  });

  it('without a client: Connect is disabled and the client JSON is saved write-only', async () => {
    vi.mocked(fake.api.sync.status).mockResolvedValue(ok(syncStatus({ state: 'not-configured' })));
    const host = await mount(on());
    expect(button(host, 'Connect Google Drive')?.disabled).toBe(true);
    expect(section(host).textContent).toContain('Save your Google client first');
    const field = section(host).querySelector<HTMLTextAreaElement>('textarea[aria-label="Google client JSON"]')!;
    expect(button(host, 'Save client')?.disabled).toBe(true);
    await type(field, '{"installed":{}}');
    await click(button(host, 'Save client'));
    expect(fake.api.sync.setClient).toHaveBeenCalledWith('{"installed":{}}');
    // Saved: the field is gone and nothing of the client is shown.
    expect(section(host).querySelector('textarea')).toBeNull();
    expect(section(host).textContent).toContain('Client saved in Keychain');
    expect(section(host).textContent).not.toContain('installed');
    expect(button(host, 'Remove')).toBeDefined();
  });

  it('a rejected client renders inline and keeps the text for correction', async () => {
    vi.mocked(fake.api.sync.setClient).mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'E_SYNC_FAILED',
        message: 'That is not a Google client JSON file',
        detailCode: 'E_SYNC_NOT_CONFIGURED',
      },
    });
    const host = await mount(on());
    const field = section(host).querySelector<HTMLTextAreaElement>('textarea')!;
    await type(field, 'nope');
    await click(button(host, 'Save client'));
    expect(section(host).querySelector('.inline-error')?.textContent).toBe('That is not a Google client JSON file');
    expect(section(host).querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('nope');
  });

  it('with a client but Sync off: Connect stays disabled with "Turn on Sync first"', async () => {
    vi.mocked(fake.api.sync.status).mockResolvedValue(ok(syncStatus({ configured: true })));
    const host = await mount();
    expect(button(host, 'Connect Google Drive')?.disabled).toBe(true);
    expect(section(host).textContent).toContain('Turn on Sync first');
  });

  it('Connect signs in, then shows the account and Disconnect', async () => {
    vi.mocked(fake.api.sync.status).mockResolvedValue(ok(syncStatus({ state: 'signed-out', configured: true })));
    vi.mocked(fake.api.sync.signIn).mockResolvedValueOnce(
      ok(syncStatus({ state: 'idle', configured: true, signedIn: true, account: 'reader@example.com' })),
    );
    const host = await mount(on());
    await click(button(host, 'Connect Google Drive'));
    expect(fake.api.sync.signIn).toHaveBeenCalledOnce();
    expect(section(host).querySelector('[data-testid="sync-account"]')?.textContent).toBe(
      'Connected as reader@example.com',
    );
    await click(button(host, 'Disconnect'));
    expect(fake.api.sync.signOut).toHaveBeenCalledOnce();
    expect(button(host, 'Connect Google Drive')).toBeDefined();
  });

  it('signed in: Sync now, last synced, pending uploads, devices and the status from events', async () => {
    const t = new Date(Date.now() - 5 * 60_000).toISOString();
    vi.mocked(fake.api.sync.status).mockResolvedValue(
      ok(
        syncStatus({
          state: 'idle',
          configured: true,
          signedIn: true,
          lastSyncAt: t,
          pendingUploads: 2,
          devices: [
            { name: 'Example Mac', platform: 'macos', role: 'primary (this Mac)', lastSeen: t },
            { name: 'Pixel', platform: 'android', role: 'phone', lastSeen: t },
          ],
        }),
      ),
    );
    const host = await mount(on());
    const status = section(host).querySelector('[data-testid="sync-status"]')!;
    expect(status.textContent).toContain('Last synced 5m ago');
    expect(status.textContent).toContain('2 documents waiting to upload');
    expect(
      Array.from(section(host).querySelectorAll('ul[aria-label="Devices"] li')).map((li) => li.textContent),
    ).toEqual(['Example Mac · Mac · primary (this Mac) · seen 5m ago', 'Pixel · Android · phone · seen 5m ago']);
    expect(section(host).textContent).toContain('Phones: Pixel (seen 5m ago)');
    await click(button(host, 'Sync now'));
    expect(fake.api.sync.now).toHaveBeenCalledOnce();
    fake.emit('sync', syncStatus({ state: 'syncing', configured: true, signedIn: true }));
    expect(button(host, 'Syncing…')?.disabled).toBe(true);
    fake.emit(
      'sync',
      syncStatus({ state: 'error', configured: true, signedIn: true, message: 'Your Google Drive is full' }),
    );
    expect(section(host).querySelector('[data-testid="sync-message"]')?.textContent).toBe('Your Google Drive is full');
    expect(button(host, 'Make this Mac the primary')).toBeUndefined();
  });

  it('a mirror Mac offers "Make this Mac the primary"', async () => {
    vi.mocked(fake.api.sync.status).mockResolvedValue(
      ok(syncStatus({ state: 'mirror', configured: true, signedIn: true, message: 'Another Mac is the primary' })),
    );
    vi.mocked(fake.api.sync.makePrimary).mockResolvedValueOnce(
      ok(
        syncStatus({
          state: 'mirror',
          configured: true,
          signedIn: true,
          message: 'Waiting for your other Mac to hand over',
        }),
      ),
    );
    const host = await mount(on());
    expect(section(host).textContent).toContain('Another Mac is the primary');
    await click(button(host, 'Make this Mac the primary'));
    expect(fake.api.sync.makePrimary).toHaveBeenCalledOnce();
    expect(section(host).textContent).toContain('Waiting for your other Mac to hand over');
  });

  it('Delete cloud copy asks inline once, then deletes; Cancel does nothing', async () => {
    vi.mocked(fake.api.sync.status).mockResolvedValue(
      ok(syncStatus({ state: 'idle', configured: true, signedIn: true })),
    );
    const host = await mount(on());
    await click(button(host, 'Delete cloud copy'));
    expect(section(host).querySelector('[aria-label="Confirm delete cloud copy"]')).not.toBeNull();
    await click(button(host, 'Cancel'));
    expect(fake.api.sync.deleteRemote).not.toHaveBeenCalled();
    await click(button(host, 'Delete cloud copy'));
    await click(button(host, 'Delete'));
    expect(fake.api.sync.deleteRemote).toHaveBeenCalledOnce();
    expect(section(host).textContent).toContain('Cloud copy deleted. Sync is off.');
  });

  it('Delete cloud copy is disabled while sync.enabled is managed', async () => {
    vi.mocked(fake.api.sync.status).mockResolvedValue(
      ok(syncStatus({ state: 'idle', configured: true, signedIn: true })),
    );
    const host = await mount(on(), ['sync.enabled']);
    expect(button(host, 'Delete cloud copy')?.disabled).toBe(true);
    expect(section(host).textContent).toContain('Sync is managed by your organization');
  });

  it('a failed delete shows the error inline and no success line', async () => {
    vi.mocked(fake.api.sync.status).mockResolvedValue(
      ok(syncStatus({ state: 'idle', configured: true, signedIn: true })),
    );
    vi.mocked(fake.api.sync.deleteRemote).mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'E_SYNC_FAILED',
        message: 'Sync could not finish. Try again in a moment',
        detailCode: 'E_SYNC_HTTP',
      },
    });
    const host = await mount(on());
    await click(button(host, 'Delete cloud copy'));
    await click(button(host, 'Delete'));
    expect(section(host).textContent).toContain('Sync could not finish. Try again in a moment');
    expect(section(host).textContent).not.toContain('Cloud copy deleted');
  });

  it('saves the versions choice and the phone inbox switch; locked keys are read-only', async () => {
    const host = await mount(on());
    const select = section(host).querySelector<HTMLSelectElement>('select[aria-label="Versions to sync"]')!;
    expect(select.value).toBe('recent');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Current only', 'Recent (10 newest)', 'All']);
    await act(async () => {
      select.value = 'all';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(fake.api.settings.set).toHaveBeenCalledWith({ sync: { history: 'all' } });
    const inbox = toggle(host, 'Accept jobs from phone')!;
    expect(inbox.checked).toBe(false);
    await click(inbox);
    await settle();
    expect(fake.api.settings.set).toHaveBeenCalledWith({ sync: { inbox: { enabled: true } } });

    const locked = await mount(on(), ['sync.enabled', 'sync.history', 'sync.inbox.enabled']);
    const sec = locked.querySelector<HTMLElement>('#settings-sync')!;
    expect(sec.querySelector<HTMLSelectElement>('select')?.disabled).toBe(true);
    for (const i of sec.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) expect(i.disabled).toBe(true);
  });

  it('another status failure shows one inline line, not a dialog', async () => {
    vi.mocked(fake.api.sync.status).mockResolvedValue(notImplemented);
    const host = await mount();
    expect(section(host).querySelector('.inline-error')?.textContent).toBe('Not implemented yet');
  });
});
