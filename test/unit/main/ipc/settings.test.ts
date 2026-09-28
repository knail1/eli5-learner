import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: {}, session: {} }));

const { IPC } = await import('../../../../src/preload/contract');
const { MemoryKeyStore, account } = await import('../../../../src/main/config');
const { setup } = await import('./harness');

// Secret-shaped strings are assembled at runtime (13: no literal keys in the repo).
const claudeKey = ['sk', 'ant', 'api03', 'z'.repeat(40)].join('-');
const oddKey = ['pk', 'y'.repeat(40)].join('-');
const forbidden = { ok: false, error: { code: 'E_FORBIDDEN', message: 'Forbidden' } };

describe('eli5:settings:* (12 §5)', () => {
  it('get returns the current settings; set merges a patch, returns it and invalidates the LLM', async () => {
    const h = await setup();
    const invalidate = vi.spyOn(h.registry, 'invalidateLLM');
    const before = await h.call<{ llm: { provider: string }; pipeline: { maxConcurrentJobs: number } }>(
      IPC.settings.get,
    );
    expect(before).toMatchObject({ ok: true, value: { llm: { provider: 'claude' } } });
    const r = await h.call<{ llm: { provider: string }; pipeline: { maxConcurrentJobs: number } }>(IPC.settings.set, {
      pipeline: { maxConcurrentJobs: 2 },
    });
    expect(r).toMatchObject({ ok: true, value: { pipeline: { maxConcurrentJobs: 2 }, llm: { provider: 'claude' } } });
    expect(h.settings.get().pipeline.maxConcurrentJobs).toBe(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(await h.call(IPC.settings.set, 'nope')).toMatchObject({ ok: false, error: { code: 'E_BAD_REQUEST' } });
  });

  it('pushes eli5:settings:changed to the app with the changed paths', async () => {
    const h = await setup();
    await h.call(IPC.settings.set, { pipeline: { maxConcurrentJobs: 2 } });
    const pushed = h.sent.filter((s) => s.channel === IPC.settings.changed);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.payload).toMatchObject({
      changed: expect.arrayContaining(['pipeline.maxConcurrentJobs']),
      settings: { pipeline: { maxConcurrentJobs: 2 } },
    });
  });

  it('set-api-key refuses a malformed key with E_KEY_FORMAT and stores nothing', async () => {
    const h = await setup();
    const invalidate = vi.spyOn(h.registry, 'invalidateLLM');
    for (const key of ['', '   ', 'has spaces inside', 'x'.repeat(600)]) {
      expect(await h.call(IPC.settings.setApiKey, { provider: 'claude', key })).toEqual({
        ok: false,
        error: { code: 'E_KEY_FORMAT', message: "That doesn't look like an API key" },
      });
    }
    expect(await h.keyStore.has(account('claude'))).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
    expect(await h.call(IPC.settings.setApiKey, { provider: 'bedrock', key: claudeKey })).toMatchObject({
      ok: false,
      error: { code: 'E_BAD_REQUEST' },
    });
  });

  it('set-api-key stores a trimmed key under account(provider), invalidates the LLM and returns warnings', async () => {
    const h = await setup();
    const invalidate = vi.spyOn(h.registry, 'invalidateLLM');
    const ok = await h.call(IPC.settings.setApiKey, { provider: 'claude', key: `  ${claudeKey}\n` });
    expect(ok).toEqual({ ok: true, value: undefined });
    expect(await h.keyStore.get(account('claude'))).toBe(claudeKey);
    expect(invalidate).toHaveBeenCalledTimes(1);
    // A key without the usual prefix is saved with a warning (12 §5).
    const warned = await h.call(IPC.settings.setApiKey, { provider: 'openai', key: oddKey });
    expect(warned).toEqual({ ok: true, value: undefined, warnings: ['Key does not start with "sk-"; saved anyway.'] });
    expect(await h.keyStore.get(account('openai'))).toBe(oddKey);
    expect(invalidate).toHaveBeenCalledTimes(2);
    // The key never comes back over IPC, and is never pushed to the renderer.
    expect(JSON.stringify(h.sent)).not.toContain(claudeKey);
  });

  it('has-api-key and clear-api-key round-trip; clear invalidates the LLM', async () => {
    const h = await setup();
    const invalidate = vi.spyOn(h.registry, 'invalidateLLM');
    expect(await h.call(IPC.settings.hasApiKey, { provider: 'claude' })).toEqual({ ok: true, value: false });
    await h.call(IPC.settings.setApiKey, { provider: 'claude', key: claudeKey });
    expect(await h.call(IPC.settings.hasApiKey, { provider: 'claude' })).toEqual({ ok: true, value: true });
    expect(await h.call(IPC.settings.hasApiKey, { provider: 'openai' })).toEqual({ ok: true, value: false });
    expect(await h.call(IPC.settings.clearApiKey, { provider: 'claude' })).toEqual({ ok: true, value: undefined });
    expect(await h.call(IPC.settings.hasApiKey, { provider: 'claude' })).toEqual({ ok: true, value: false });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('describe passes keyStore.available() through', async () => {
    for (const available of [true, false]) {
      const keyStore = new MemoryKeyStore();
      keyStore.available = async () => available;
      const h = await setup({ keyStore });
      const r = await h.call<{ keychain: { available: boolean }; keys: unknown[] }>(IPC.settings.describe);
      expect(r.ok && r.value.keychain).toEqual({ available });
      expect(r.ok && r.value.keys.length).toBeGreaterThan(0);
    }
  });

  it('refuses every settings channel from the document viewer', async () => {
    const h = await setup();
    const calls: [string, unknown][] = [
      [IPC.settings.get, undefined],
      [IPC.settings.set, { pipeline: { maxConcurrentJobs: 2 } }],
      [IPC.settings.setApiKey, { provider: 'claude', key: claudeKey }],
      [IPC.settings.hasApiKey, { provider: 'claude' }],
      [IPC.settings.clearApiKey, { provider: 'claude' }],
      [IPC.settings.describe, undefined],
      [IPC.settings.chooseFolder, { key: 'publish.local.dir' }],
    ];
    for (const [channel, payload] of calls) {
      expect(await h.call(channel, payload, 'viewer'), channel).toEqual(forbidden);
    }
    expect(await h.keyStore.has(account('claude'))).toBe(false);
    expect(h.settings.get().pipeline.maxConcurrentJobs).toBe(1);
  });
});

describe('eli5:settings:choose-folder (11 §7, §10)', () => {
  it('delegates the panel to the FolderChooser for publish.local.dir only', async () => {
    const chooseFolder = vi.fn(async () => ({ path: '/Users/me/Exports' }));
    const h = await setup({ services: { folders: { chooseFolder } } });
    expect(await h.call(IPC.settings.chooseFolder, { key: 'publish.local.dir' })).toEqual({
      ok: true,
      value: { path: '/Users/me/Exports' },
    });
    chooseFolder.mockResolvedValueOnce({ cancelled: true } as never);
    expect(await h.call(IPC.settings.chooseFolder, { key: 'publish.local.dir' })).toEqual({
      ok: true,
      value: { cancelled: true },
    });
    for (const bad of [undefined, {}, { key: 'llm.model' }, { key: 'publish.local.dir', path: '/etc' }]) {
      const r = await h.call(IPC.settings.chooseFolder, bad);
      if (r.ok) expect(chooseFolder).toHaveBeenLastCalledWith('publish.local.dir');
      else expect(r).toMatchObject({ ok: false, error: { code: 'E_BAD_REQUEST' } });
    }
    // Unknown keys are stripped; the renderer can never pass a path.
    expect(chooseFolder.mock.calls.every((c: unknown[]) => c.length === 1 && c[0] === 'publish.local.dir')).toBe(true);
  });

  it('answers "Not implemented yet" until a FolderChooser is plugged in', async () => {
    const h = await setup();
    expect(await h.call(IPC.settings.chooseFolder, { key: 'publish.local.dir' })).toEqual({
      ok: false,
      error: { code: 'E_INTERNAL', message: 'Not implemented yet' },
    });
  });
});
