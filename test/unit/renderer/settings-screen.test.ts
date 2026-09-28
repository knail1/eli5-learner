import { act, createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResult, Settings, SettingsDescription } from '../../../src/preload/contract';
import {
  button,
  click,
  flush,
  installFakeApi,
  loadRenderer,
  ok,
  render,
  settings,
  type,
  type Component,
  type FakeApi,
} from './harness';

/**
 * Settings screen behavior (11 §7, 12 §4.2, §5, §13): load issues as one non-modal line, locked
 * keys read-only, E_SETTINGS_* errors inline, the export folder chooser, Library reveal, and the
 * HOOK-UI-02 help links. All IPC is the fake window.eli5 from the harness.
 */

const { SettingsScreen } = await loadRenderer<{ SettingsScreen: Component }>('settings/SettingsScreen.tsx');
const { EditionProvider } = await loadRenderer<{ EditionProvider: Component }>('edition/FeatureGate.tsx');

let fake: FakeApi;
beforeEach(() => {
  fake = installFakeApi();
});

const mount = (s: Settings = settings()) =>
  render(
    function Screen(p: Record<string, unknown>) {
      return createElement(EditionProvider, null, createElement(SettingsScreen, p));
    },
    { settings: s, onKeyChanged: vi.fn() },
  );

const LEAVES = [
  'llm.provider',
  'llm.model',
  'glossary.defaultOn',
  'publish.local.dir',
  'publish.local.revealAfter',
  'notifications.enabled',
];

function description(o: { locked?: string[]; issues?: SettingsDescription['loadIssues']; keychain?: boolean } = {}) {
  const d: SettingsDescription = {
    keys: LEAVES.map((path) => ({
      path,
      dormant: false,
      locked: o.locked?.includes(path) ?? false,
      source: o.locked?.includes(path) ? 'managed' : 'default',
    })),
    loadIssues: o.issues ?? [],
    keychain: { available: o.keychain ?? true },
  };
  fake.api.settings.describe = vi.fn(async () => ok(d));
}

const fail = (code: string, message: string) => ({ ok: false, error: { code, message } }) as IpcResult<never>;
const section = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`#settings-${id}`)!;
const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));

describe('load issues (12 §4.2)', () => {
  it('shows one non-modal line when settings were reset to defaults', async () => {
    description({
      issues: [
        { path: 'llm.model', reason: 'invalid' },
        { path: 'pipeline.maxConcurrentJobs', reason: 'invalid' },
      ],
    });
    const host = await mount();
    const lines = host.querySelectorAll('[data-testid="load-issues"]');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toBe('2 settings were reset to defaults');
    expect(lines[0]?.getAttribute('role')).toBe('status');
    expect(host.querySelector('dialog, [role="dialog"], [role="alertdialog"]')).toBeNull();
  });

  it('uses the singular for one issue and names an unreadable file', async () => {
    description({ issues: [{ path: 'glossary.defaultOn', reason: 'secret-removed' }] });
    let host = await mount();
    expect(host.querySelector('[data-testid="load-issues"]')?.textContent).toBe('1 setting was reset to its default');
    description({ issues: [{ path: '', reason: 'corrupt-file' }] });
    host = await mount();
    expect(host.querySelector('[data-testid="load-issues"]')?.textContent).toBe(
      "The settings file couldn't be read, so defaults are in use",
    );
  });

  it('shows nothing when there are no issues or describe is unavailable', async () => {
    description();
    let host = await mount();
    expect(host.querySelector('[data-testid="load-issues"]')).toBeNull();
    fake = installFakeApi(); // describe answers "Not implemented yet"
    host = await mount();
    expect(host.querySelector('[data-testid="load-issues"]')).toBeNull();
    expect(host.querySelector('#settings-ai')).not.toBeNull();
  });
});

describe('locked keys are read-only (HOOK-CFG-01)', () => {
  it('disables every managed control and says why; unlocked controls stay editable', async () => {
    description({ locked: ['llm.provider', 'llm.model', 'glossary.defaultOn', 'publish.local.dir'] });
    const host = await mount();
    const radios = Array.from(host.querySelectorAll<HTMLInputElement>('#settings-ai input[type="radio"]'));
    expect(radios.length).toBeGreaterThan(0);
    expect(radios.every((r) => r.disabled)).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Model"]')?.readOnly).toBe(true);
    expect(section(host, 'documents').querySelector<HTMLInputElement>('input[role="switch"]')?.disabled).toBe(true);
    expect(button(section(host, 'publishing'), 'Choose…')?.disabled).toBe(true);
    // revealAfter is not locked.
    expect(section(host, 'publishing').querySelector<HTMLInputElement>('input[role="switch"]')?.disabled).toBe(false);
    expect(host.textContent).toContain('This setting is managed by your organization');

    await click(radios[1]);
    await click(section(host, 'documents').querySelector('input[role="switch"]'));
    await wait(350);
    expect(fake.api.settings.set).not.toHaveBeenCalled();
  });

  it('no managed notes in the public build (nothing locked)', async () => {
    description();
    const host = await mount();
    expect(host.textContent).not.toContain('managed by your organization');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Model"]')?.readOnly).toBe(false);
  });
});

