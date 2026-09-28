import type { Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULTS } from '../../../../src/main/config/schema';
import { Registry } from '../../../../src/main/editions/registry';
import { configureSession, registerPublic } from '../../../../src/main/fetch';

describe('fetch registerPublic', () => {
  it('registers the default network configurator and no login signatures', () => {
    const reg = new Registry({ edition: 'public', getSettings: () => DEFAULTS });
    registerPublic(reg);
    expect(reg.networkConfigurator()).toBe(configureSession);
    expect(reg.loginSignatures()).toEqual([]);
    expect(reg.missingSlots()).not.toContain('networkConfigurator');
  });

  it('public configurator only sets the system proxy (HOOK-FETCH-01)', async () => {
    const setProxy = vi.fn(async () => {});
    const setCertificateVerifyProc = vi.fn();
    const ses = { setProxy, setCertificateVerifyProc } as unknown as Session;
    await configureSession(ses);
    expect(setProxy).toHaveBeenCalledWith({ mode: 'system' });
    expect(setCertificateVerifyProc).not.toHaveBeenCalled();
  });
});
