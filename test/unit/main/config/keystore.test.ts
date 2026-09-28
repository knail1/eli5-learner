import { describe, expect, it } from 'vitest';
import {
  KeychainKeyStore,
  KeychainUnavailable,
  MemoryKeyStore,
  account,
  createKeyStore,
} from '../../../../src/main/config';

class FakeEntry {
  static store = new Map<string, string>();
  static getCalls = 0;
  static failWith: Error | undefined;
  constructor(
    private readonly service: string,
    private readonly user: string,
  ) {}
  private get k() {
    return `${this.service}/${this.user}`;
  }
  getPassword() {
    FakeEntry.getCalls++;
    if (FakeEntry.failWith) throw FakeEntry.failWith;
    return FakeEntry.store.get(this.k) ?? null;
  }
  setPassword(p: string) {
    if (FakeEntry.failWith) throw FakeEntry.failWith;
    FakeEntry.store.set(this.k, p);
  }
  deletePassword() {
    return FakeEntry.store.delete(this.k);
  }
}

describe('KeychainKeyStore (12 §6.2)', () => {
  const make = (now = () => 0) => new KeychainKeyStore(async () => FakeEntry, now);

  it('stores under service "ELI5 Learner" and the provider account', async () => {
    FakeEntry.store.clear();
    const ks = make();
    await ks.set(account('claude'), 'sk-test-1');
    expect(FakeEntry.store.get('ELI5 Learner/llm.claude.apiKey')).toBe('sk-test-1');
    expect(await ks.get(account('claude'))).toBe('sk-test-1');
    expect(await ks.delete(account('claude'))).toBe(true);
    expect(await ks.get(account('claude'))).toBeNull();
  });

  it('caches has() for 30 s and invalidates on set', async () => {
    FakeEntry.store.clear();
    let t = 0;
    const ks = make(() => t);
    expect(await ks.has(account('openai'))).toBe(false);
    const calls = FakeEntry.getCalls;
    t = 10_000;
    expect(await ks.has(account('openai'))).toBe(false);
    expect(FakeEntry.getCalls).toBe(calls);
    await ks.set(account('openai'), 'sk-test-2');
    expect(await ks.has(account('openai'))).toBe(true);
  });

  it('maps "not found" to null and other errors to KeychainUnavailable', async () => {
    const ks = make();
    FakeEntry.failWith = new Error('No matching entry found in secure storage');
    expect(await ks.get(account('claude'))).toBeNull();
    FakeEntry.failWith = new Error('User interaction is not allowed');
    await expect(ks.get(account('claude'))).rejects.toBeInstanceOf(KeychainUnavailable);
    FakeEntry.failWith = undefined;
  });

  it('reports unavailable when the native module cannot load', async () => {
    const ks = new KeychainKeyStore(async () => {
      throw new Error('dlopen failed');
    });
    expect(await ks.available()).toBe(false);
    await expect(ks.set(account('claude'), 'x')).rejects.toBeInstanceOf(KeychainUnavailable);
  });
});

describe('createKeyStore', () => {
  it('uses MemoryKeyStore seeded from env only in unpackaged builds', async () => {
    const env = { ELI5_KEYSTORE: 'memory', ELI5_TEST_API_KEY_CLAUDE: 'sk-test-seed' };
    const dev = createKeyStore({ isPackaged: false, env });
    expect(dev).toBeInstanceOf(MemoryKeyStore);
    expect(await dev.get(account('claude'))).toBe('sk-test-seed');
    expect(createKeyStore({ isPackaged: true, env })).toBeInstanceOf(KeychainKeyStore);
  });
});
