import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider } from '../../../../src/main/llm';
import type { CredentialStatus } from '../../../../src/preload/contract';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: {}, session: {} }));

const { IPC } = await import('../../../../src/preload/contract');
const { LLMError } = await import('../../../../src/main/llm');
const { setup } = await import('./harness');

/** `eli5:llm:credential-status`, `reload-credentials`, `sign-in` (02 §14). */

type Extra = Pick<LLMProvider, 'credentialStatus' | 'signIn'>;

function provider(extra: Extra = {}): LLMProvider {
  return {
    id: 'claude',
    model: 'm',
    limits: {} as LLMProvider['limits'],
    generate: vi.fn(),
    generateWithImages: vi.fn(),
    testConnection: vi.fn(),
    ...extra,
  } as unknown as LLMProvider;
}

describe('credential status channels (02 §14)', () => {
  it('a provider without the seam answers null', async () => {
    const h = await setup();
    h.registry.registerLLMProvider('claude', () => provider());
    expect(await h.call(IPC.llm.credentialStatus)).toEqual({ ok: true, value: null });
    expect(await h.call(IPC.llm.reloadCredentials)).toEqual({ ok: true, value: null });
    const r = await h.call(IPC.llm.signIn);
    expect(r).toMatchObject({ ok: false, error: { code: 'E_NOT_FOUND' } });
    h.dispose();
  });

  it('returns the provider status as reported', async () => {
    const h = await setup();
    const status: CredentialStatus = { state: 'expiring', expiresAt: '2026-01-01T10:00:00Z', label: 'Cloud 10h 44m' };
    h.registry.registerLLMProvider('claude', () => provider({ credentialStatus: async () => status }));
    expect(await h.call(IPC.llm.credentialStatus)).toEqual({ ok: true, value: status });
    h.dispose();
  });

  it('reload rebuilds the provider before reporting again', async () => {
    const h = await setup();
    let builds = 0;
    h.registry.registerLLMProvider('claude', () => {
      const n = ++builds;
      return provider({ credentialStatus: async () => ({ state: 'ok', label: `build ${n}` }) });
    });
    expect(await h.call(IPC.llm.credentialStatus)).toMatchObject({ value: { label: 'build 1' } });
    expect(await h.call(IPC.llm.credentialStatus)).toMatchObject({ value: { label: 'build 1' } });
    expect(await h.call(IPC.llm.reloadCredentials)).toMatchObject({ value: { label: 'build 2' } });
    h.dispose();
  });

  it('sign in runs the provider sign-in once, then returns the new status', async () => {
    const h = await setup();
    let state: CredentialStatus['state'] = 'expired';
    const signIn = vi.fn(async () => {
      state = 'ok';
    });
    h.registry.registerLLMProvider('claude', () => provider({ signIn, credentialStatus: async () => ({ state }) }));
    expect(await h.call(IPC.llm.signIn)).toEqual({ ok: true, value: { state: 'ok' } });
    expect(signIn).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it('a failed sign-in surfaces the provider message, never a generic key prompt', async () => {
    const h = await setup();
    const signIn = vi.fn(async () => {
      throw new LLMError('auth', 'Browser sign-in was cancelled');
    });
    h.registry.registerLLMProvider('claude', () =>
      provider({ signIn, credentialStatus: async () => ({ state: 'expired' }) }),
    );
    expect(await h.call(IPC.llm.signIn)).toEqual({
      ok: false,
      error: { code: 'E_LLM_UNAVAILABLE', message: 'Browser sign-in was cancelled' },
    });
    h.dispose();
  });
});
