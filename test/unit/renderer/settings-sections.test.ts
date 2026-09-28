import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditionInfo } from '../../../src/preload/contract';
import { PUBLIC_EDITION, installFakeApi, loadRenderer, render, settings, type Component } from './harness';

/**
 * Settings route skeleton (11 §7): one component file per section under settings/sections/, so
 * each M3 slice fills in only its own file. SettingsScreen composes them in the 11 §7 order.
 */

const { SettingsScreen } = await loadRenderer<{ SettingsScreen: Component }>('settings/SettingsScreen.tsx');
const { EditionProvider } = await loadRenderer<{ EditionProvider: Component }>('edition/FeatureGate.tsx');

const SECTION_FILES = [
  ['AiSection', 'ai'],
  ['DocumentsSection', 'documents'],
  ['LibrarySection', 'library'],
  ['PublishingSection', 'publishing'],
  ['NotificationsSection', 'notifications'],
  ['AboutSection', 'about'],
  ['EnterpriseSection', 'enterprise'],
] as const;

const mount = () =>
  render(
    function Screen(p: Record<string, unknown>) {
      return createElement(EditionProvider, null, createElement(SettingsScreen, p));
    },
    { settings: settings(), onKeyChanged: vi.fn() },
  );

beforeEach(() => {
  installFakeApi();
});

describe('settings sections (11 §7)', () => {
  it('each section lives in its own component file', async () => {
    for (const [name] of SECTION_FILES) {
      const mod = await loadRenderer<Record<string, unknown>>(`settings/sections/${name}.tsx`);
      expect(typeof mod[name], name).toBe('function');
    }
  });

  it('renders the public sections in order, each with a focusable heading; Enterprise is absent', async () => {
    const host = await mount();
    const ids = Array.from(host.querySelectorAll('.settings > section')).map((s) => s.id);
    expect(ids).toEqual([
      'settings-ai',
      'settings-documents',
      'settings-library',
      'settings-publishing',
      'settings-notifications',
      'settings-about',
    ]);
    for (const id of ids) expect(host.querySelector(`#${id} h2`)?.getAttribute('tabindex'), id).toBe('-1');
    expect(host.querySelector('#settings-notifications h2')?.textContent).toBe('Notifications');
  });

  it('mounts the Enterprise section only when HOOK-UI-01 enables it', async () => {
    const enterprise: EditionInfo = { ...PUBLIC_EDITION, edition: 'enterprise', uiFeatures: ['auth.signIn'] };
    installFakeApi(enterprise);
    const host = await mount();
    expect(host.querySelector('#settings-enterprise')).not.toBeNull();
  });

  it('About shows the app version from EditionInfo (HOOK-UI-02)', async () => {
    const host = await mount();
    expect(host.querySelector('#settings-about')?.textContent).toContain('0.1.0');
  });
});
