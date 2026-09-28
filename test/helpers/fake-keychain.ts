import { MemoryKeyStore, type KeyAccount } from '../../src/main/config';

/** Unit-test wrapper around 12's MemoryKeyStore; fake keys match sk-test-… (12 §12). */
export function fakeKeychain(seed: Partial<Record<KeyAccount, string>> = {}): MemoryKeyStore {
  for (const v of Object.values(seed)) {
    if (v && !v.startsWith('sk-test-')) throw new Error('Test keys must start with sk-test-');
  }
  return new MemoryKeyStore(seed);
}
