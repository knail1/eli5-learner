import { act, createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogEntry, EditionInfo, PublishResult, PublishTarget } from '../../../src/preload/contract';
import {
  PUBLIC_EDITION,
  button,
  click,
  flush,
  installFakeApi,
  key,
  loadRenderer,
  ok,
  render,
  settings,
  type,
  type Component,
  type FakeApi,
} from './harness';

const { App } = await loadRenderer<{ App: Component }>('App.tsx');
const { SettingsScreen } = await loadRenderer<{ SettingsScreen: Component }>('settings/SettingsScreen.tsx');
const { EditionProvider } = await loadRenderer<{ EditionProvider: Component }>('edition/FeatureGate.tsx');
const { DocHeader } = await loadRenderer<{ DocHeader: Component }>('viewer/DocHeader.tsx');

let fake: FakeApi;
beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
  fake = installFakeApi();
});

const entry = (title: string, createdAt: string): CatalogEntry => ({
  id: `id-${title}`,
  title,
  topicSlug: title.toLowerCase().replace(/\W+/g, '-'),
  createdAt,
  updatedAt: createdAt,
  summary: '',
  summarySource: 'fallback',
  tabCount: 2,
  mergedFromCount: 0,
});

describe('App layout and routes (11 §5, §6)', () => {
  it('renders the regions and first-run welcome against stubbed handlers', async () => {
    const host = await render(App);
    expect(host.querySelector('nav[aria-label="Library"]')).not.toBeNull();
    expect(host.querySelector('main')).not.toBeNull();
    expect(host.querySelector('form[aria-label="New explainer"]')).not.toBeNull();
    expect(host.querySelector('section[aria-label="Jobs"]')).not.toBeNull();
    expect(host.textContent).toContain('Turn anything into an explainer.');
    expect(host.textContent).toContain('Could not load the Library');
    // Welcome is not a doc route: the viewer is never attached.
    expect(fake.api.viewer.setVisible).not.toHaveBeenCalledWith(true);
  });

  it('shows the key-present welcome and the Library newest first', async () => {
    fake.api.settings.hasApiKey = async () => ok(true);
    fake.api.library.list = async () =>
      ok([entry('Older', '2026-01-01T00:00:00Z'), entry('Newer', '2026-02-01T00:00:00Z')]);
    const host = await render(App);
    expect(host.textContent).toContain('Drop files, paste a screenshot, or enter a URL below, then press Enter');
    expect(Array.from(host.querySelectorAll('.item-title')).map((e) => e.textContent)).toEqual(['Newer', 'Older']);
  });

  it('opening a document mounts the viewer slot, reports bounds and attaches the viewer', async () => {
    fake.api.library.list = async () => ok([entry('Topic A', '2026-01-01T00:00:00Z')]);
    const host = await render(App);
    await click(host.querySelector('.library-item'));
    expect(fake.api.library.open).toHaveBeenCalledWith('topic-a');
    expect(host.querySelector('[data-testid="viewer-slot"]')).not.toBeNull();
    expect(host.querySelector('.doc-header h1')?.textContent).toBe('Topic A');
    expect(fake.api.viewer.setBounds).toHaveBeenCalledWith(
      expect.objectContaining({ x: expect.any(Number), width: expect.any(Number) }),
    );
    expect(fake.api.viewer.setVisible).toHaveBeenLastCalledWith(true);
    expect(host.querySelector('[aria-current="page"]')?.textContent).toContain('Topic A');

    // Settings replaces the viewer area and detaches the viewer; Escape returns.
    await click(button(host, 'Settings'));
    expect(host.querySelector('[data-testid="viewer-slot"]')).toBeNull();
    expect(fake.api.viewer.setVisible).toHaveBeenLastCalledWith(false);
    await key(document.body, 'Escape');
    expect(host.querySelector('[data-testid="viewer-slot"]')).not.toBeNull();
  });

  it('follows eli5:app:navigate and shows not-found for a missing document', async () => {
    fake.api.library.list = async () => ok([entry('Topic A', '2026-01-01T00:00:00Z')]);
    const host = await render(App);
    fake.emit('navigate', { route: { view: 'doc', slug: 'gone' } });
    await flush();
    expect(host.textContent).toContain('This document’s files are missing.');
    fake.emit('navigate', { route: { view: 'settings' } });
    await flush();
    expect(host.querySelector('.settings h1')?.textContent).toBe('Settings');
  });

  it('reopens the last document at startup if it still exists', async () => {
    window.localStorage.setItem('eli5.lastDoc', 'topic-a');
    fake.api.library.list = async () => ok([entry('Topic A', '2026-01-01T00:00:00Z')]);
    const host = await render(App);
    expect(host.querySelector('[data-testid="viewer-slot"]')).not.toBeNull();
  });

  it('keyboard: Cmd+, opens settings, Cmd+\\ collapses the sidebar, Cmd+1 opens the first document', async () => {
    fake.api.library.list = async () => ok([entry('Topic A', '2026-01-01T00:00:00Z')]);
    const host = await render(App);
    await key(document.body, ',', { metaKey: true });
    expect(host.querySelector('.settings')).not.toBeNull();
    await key(document.body, '\\', { metaKey: true });
    expect(host.querySelector('aside')?.hidden).toBe(true);
    await key(document.body, '\\', { metaKey: true });
    expect(host.querySelector('aside')?.hidden).toBe(false);
    await key(document.body, '1', { metaKey: true });
    expect(fake.api.library.open).toHaveBeenCalledWith('topic-a');
  });

  it('narrow windows start collapsed, but Cmd+\\ and Cmd+F still open the sidebar (11 §5.2, §12)', async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 950 });
    try {
      const host = await render(App);
      expect(host.querySelector('aside')?.hidden).toBe(true);
      await key(document.body, '\\', { metaKey: true });
      expect(host.querySelector('aside')?.hidden).toBe(false);
      await key(document.body, '\\', { metaKey: true });
      expect(host.querySelector('aside')?.hidden).toBe(true);
      await key(document.body, 'f', { metaKey: true });
      expect(host.querySelector('aside')?.hidden).toBe(false);
      // The narrow override never flips the persisted wide-window preference.
      expect(JSON.parse(window.localStorage.getItem('eli5.sidebar') ?? '{}')).toMatchObject({ collapsed: false });
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });

  it('public build: no sign-in, publish or enterprise settings elements (HOOK-UI-01)', async () => {
    const host = await render(App);
    await click(button(host, 'Settings'));
    expect(host.textContent).toContain('Public edition');
    expect(host.textContent).not.toMatch(/Sign in|Signed in|Enterprise/);
    expect(host.querySelector('#settings-enterprise')).toBeNull();
    expect(host.querySelector('.sign-in')).toBeNull();
    // Unavailable providers are not shown: bedrock never appears.
    const radios = Array.from(host.querySelectorAll('#settings-ai input[type="radio"]')).map(
      (r) => r.parentElement?.textContent,
    );
    expect(radios).toEqual(['Claude', 'OpenAI']);
    // Dormant keys have no controls. Settings > Notifications names the remote link kinds in its
    // disabled published-link option (11 §7), so it is checked separately.
    const notifications = host.querySelector('#settings-notifications');
    expect(notifications?.querySelector<HTMLInputElement>('input[type="radio"]:disabled')).not.toBeNull();
    notifications?.remove();
    expect(host.innerHTML).not.toMatch(/mcp|drive|github/i);
  });

  it('enterprise UI mounts only when its UiFeature is enabled', async () => {
    const enterprise: EditionInfo = { ...PUBLIC_EDITION, edition: 'enterprise', uiFeatures: ['auth.signIn'] };
    fake = installFakeApi(enterprise);
    const host = await render(App);
    expect(host.querySelector('.sign-in')?.textContent).toBe('Sign in');
    await click(button(host, 'Settings'));
    expect(host.querySelector('#settings-enterprise')).not.toBeNull();
  });
});

