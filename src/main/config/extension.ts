import type { z } from 'zod';
import type { DeepPartial, DormantNamespace, Settings } from './schema';

/**
 * HOOK-CFG-01. Registered by the enterprise overlay via registry.registerSettingsExtension()
 * during bootstrap step 3 (12 §8.2). The public build registers none.
 */
export interface SettingsExtension {
  /** Overlay name, for logs. */
  id: string;
  /** Replace the loose record schema of a dormant namespace with a strict one. */
  schemas?: Partial<Record<DormantNamespace, z.ZodType>>;
  /** Organization defaults: user may override. Non-secret values only. */
  defaults?: DeepPartial<Settings>;
  /** Managed values: override user values and lock the key paths. */
  managed?: DeepPartial<Settings> | (() => Promise<DeepPartial<Settings>>);
  /** Additional Keychain accounts, each must start with "ext.". */
  keychainAccounts?: `ext.${string}`[];
  /** Enterprise-edition migrations for dormant namespaces. */
  migrate?(raw: Record<string, unknown>): Record<string, unknown>;
}
