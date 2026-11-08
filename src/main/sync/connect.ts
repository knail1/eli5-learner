/**
 * The one way the rest of the app gets a sync store (16 §1 principle 1, §8). With `sync.enabled`
 * false, or a policy that does not allow sync (HOOK-SYNC-01), it returns null and nothing is built,
 * so no request to any Google endpoint can happen.
 */
import type { Settings } from '../config';
import type { CapabilityRegistry } from '../editions';
import { GuardedStore, type GuardOptions } from './stores/guard';
import type { SyncStoreContext } from './types';

/** True when sync may run: switched on by the user and allowed by the edition's policy. */
export function syncActive(reg: Pick<CapabilityRegistry, 'syncPolicy'>, settings: Settings): boolean {
  return settings.sync.enabled && reg.syncPolicy().allowed;
}

/**
 * Builds the store named by `sync.store`, wrapped in the single-writer guard. Throws
 * `NotAvailableInEdition` for an unknown id or a stub's first call.
 */
export function openSyncStore(
  reg: Pick<CapabilityRegistry, 'syncPolicy' | 'syncStore'>,
  settings: Settings,
  ctx: Omit<SyncStoreContext, 'settings'>,
  guard: GuardOptions,
): GuardedStore | null {
  if (!syncActive(reg, settings)) return null;
  return new GuardedStore(reg.syncStore(settings.sync.store, { ...ctx, settings }), guard);
}
