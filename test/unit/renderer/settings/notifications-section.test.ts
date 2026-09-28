import { act, createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditionInfo, Settings } from '../../../../src/preload/contract';
import {
  PUBLIC_EDITION,
  button,
  click,
  flush,
  installFakeApi,
  loadRenderer,
  ok,
  render,
  settings,
  type Component,
  type FakeApi,
} from '../harness';

/** Settings > Notifications (11 §7 "Notifications section", §14.6, §14.7). */

const { NotificationsSection } = await loadRenderer<{ NotificationsSection: Component }>(
  'settings/sections/NotificationsSection.tsx',
);
const { useSettingSaver } = await loadRenderer<{ useSettingSaver: () => unknown }>('settings/save.tsx');
const { EditionProvider } = await loadRenderer<{ EditionProvider: Component }>('edition/FeatureGate.tsx');

const REMOTE_EDITION: EditionInfo = {
  ...PUBLIC_EDITION,
  edition: 'enterprise',
  publishers: [
    { id: 'local', available: true },
    { id: 'drive', available: true },
  ],
};

let fake: FakeApi;

beforeEach(() => {
  fake = installFakeApi();
});

const mount = (s: Settings = settings()) =>
  render(
    function Host(p: Record<string, unknown>) {
      const saver = useSettingSaver();
      return createElement(EditionProvider, null, createElement(NotificationsSection, { settings: p.settings, saver }));
    },
    { settings: s },
  );

const section = (host: HTMLElement) => host.querySelector<HTMLElement>('#settings-notifications')!;
const input = (host: HTMLElement, label: string) =>
  Array.from(section(host).querySelectorAll<HTMLInputElement>('input')).find((i) =>
    i.closest('label')?.textContent?.includes(label),
  );
const select = (host: HTMLElement) => section(host).querySelector<HTMLSelectElement>('select')!;

/** Waits past the 300 ms save debounce. */
const settle = async () => {
  await act(async () => new Promise((r) => setTimeout(r, 350)));
  await flush();
};

async function change(el: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('NotificationsSection (11 §7)', () => {
  it('shows the enable switch, on by default, and saves it on change', async () => {
    const host = await mount();
    const sw = input(host, 'Notify me when a document is ready')!;
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.checked).toBe(true);
    await click(sw);
    await settle();
    expect(fake.api.settings.set).toHaveBeenCalledWith({ notifications: { enabled: false } });
    expect(section(host).textContent).toContain('Saved');
  });

  it('public edition: "Open it in ELI5 Learner" is selected; the published-link option and select are disabled with the explanation', async () => {
    const host = await mount();
    const app = input(host, 'Open it in ELI5 Learner')!;
    const link = input(host, 'Open its published link in my browser')!;
    expect(section(host).querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe(
      'When I click a notification',
    );
    expect(app.checked).toBe(true);
    expect(app.disabled).toBe(false);
    expect(link.disabled).toBe(true);
    expect(select(host).disabled).toBe(true);
    expect(Array.from(select(host).options).map((o) => [o.value, o.textContent])).toEqual([
      ['most-recent', 'Most recent'],
      ['drive', 'Cloud drive'],
      ['site', 'GitHub Pages'],
    ]);
    expect(section(host).textContent).toContain(
      'Available when documents can be published to a cloud drive or GitHub Pages',
    );
  });

  it('public edition: a hand-set published-link value shows selected but disabled', async () => {
    const s = settings();
    s.notifications.clickAction = 'published-link';
    const host = await mount(s);
    const link = input(host, 'Open its published link in my browser')!;
    expect(link.checked).toBe(true);
    expect(link.disabled).toBe(true);
    expect(select(host).disabled).toBe(true);
  });

  it('with a remote publisher: the link radio is enabled and saves; the select follows the radio', async () => {
    fake = installFakeApi(REMOTE_EDITION);
    const host = await mount();
    const link = input(host, 'Open its published link in my browser')!;
    expect(link.disabled).toBe(false);
    expect(select(host).disabled).toBe(true);
    expect(section(host).textContent).not.toContain('Available when documents can be published');
    await click(link);
    await settle();
    expect(fake.api.settings.set).toHaveBeenCalledWith({ notifications: { clickAction: 'published-link' } });
  });

  it('with a remote publisher and published-link chosen: the select saves preferredLink', async () => {
    fake = installFakeApi(REMOTE_EDITION);
    const s = settings();
    s.notifications.clickAction = 'published-link';
    const host = await mount(s);
    expect(select(host).disabled).toBe(false);
    expect(select(host).value).toBe('most-recent');
    await change(select(host), 'site');
    await settle();
    expect(fake.api.settings.set).toHaveBeenCalledWith({ notifications: { preferredLink: 'site' } });
  });

  it('a stub remote publisher (available:false) does not count', async () => {
    fake = installFakeApi({
      ...PUBLIC_EDITION,
      publishers: [
        { id: 'local', available: true },
        { id: 'git', available: false },
      ],
    });
    const host = await mount();
    expect(input(host, 'Open its published link in my browser')!.disabled).toBe(true);
  });
});

describe('Send test notification (11 §7, §14.7)', () => {
  it('shows the sent text for shown:true', async () => {
    fake.api.app.testNotification = vi.fn(async () => ok({ shown: true }));
    const host = await mount();
    await click(button(host, 'Send test notification'));
    expect(fake.api.app.testNotification).toHaveBeenCalledOnce();
    expect(section(host).textContent).toContain('Sent. If nothing appeared, check macOS notification settings.');
  });

  it('shows "Notifications are turned off" for reason disabled', async () => {
    fake.api.app.testNotification = vi.fn(async () => ok({ shown: false, reason: 'disabled' as const }));
    const host = await mount();
    await click(button(host, 'Send test notification'));
    expect(section(host).textContent).toContain('Notifications are turned off');
  });

  it('unsupported: shows the unsupported text and disables the switch and radios', async () => {
    fake = installFakeApi(REMOTE_EDITION);
    fake.api.app.testNotification = vi.fn(async () => ok({ shown: false, reason: 'unsupported' as const }));
    const host = await mount();
    await click(button(host, 'Send test notification'));
    expect(section(host).textContent).toContain("Notifications aren't supported on this system");
    expect(input(host, 'Notify me when a document is ready')!.disabled).toBe(true);
    expect(input(host, 'Open it in ELI5 Learner')!.disabled).toBe(true);
    expect(input(host, 'Open its published link in my browser')!.disabled).toBe(true);
  });

  it('shows an IPC error inline', async () => {
    const host = await mount();
    await click(button(host, 'Send test notification'));
    expect(section(host).textContent).toContain('Not implemented yet');
  });
});

describe('permission line (11 §7, §14.6)', () => {
  it('explains how to allow notifications and opens the macOS settings', async () => {
    fake.api.app.openNotificationSettings = vi.fn(async () => ok(undefined));
    const host = await mount();
    expect(section(host).textContent).toContain(
      "macOS asks for permission the first time ELI5 Learner shows a notification. If you don't see them, allow them in System Settings > Notifications > ELI5 Learner > Allow notifications.",
    );
    await click(button(host, 'Open macOS notification settings'));
    expect(fake.api.app.openNotificationSettings).toHaveBeenCalledOnce();
  });
});
