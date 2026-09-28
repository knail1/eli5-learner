import { z } from 'zod';
import { IPC, type Settings, type SettingsDescription } from '../../preload/contract';
import { account, checkApiKeyFormat, type DeepPartial, type KeyStore, type SettingsStore } from '../config';
import type { Registry } from '../editions';
import { log } from '../security';
import { NoPayload, WithWarnings, fail, type Register } from './handle';

export interface SettingsIpcDeps {
  settings: SettingsStore;
  keyStore: KeyStore;
  /** Only `invalidateLLM` is used: a new key or provider takes effect on the next LLM call. */
  registry: Pick<Registry, 'invalidateLLM'>;
}

const KeyProvider = z.enum(['claude', 'openai']);

/** `eli5:settings:*` invokes (12 §5). The `changed` event is wired by registerIpc. */
export function registerSettingsIpc(on: Register, d: SettingsIpcDeps): void {
  on(IPC.settings.get, NoPayload, (): Settings => d.settings.get());
  on(IPC.settings.set, z.record(z.string(), z.unknown()), async (patch): Promise<Settings> => {
    const next = await d.settings.set(patch as DeepPartial<Settings>);
    d.registry.invalidateLLM();
    return next;
  });
  on(IPC.settings.setApiKey, z.object({ provider: KeyProvider, key: z.string().max(4096) }), async (p) => {
    const checked = checkApiKeyFormat(p.provider, p.key);
    if (!checked.ok) fail('E_KEY_FORMAT', "That doesn't look like an API key");
    await d.keyStore.set(account(p.provider), checked.key);
    d.registry.invalidateLLM();
    log.info('settings.api-key-saved', { provider: p.provider });
    return checked.warning ? new WithWarnings(undefined, [checked.warning]) : undefined;
  });
  on(IPC.settings.hasApiKey, z.object({ provider: KeyProvider }), (p) => d.keyStore.has(account(p.provider)));
  on(IPC.settings.clearApiKey, z.object({ provider: KeyProvider }), async (p) => {
    await d.keyStore.delete(account(p.provider));
    d.registry.invalidateLLM();
  });
  on(IPC.settings.describe, NoPayload, async (): Promise<SettingsDescription> =>
    d.settings.describe(await d.keyStore.available()),
  );
}