describe('SettingsScreen (11 §7)', () => {
  const mount = (over: Record<string, unknown> = {}) =>
    render(
      function Screen(p: Record<string, unknown>) {
        return createElement(EditionProvider, null, createElement(SettingsScreen, p));
      },
      { settings: settings(), onKeyChanged: vi.fn(), ...over },
    );

  it('saves the API key to the Keychain API and clears the field', async () => {
    const onKeyChanged = vi.fn();
    const host = await mount({ onKeyChanged });
    expect(host.textContent).toContain('No key');
    const field = host.querySelector<HTMLInputElement>('input[aria-label="API key"]');
    const secret = ['sk', 'ant', 'test', 'x'.repeat(24)].join('-');
    await type(field, secret);
    await click(button(host, 'Save key'));
    expect(fake.api.settings.setApiKey).toHaveBeenCalledWith('claude', secret);
    expect(field?.value).toBe('');
    expect(host.textContent).toContain('Key saved in Keychain');
    expect(host.innerHTML).not.toContain(secret);
    expect(onKeyChanged).toHaveBeenCalledOnce();

    await click(button(host, 'Test connection'));
    expect(host.textContent).toContain('Connected (model-x)');
    await click(button(host, 'Remove'));
    expect(fake.api.settings.clearApiKey).toHaveBeenCalledWith('claude');
    expect(host.textContent).toContain('No key');
  });

  it('saves non-secret settings on change, debounced, with a quiet Saved', async () => {
    const host = await mount();
    const openai = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="radio"]'))[1];
    await click(openai);
    const glossary = host.querySelector<HTMLInputElement>('#settings-documents input[role="switch"]');
    await click(glossary);
    expect(fake.api.settings.set).not.toHaveBeenCalled();
    await act(async () => new Promise((r) => setTimeout(r, 350)));
    await flush();
    expect(fake.api.settings.set).toHaveBeenCalledWith({ llm: { provider: 'openai', model: null } });
    expect(fake.api.settings.set).toHaveBeenCalledWith({ glossary: { defaultOn: false } });
    expect(host.textContent).toContain('Saved');
  });

  it('shows Library info when main provides it', async () => {
    fake.api.library.info = async () => ok({ root: '/Users/x/Library/ELI5', readOnly: false, count: 3 });
    const host = await mount();
    expect(host.textContent).toContain('/Users/x/Library/ELI5');
    expect(host.textContent).toContain('3 documents');
  });

  it('does not let a save echo overwrite newer typing in the model field', async () => {
    const host = await render(App);
    await click(button(host, 'Settings'));
    const field = host.querySelector<HTMLInputElement>('input[aria-label="Model"]');
    await act(async () => field?.focus());
    await type(field, 'gpt-4');
    await type(field, 'gpt-4o');
    // settings.changed for the earlier save arrives while the user is still editing.
    const s = settings();
    s.llm.model = 'gpt-4';
    fake.emit('settings', { changed: ['llm.model'], settings: s });
    await flush();
    expect(field?.value).toBe('gpt-4o');
    // Once the user leaves the field, external values apply again.
    await act(async () => field?.blur());
    s.llm.model = 'model-y';
    fake.emit('settings', { changed: ['llm.model'], settings: structuredClone(s) });
    await flush();
    expect(field?.value).toBe('model-y');
  });

  it('has no API key controls for key-less providers', async () => {
    const s = settings();
    s.llm.provider = 'bedrock';
    const host = await mount({ settings: s });
    expect(host.querySelector('input[aria-label="API key"]')).toBeNull();
  });
});

