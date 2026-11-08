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
  versionNode,
  versionTree,
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

  it('opens the target when a suggestion merges away the document on screen (09 §10.6 step 12)', async () => {
    const source = entry('Widget ROAS', '2026-01-02T00:00:00Z');
    const target = entry('Widget ad spend', '2026-01-01T00:00:00Z');
    fake.api.library.list = async () => ok([source, target]);
    fake.api.library.open = vi.fn(async () => ok(undefined)) as typeof fake.api.library.open;
    fake.api.suggestions.list = async () =>
      ok([
        {
          id: 's1',
          createdAt: '2026-01-03T00:00:00Z',
          status: 'pending' as const,
          source: { id: source.id, slug: source.topicSlug, title: source.title },
          target: { id: target.id, slug: target.topicSlug, title: target.title },
          score: 0.9,
          reason: 'Same topic.',
          scorer: 'lexical+llm' as const,
        },
      ]);
    fake.api.suggestions.accept = vi.fn(async () =>
      ok({ targetSlug: target.topicSlug }),
    ) as typeof fake.api.suggestions.accept;
    const host = await render(App);
    await click(host.querySelector('.library-item'));
    expect(fake.api.library.open).toHaveBeenLastCalledWith(source.topicSlug);
    await click(button(host, 'Merge in'));
    await flush();
    expect(fake.api.suggestions.accept).toHaveBeenCalledWith('s1');
    expect(fake.api.library.open).toHaveBeenLastCalledWith(target.topicSlug);
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

  it('F6 from the sidebar hands focus to the viewer view (11 §9, §12 viewer focus handoff)', async () => {
    fake.api.library.list = async () => ok([entry('Topic A', '2026-01-01T00:00:00Z')]);
    const host = await render(App);
    await click(host.querySelector('.library-item'));
    host.querySelector<HTMLElement>('.library-item')?.focus();
    await key(document.activeElement, 'F6');
    expect(fake.api.viewer.focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(host.querySelector('main[data-region="viewer"]'));
    // Shift+F6 from the viewer's app region goes back to the sidebar without touching the view.
    await key(document.activeElement, 'F6', { shiftKey: true });
    expect(host.querySelector('aside')?.contains(document.activeElement)).toBe(true);
    expect(fake.api.viewer.focus).toHaveBeenCalledTimes(1);
  });

  it('F6 pressed inside the viewer cycles on from the viewer region (eli5:app:cycle-region)', async () => {
    fake.api.library.list = async () => ok([entry('Topic A', '2026-01-01T00:00:00Z')]);
    const host = await render(App);
    await click(host.querySelector('.library-item'));
    // The app renderer's own focus is stale (still in the sidebar) while the view has focus.
    host.querySelector<HTMLElement>('.library-item')?.focus();
    fake.emit('cycle-region', { dir: 1 });
    expect(host.querySelector('[data-region="input"]')?.contains(document.activeElement)).toBe(true);
    host.querySelector<HTMLElement>('.library-item')?.focus();
    fake.emit('cycle-region', { dir: -1 });
    expect(host.querySelector('aside')?.contains(document.activeElement)).toBe(true);
    expect(fake.api.viewer.focus).not.toHaveBeenCalled();
  });

  it('F6 without a document shown focuses the viewer region in the app and never the view', async () => {
    const host = await render(App);
    host.querySelector<HTMLElement>('.settings-button')?.focus();
    await key(document.activeElement, 'F6');
    expect(host.querySelector('main')?.contains(document.activeElement)).toBe(true);
    expect(fake.api.viewer.focus).not.toHaveBeenCalled();
  });

  it('keyboard: Cmd+L focuses the URL field, Cmd+N clears the draft and focuses the drop box', async () => {
    const host = await render(App);
    const url = host.querySelector<HTMLInputElement>('input[aria-label="URL"]');
    await key(document.body, 'l', { metaKey: true });
    expect(document.activeElement).toBe(url);
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    ev.clipboardData = { getData: () => 'https://example.com/a https://example.org/b' };
    await act(async () => {
      url?.dispatchEvent(ev);
    });
    await flush();
    expect(host.querySelectorAll('.chip')).toHaveLength(2);
    await key(document.body, 'n', { metaKey: true });
    expect(host.querySelectorAll('.chip')).toHaveLength(0);
    expect(document.activeElement).toBe(host.querySelector('.drop-box'));
  });

  it('keyboard: Cmd+[ and Cmd+] open the previous and next document, clamped at the ends', async () => {
    fake.api.library.list = async () =>
      ok([
        entry('Gamma', '2026-03-01T00:00:00Z'),
        entry('Beta', '2026-02-01T00:00:00Z'),
        entry('Alpha', '2026-01-01T00:00:00Z'),
      ]);
    const host = await render(App);
    await key(document.body, '1', { metaKey: true });
    expect(fake.api.library.open).toHaveBeenLastCalledWith('gamma');
    await key(document.body, ']', { metaKey: true });
    expect(fake.api.library.open).toHaveBeenLastCalledWith('beta');
    await key(document.body, ']', { metaKey: true });
    await key(document.body, ']', { metaKey: true });
    expect(fake.api.library.open).toHaveBeenLastCalledWith('alpha');
    await key(document.body, '[', { metaKey: true });
    expect(fake.api.library.open).toHaveBeenLastCalledWith('beta');
    await key(document.body, '[', { metaKey: true });
    await key(document.body, '[', { metaKey: true });
    expect(fake.api.library.open).toHaveBeenLastCalledWith('gamma');
    expect(host.querySelector('[aria-current="page"]')?.textContent).toContain('Gamma');
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
    expect(radios).toEqual(['Claude', 'ChatGPT (OpenAI)']);
    // Dormant keys have no controls. Settings > Notifications may name the remote link kinds only in
    // its preferred-link select and the explanation of the disabled published-link option (11 §7);
    // just those elements are removed before the scan, so the rest of the section is still checked.
    const notifications = host.querySelector('#settings-notifications');
    expect(notifications?.querySelector<HTMLInputElement>('input[type="radio"]:disabled')).not.toBeNull();
    const help = notifications?.querySelector('#notifications-link-help');
    const select = notifications?.querySelector('select[aria-label="Which published link"]');
    expect(help?.textContent).toBe('Available when documents can be published to a cloud drive or GitHub Pages');
    expect(Array.from(select?.querySelectorAll('option') ?? []).map((o) => o.value)).toEqual([
      'most-recent',
      'drive',
      'site',
    ]);
    help?.remove();
    select?.remove();
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

describe('Versions panel in the shell (11 §5.1, §5.3, §5.7)', () => {
  const frame = () => act(async () => new Promise((r) => requestAnimationFrame(() => r(undefined))));
  const toggle = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-controls="version-panel"]');
  const panel = (host: HTMLElement) => host.querySelector<HTMLElement>('aside#version-panel');
  const withWidth = async (w: number, run: () => Promise<void>) => {
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
    try {
      await run();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  };
  const openTopic = async () => {
    fake.api.library.list = async () => ok([entry('Topic A', '2026-01-01T00:00:00Z')]);
    const host = await render(App);
    await click(host.querySelector('.library-item'));
    return host;
  };

  it('the header toggle opens the panel beside the slot, which shrinks, and shows a count badge', async () => {
    fake.api.doc.versions = vi.fn(async (slug: string) =>
      ok(
        versionTree(slug, {
          nodes: [versionNode(), versionNode({ id: 'v1', parentId: 'v0', kind: 'expand', topic: 'Pricing' })],
          currentId: 'v1',
        }),
      ),
    ) as typeof fake.api.doc.versions;
    // A flex row in miniature: the slot gets the viewer area's width minus the panel's.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const aside = document.querySelector<HTMLElement>('#version-panel');
      const width = this.classList.contains('viewer-slot') ? 752 - (aside ? parseInt(aside.style.width, 10) : 0) : 0;
      return { x: 272, y: 80, left: 272, top: 80, width, height: 500, right: 272 + width, bottom: 580 } as DOMRect;
    });
    const host = await openTopic();
    const t = toggle(host);
    expect(t?.getAttribute('aria-expanded')).toBe('false');
    expect(t?.getAttribute('aria-keyshortcuts')).toBe('Meta+Y');
    expect(t?.querySelector('.count-badge')?.textContent).toBe('2');
    expect(panel(host)).toBeNull();
    await frame();
    expect(fake.api.viewer.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 752 }));

    await click(t);
    expect(t?.getAttribute('aria-expanded')).toBe('true');
    const aside = panel(host);
    expect(aside?.style.width).toBe('300px');
    // The panel is a column of .viewer-body after the slot and its handle, inside the viewer area.
    const body = host.querySelector('main .viewer-body');
    expect(Array.from(body?.children ?? []).map((c) => c.className)).toEqual([
      'viewer-slot',
      'panel-handle panel-handle-right',
      'version-panel',
    ]);
    expect(aside?.querySelector('[role="treeitem"][aria-current="true"]')?.textContent).toContain('Pricing');
    await frame();
    expect(fake.api.viewer.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 452 }));

    // The panel's Close button hides it again.
    await click(button(aside!, 'Close'));
    expect(panel(host)).toBeNull();
    await frame();
    expect(fake.api.viewer.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 752 }));
  });

  it('Cmd+Y toggles the panel with a document open and does nothing without one', async () => {
    fake.api.library.list = async () => ok([entry('Topic A', '2026-01-01T00:00:00Z')]);
    const host = await render(App);
    await key(document.body, 'y', { metaKey: true });
    expect(panel(host)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem('eli5.versionPanel') ?? '{}')).toMatchObject({ open: false });
    await click(host.querySelector('.library-item'));
    await key(document.body, 'y', { metaKey: true });
    expect(panel(host)).not.toBeNull();
    // The View > Show Versions item forwards an uppercase Y.
    await key(document.body, 'Y', { metaKey: true });
    expect(panel(host)).toBeNull();
  });

  it('persists open state and width; the handle resizes within 220..420', async () => {
    // withWidth restores the real width after the resize below.
    await withWidth(window.innerWidth, async () => {
      window.localStorage.setItem('eli5.versionPanel', JSON.stringify({ open: true, width: 999 }));
      const host = await openTopic();
      // 1024 - 272 - 360 = 392 px of room: the stored (clamped to 420) width shrinks to fit.
      expect(panel(host)?.style.width).toBe('392px');
      // The handle cannot widen past the room the slot leaves; the stored width matches the screen.
      const narrowHandle = host.querySelector<HTMLElement>('[aria-label="Resize versions panel"]');
      expect(narrowHandle?.getAttribute('aria-valuemax')).toBe('392');
      await key(narrowHandle, 'ArrowLeft');
      expect(panel(host)?.style.width).toBe('392px');
      expect(JSON.parse(window.localStorage.getItem('eli5.versionPanel') ?? '{}')).toEqual({ open: true, width: 392 });
      await act(async () => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 });
        window.dispatchEvent(new Event('resize'));
      });
      expect(panel(host)?.style.width).toBe('392px');
      await key(narrowHandle, 'ArrowLeft');
      await key(narrowHandle, 'ArrowLeft');
      expect(panel(host)?.style.width).toBe('420px');
      const handle = host.querySelector<HTMLElement>('[role="separator"][aria-label="Resize versions panel"]');
      expect(handle?.getAttribute('aria-orientation')).toBe('vertical');
      // The panel is on the right: Arrow Right narrows it.
      await key(handle, 'ArrowRight');
      expect(panel(host)?.style.width).toBe('404px');
      expect(JSON.parse(window.localStorage.getItem('eli5.versionPanel') ?? '{}')).toEqual({ open: true, width: 404 });
      await key(document.body, 'y', { metaKey: true });
      expect(JSON.parse(window.localStorage.getItem('eli5.versionPanel') ?? '{}')).toEqual({ open: false, width: 404 });
    });
  });

  it('dragging the handle left widens the panel', async () => {
    window.localStorage.setItem('eli5.versionPanel', JSON.stringify({ open: true, width: 240 }));
    const host = await openTopic();
    const handle = host.querySelector<HTMLElement>('[aria-label="Resize versions panel"]');
    const at = (type: string, clientX: number) =>
      act(async () => {
        handle?.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX }));
      });
    await at('pointerdown', 600);
    await at('pointermove', 560);
    expect(panel(host)?.style.width).toBe('280px');
    await at('pointerup', 560);
    await at('pointermove', 400);
    expect(panel(host)?.style.width).toBe('280px');
  });

  it('ignores a malformed stored value', async () => {
    window.localStorage.setItem('eli5.versionPanel', '{not json');
    const host = await openTopic();
    expect(panel(host)).toBeNull();
    await click(toggle(host));
    expect(panel(host)?.style.width).toBe('300px');
  });

  it('the panel width clamps so the slot keeps 360 px', async () => {
    await withWidth(900, async () => {
      // Narrow: the sidebar starts collapsed, leaving 900 - 360 = 540 px, so 420 fits as is.
      window.localStorage.setItem('eli5.versionPanel', JSON.stringify({ open: true, width: 420 }));
      const host = await render(App);
      fake.emit('navigate', { route: { view: 'doc', slug: 'topic-a' } });
      await flush();
      expect(panel(host)?.style.width).toBe('420px');
      // Opening the sidebar (272 px) leaves 268 px for the panel.
      await key(document.body, '\\', { metaKey: true });
      expect(host.querySelector('aside.sidebar')?.hasAttribute('hidden')).toBe(false);
      expect(panel(host)?.style.width).toBe('268px');
    });
  });

  it('a too-narrow window shows the hint instead of opening, and never collapses the sidebar', async () => {
    await withWidth(800, async () => {
      fake.api.library.list = async () => ok([entry('Topic A', '2026-01-01T00:00:00Z')]);
      const host = await render(App);
      await key(document.body, '\\', { metaKey: true });
      await click(host.querySelector('.library-item'));
      // 800 - 272 - 360 = 168 px: less than the 220 px minimum.
      await click(toggle(host));
      expect(panel(host)).toBeNull();
      expect(toggle(host)?.getAttribute('aria-expanded')).toBe('false');
      expect(host.querySelector('.doc-header [role="status"]')?.textContent).toBe(
        'Widen the window or hide the library to show versions.',
      );
      expect(host.querySelector('aside.sidebar')?.hasAttribute('hidden')).toBe(false);
      // Hiding the library makes room: the hint goes and the toggle works.
      await key(document.body, '\\', { metaKey: true });
      expect(host.querySelector('.doc-header [role="status"]')).toBeNull();
      await key(document.body, 'y', { metaKey: true });
      expect(panel(host)).not.toBeNull();
    });
  });

  it('F6 cycles viewer → versions → input when the panel is open', async () => {
    window.localStorage.setItem('eli5.versionPanel', JSON.stringify({ open: true, width: 300 }));
    const host = await openTopic();
    fake.emit('cycle-region', { dir: 1 });
    expect(document.activeElement?.getAttribute('role')).toBe('treeitem');
    expect(panel(host)?.contains(document.activeElement)).toBe(true);
    await key(document.activeElement, 'F6');
    expect(host.querySelector('[data-region="input"]')?.contains(document.activeElement)).toBe(true);
    await key(document.activeElement, 'F6', { shiftKey: true });
    expect(panel(host)?.contains(document.activeElement)).toBe(true);
    await key(document.activeElement, 'F6', { shiftKey: true });
    expect(document.activeElement).toBe(host.querySelector('main[data-region="viewer"]'));
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

  it('does not let a save echo overwrite newer typing in the custom model field', async () => {
    const host = await render(App);
    await click(button(host, 'Settings'));
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!;
    await act(async () => {
      select.value = '__custom__';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    const field = host.querySelector<HTMLInputElement>('input[aria-label="Custom model ID"]');
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
      label: 'Export copy',
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