describe('E_SETTINGS_* errors render inline (12 §13)', () => {
  it('shows the returned message next to the control that saved', async () => {
    fake.api.settings.set = vi.fn(async () =>
      fail('E_SETTINGS_LOCKED', 'This setting is managed by your organization'),
    );
    const host = await mount();
    await click(section(host, 'documents').querySelector('input[role="switch"]'));
    await wait(350);
    await flush();
    const err = section(host, 'documents').querySelector('.inline-error');
    expect(err?.textContent).toBe('This setting is managed by your organization');
    expect(host.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
  });

  it('shows an invalid model inline under the model field', async () => {
    fake.api.settings.set = vi.fn(async () => fail('E_SETTINGS_INVALID', "That value isn't valid: llm.model"));
    const host = await mount();
    await type(host.querySelector('input[aria-label="Model"]'), 'x');
    await wait(350);
    await flush();
    expect(section(host, 'ai').textContent).toContain("That value isn't valid: llm.model");
  });
});

describe('AI section (11 §7)', () => {
  it('warns inline when the Keychain is unavailable', async () => {
    description({ keychain: false });
    const host = await mount();
    expect(section(host, 'ai').textContent).toContain('Keychain access denied. Unlock or allow access, then retry');
  });

  it('offers model suggestions from llm.models for the selected provider', async () => {
    const host = await mount();
    expect(fake.api.llm.models).toHaveBeenCalledWith('claude');
    const list = host.querySelector('input[aria-label="Model"]')?.getAttribute('list');
    expect(Array.from(host.querySelectorAll(`#${list} option`)).map((o) => o.getAttribute('value'))).toEqual([
      'model-x',
    ]);
  });

  it('shows the key-format error inline and never echoes the key', async () => {
    fake.api.settings.setApiKey = vi.fn(async () => fail('E_KEY_FORMAT', "That doesn't look like an API key"));
    const host = await mount();
    const field = host.querySelector<HTMLInputElement>('input[aria-label="API key"]');
    const bad = ['not', 'a', 'key', 'y'.repeat(12)].join('-');
    await type(field, bad);
    await click(button(host, 'Save key'));
    expect(section(host, 'ai').textContent).toContain("That doesn't look like an API key");
    expect(field?.value).toBe('');
    expect(host.innerHTML).not.toContain(bad);
  });

  it('Test connection shows a busy state, then the returned failure message', async () => {
    let finish: (v: IpcResult<{ ok: boolean; message?: string }>) => void = () => {};
    fake.api.llm.testConnection = vi.fn(
      () =>
        new Promise<IpcResult<{ ok: boolean; message?: string }>>((r) => {
          finish = r;
        }),
    ) as never;
    const host = await mount();
    await click(button(host, 'Test connection'));
    expect(button(host, 'Testing…')?.disabled).toBe(true);
    await act(async () => finish(ok({ ok: false, message: 'The API key was rejected' })));
    await flush();
    expect(section(host, 'ai').textContent).toContain('The API key was rejected');
  });
});

describe('Library section (11 §7)', () => {
  it('shows location, count, the read-only reason, and reveals the root in Finder', async () => {
    fake.api.library.info = vi.fn(async () =>
      ok({ root: '/tmp/lib', readOnly: true, readOnlyReason: 'The Library folder is not writable', count: 1 }),
    );
    const host = await mount();
    const lib = section(host, 'library');
    expect(lib.textContent).toContain('/tmp/lib');
    expect(lib.textContent).toContain('1 document');
    expect(lib.textContent).toContain('Read only: The Library folder is not writable');
    await click(button(lib, 'Reveal in Finder'));
    expect(fake.api.library.revealRoot).toHaveBeenCalledOnce();
  });

  it('shows a failed reveal inline', async () => {
    fake.api.library.info = vi.fn(async () => ok({ root: '/tmp/lib', readOnly: false, count: 0 }));
    fake.api.library.revealRoot = vi.fn(async () => fail('E_NOT_FOUND', 'The Library folder is missing'));
    const host = await mount();
    await click(button(section(host, 'library'), 'Reveal in Finder'));
    expect(section(host, 'library').querySelector('.inline-error')?.textContent).toBe('The Library folder is missing');
  });
});

describe('Publishing section (11 §7, 10 §5.1)', () => {
  it('Choose… asks main for a folder and shows the saved path', async () => {
    fake.api.settings.chooseFolder = vi.fn(async () => ok({ path: '~/Exports' }));
    const host = await mount();
    const pub = section(host, 'publishing');
    expect(pub.textContent).toContain('~/Documents/ELI5 Learner');
    await click(button(pub, 'Choose…'));
    expect(fake.api.settings.chooseFolder).toHaveBeenCalledWith('publish.local.dir');
    expect(pub.textContent).toContain('~/Exports');
    expect(pub.textContent).toContain('Saved');
  });

  it('a cancelled panel changes nothing', async () => {
    fake.api.settings.chooseFolder = vi.fn(async () => ok({ cancelled: true as const }));
    const host = await mount();
    await click(button(section(host, 'publishing'), 'Choose…'));
    expect(section(host, 'publishing').textContent).toContain('~/Documents/ELI5 Learner');
    expect(section(host, 'publishing').textContent).not.toContain('Saved');
  });

  it('a rejected folder renders inline and keeps the old path', async () => {
    fake.api.settings.chooseFolder = vi.fn(async () =>
      fail('E_SETTINGS_INVALID', 'Choose a folder outside the Library'),
    );
    const host = await mount();
    await click(button(section(host, 'publishing'), 'Choose…'));
    const pub = section(host, 'publishing');
    expect(pub.querySelector('.inline-error')?.textContent).toBe('Choose a folder outside the Library');
    expect(pub.textContent).toContain('~/Documents/ELI5 Learner');
  });

  it('disables Choose… while the panel is open', async () => {
    let finish: (v: IpcResult<{ cancelled: true }>) => void = () => {};
    fake.api.settings.chooseFolder = vi.fn(
      () =>
        new Promise<IpcResult<{ cancelled: true }>>((r) => {
          finish = r;
        }),
    ) as never;
    const host = await mount();
    await click(button(section(host, 'publishing'), 'Choose…'));
    expect(button(section(host, 'publishing'), 'Choose…')?.disabled).toBe(true);
    await act(async () => finish(ok({ cancelled: true })));
    await flush();
    expect(button(section(host, 'publishing'), 'Choose…')?.disabled).toBe(false);
  });

  it('shows the export folder from the settings snapshot', async () => {
    const s = settings();
    s.publish.local.dir = '/Volumes/Share/Exports';
    const host = await mount(s);
    expect(section(host, 'publishing').textContent).toContain('/Volumes/Share/Exports');
  });

  it('the Pages help link opens the bundled help page through main; a missing page is inline', async () => {
    fake.api.settings.openHelp = vi.fn(async () => fail('E_NOT_FOUND', "That help page isn't available"));
    const host = await mount();
    await click(button(section(host, 'publishing'), 'How to set up a Pages repository'));
    expect(fake.api.settings.openHelp).toHaveBeenCalledWith('publish-pages');
    expect(section(host, 'publishing').querySelector('.inline-error')?.textContent).toBe(
      "That help page isn't available",
    );
  });

  it('has no cloud drive or git publishing controls in the public build', async () => {
    const host = await mount();
    expect(section(host, 'publishing').innerHTML).not.toMatch(/drive|github|git\b/i);
  });
});

describe('About section (11 §7, HOOK-UI-02)', () => {
  it('shows name, version and edition, and opens the README and license notices', async () => {
    fake.api.settings.openHelp = vi.fn(async () => ok(undefined));
    const host = await mount();
    const about = section(host, 'about');
    expect(about.textContent).toContain('ELI5 Learner 0.1.0');
    expect(about.textContent).toContain('Public edition');
    await click(button(about, 'README'));
    await click(button(about, 'Third-party licenses'));
    expect(vi.mocked(fake.api.settings.openHelp).mock.calls.map((c) => c[0])).toEqual(['readme', 'licenses']);
    expect(about.querySelector('.inline-error')).toBeNull();
  });

  it('shows an unavailable link inline', async () => {
    fake.api.settings.openHelp = vi.fn(async () => fail('E_NOT_FOUND', "That help page isn't available"));
    const host = await mount();
    await click(button(section(host, 'about'), 'Third-party licenses'));
    expect(section(host, 'about').querySelector('.inline-error')?.textContent).toBe("That help page isn't available");
  });
});