describe('DocHeader (11 §5.3)', () => {
  it('drops an export result that resolves after switching documents', async () => {
    const local: PublishTarget = {
      id: 'local',
      kind: 'local',
      label: 'Export',
      available: true,
      requiresSignIn: false,
    };
    fake.api.publish.targets = vi.fn(async () => ok([local])) as typeof fake.api.publish.targets;
    let finish: (r: ReturnType<typeof ok<PublishResult>>) => void = () => {};
    fake.api.publish.run = vi.fn(
      () => new Promise<ReturnType<typeof ok<PublishResult>>>((r) => (finish = r)),
    ) as unknown as typeof fake.api.publish.run;
    let setSlug: (s: string) => void = () => {};
    const { useState } = await import('react');
    const host = await render(function Harness() {
      const [slug, set] = useState('doc-a');
      setSlug = set;
      return createElement(DocHeader, { slug, entry: undefined });
    });
    await click(button(host, 'Export copy'));
    await act(async () => setSlug('doc-b'));
    await flush();
    await act(async () =>
      finish(
        ok({
          targetId: 'local',
          kind: 'local',
          slug: 'doc-a',
          publishedAt: '2026-01-01T00:00:00Z',
          files: [],
          links: [{ kind: 'file', url: '/tmp/doc-a', label: 'doc-a copy', primary: true }],
          warnings: [],
        }),
      ),
    );
    await flush();
    expect(host.querySelector('h1')?.textContent).toBe('doc-b');
    expect(host.querySelector('.result-chip')).toBeNull();
  });
});
