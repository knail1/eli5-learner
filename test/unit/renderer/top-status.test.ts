import { act, createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountStatus, CredentialStatus, IpcResult } from '../../../src/preload/contract';
import {
  PUBLIC_EDITION,
  button,
  click,
  flush,
  installFakeApi,
  loadRenderer,
  ok,
  render,
  type FakeApi,
} from './harness';

/** Top-status holder: credential bar (02 §14) and publisher account bar (10 §5.4). */

const { CredentialBar, AccountBar } = await loadRenderer<{
  CredentialBar: () => unknown;
  AccountBar: () => unknown;
}>('top-status/TopStatus.tsx');
const { EditionProvider } = await loadRenderer<{ EditionProvider: (p: { children: unknown }) => unknown }>(
  'edition/FeatureGate.tsx',
);

let f: FakeApi;
beforeEach(() => {
  f = installFakeApi();
});

const fail = (message: string): IpcResult<never> => ({ ok: false, error: { code: 'E_LLM_UNAVAILABLE', message } });

/** A promise the test resolves by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('CredentialBar (02 §14)', () => {
  it('(a) a public provider reports nothing, so the bar is absent', async () => {
    const host = await render(CredentialBar as never);
    expect(host.innerHTML).toBe('');
  });

  it('(b) shows the provider label; Sign in is called once per click and failures show inline', async () => {
    const expired: CredentialStatus = { state: 'expired', label: 'Cloud expired' };
    vi.mocked(f.api.llm.credentialStatus).mockResolvedValue(ok(expired));
    vi.mocked(f.api.llm.signIn).mockResolvedValue(fail('Browser sign-in was cancelled'));
    const host = await render(CredentialBar as never);
    expect(host.textContent).toContain('Cloud expired');
    await click(button(host, 'Sign in'));
    expect(f.api.llm.signIn).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Browser sign-in was cancelled');
  });

  it('shows the state word when the provider sends no label, and never builds its own text', async () => {
    vi.mocked(f.api.llm.credentialStatus).mockResolvedValue(
      ok({ state: 'expiring', expiresAt: '2026-01-01T00:00:00Z' }),
    );
    const host = await render(CredentialBar as never);
    expect(host.querySelector('.status-label')?.textContent).toBe('Expiring soon');
  });

  it('(c) Reload still works while a sign-in is pending; each button disables only itself', async () => {
    vi.mocked(f.api.llm.credentialStatus).mockResolvedValue(ok({ state: 'expired', label: 'Cloud expired' }));
    const pending = deferred<IpcResult<CredentialStatus | null>>();
    vi.mocked(f.api.llm.signIn).mockReturnValue(pending.promise);
    vi.mocked(f.api.llm.reloadCredentials).mockResolvedValue(ok({ state: 'ok', label: 'Cloud 10h 44m' }));
    const host = await render(CredentialBar as never);
    await click(button(host, 'Sign in'));
    expect(button(host, 'Signing in…')?.disabled).toBe(true);
    expect(button(host, 'Reload')?.disabled).toBe(false);
    await click(button(host, 'Reload'));
    expect(host.textContent).toContain('Cloud 10h 44m');
    await act(async () => pending.resolve(ok({ state: 'ok', label: 'Cloud 10h 44m' })));
    await flush();
    expect(button(host, 'Sign in')?.disabled).toBe(false);
  });

  it('(d) re-reads every 60 seconds and a failed poll leaves the last status shown', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      vi.mocked(f.api.llm.credentialStatus).mockResolvedValueOnce(ok({ state: 'ok', label: 'Cloud 10h 44m' }));
      const host = await render(CredentialBar as never);
      vi.mocked(f.api.llm.credentialStatus).mockResolvedValueOnce(fail('offline'));
      await act(async () => vi.advanceTimersByTime(60_000));
      await flush();
      expect(f.api.llm.credentialStatus).toHaveBeenCalledTimes(2);
      expect(host.textContent).toContain('Cloud 10h 44m');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AccountBar (10 §5.4)', () => {
  const withAccount = {
    ...PUBLIC_EDITION,
    publishers: [...PUBLIC_EDITION.publishers, { id: 'notes', available: true, account: true as const }],
  };
  const mount = async () =>
    render(() => createElement(EditionProvider as never, null, createElement(AccountBar as never)));

  it('renders nothing when no publisher declares an account', async () => {
    const host = await mount();
    expect(host.innerHTML).toBe('');
    expect(f.api.publish.accountStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['signed-in', null],
    ['signed-out', 'Sign in'],
    ['error', 'Sign in'],
    ['not-installed', 'Install'],
  ] as const)('%s offers %s', async (state, action) => {
    f = installFakeApi(withAccount);
    vi.mocked(f.api.publish.accountStatus).mockResolvedValue(ok({ state, label: 'Service: someone@example.com' }));
    const host = await mount();
    expect(f.api.publish.accountStatus).toHaveBeenCalledWith('notes');
    expect(host.textContent).toContain('Service: someone@example.com');
    expect(host.querySelectorAll('button')).toHaveLength(action ? 1 : 0);
    if (action) expect(button(host, action)).toBeDefined();
  });

  it('a double-click runs the action once and the fresh status replaces the old one', async () => {
    f = installFakeApi(withAccount);
    vi.mocked(f.api.publish.accountStatus).mockResolvedValue(ok({ state: 'signed-out', label: 'Service' }));
    const pending = deferred<IpcResult<AccountStatus>>();
    vi.mocked(f.api.publish.accountAction).mockReturnValue(pending.promise);
    const host = await mount();
    const b = button(host, 'Sign in');
    await click(b);
    await click(b);
    expect(f.api.publish.accountAction).toHaveBeenCalledTimes(1);
    expect(f.api.publish.accountAction).toHaveBeenCalledWith('notes', 'sign-in');
    vi.mocked(f.api.publish.accountStatus).mockResolvedValue(
      ok({ state: 'signed-in', label: 'Service: someone@example.com' }),
    );
    await act(async () => pending.resolve(ok({ state: 'signed-in', label: 'Service: someone@example.com' })));
    await flush();
    expect(host.textContent).toContain('Service: someone@example.com');
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });
});
