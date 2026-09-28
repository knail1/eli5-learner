/** API keys live in the macOS Keychain, never in settings (12 §6). */

export type KeyAccount = 'llm.claude.apiKey' | 'llm.openai.apiKey' | `ext.${string}`;

export interface KeyStore {
  /** Main only; the value never crosses IPC. */
  get(account: KeyAccount): Promise<string | null>;
  set(account: KeyAccount, secret: string): Promise<void>;
  delete(account: KeyAccount): Promise<boolean>;
  has(account: KeyAccount): Promise<boolean>;
  available(): Promise<boolean>;
}

export const KEYCHAIN_SERVICE = 'ELI5 Learner';
export const account = (p: 'claude' | 'openai'): KeyAccount => `llm.${p}.apiKey`;

export class KeychainUnavailable extends Error {
  readonly code = 'E_KEYCHAIN_UNAVAILABLE' as const;
  constructor() {
    super('Keychain access denied. Unlock or allow access, then retry');
    this.name = 'KeychainUnavailable';
  }
}

interface KeyringEntry {
  getPassword(): string | null | undefined;
  setPassword(p: string): void;
  deletePassword(): boolean;
}
type EntryCtor = new (service: string, account: string) => KeyringEntry;

const HAS_CACHE_MS = 30_000;

/** Wraps @napi-rs/keyring. "Not found" maps to null/false; any other error to KeychainUnavailable. */
export class KeychainKeyStore implements KeyStore {
  private readonly hasCache = new Map<KeyAccount, { value: boolean; at: number }>();

  constructor(
    private readonly loadEntry: () => Promise<EntryCtor>,
    private readonly now: () => number = Date.now,
  ) {}

  private async entry(acct: KeyAccount): Promise<KeyringEntry> {
    try {
      const Entry = await this.loadEntry();
      return new Entry(KEYCHAIN_SERVICE, acct);
    } catch {
      throw new KeychainUnavailable();
    }
  }

  async get(acct: KeyAccount): Promise<string | null> {
    const e = await this.entry(acct);
    try {
      return e.getPassword() ?? null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw new KeychainUnavailable();
    }
  }

  async set(acct: KeyAccount, secret: string): Promise<void> {
    const e = await this.entry(acct);
    try {
      e.setPassword(secret);
    } catch {
      throw new KeychainUnavailable();
    }
    this.hasCache.delete(acct);
  }

  async delete(acct: KeyAccount): Promise<boolean> {
    const e = await this.entry(acct);
    this.hasCache.delete(acct);
    try {
      return e.deletePassword();
    } catch (err) {
      if (isNotFound(err)) return false;
      throw new KeychainUnavailable();
    }
  }

  async has(acct: KeyAccount): Promise<boolean> {
    const hit = this.hasCache.get(acct);
    if (hit && this.now() - hit.at < HAS_CACHE_MS) return hit.value;
    let value: boolean;
    try {
      value = (await this.get(acct)) !== null;
    } catch {
      value = false;
    }
    this.hasCache.set(acct, { value, at: this.now() });
    return value;
  }

  async available(): Promise<boolean> {
    try {
      await this.loadEntry();
      return true;
    } catch {
      return false;
    }
  }
}

function isNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no (matching )?entry|not found|could not be found/i.test(msg);
}

/** Tests and e2e (ELI5_KEYSTORE=memory, unpackaged builds only). */
export class MemoryKeyStore implements KeyStore {
  private readonly items = new Map<KeyAccount, string>();

  constructor(seed?: Partial<Record<KeyAccount, string>>) {
    for (const [k, v] of Object.entries(seed ?? {})) if (v) this.items.set(k as KeyAccount, v);
  }
  async get(acct: KeyAccount): Promise<string | null> {
    return this.items.get(acct) ?? null;
  }
  async set(acct: KeyAccount, secret: string): Promise<void> {
    this.items.set(acct, secret);
  }
  async delete(acct: KeyAccount): Promise<boolean> {
    return this.items.delete(acct);
  }
  async has(acct: KeyAccount): Promise<boolean> {
    return this.items.has(acct);
  }
  async available(): Promise<boolean> {
    return true;
  }
}

/** Picks the key store for this process (12 §6.2). */
export function createKeyStore(opts: { isPackaged: boolean; env: NodeJS.ProcessEnv }): KeyStore {
  if (!opts.isPackaged && opts.env.ELI5_KEYSTORE === 'memory') {
    return new MemoryKeyStore({
      'llm.claude.apiKey': opts.env.ELI5_TEST_API_KEY_CLAUDE,
      'llm.openai.apiKey': opts.env.ELI5_TEST_API_KEY_OPENAI,
    });
  }
  return new KeychainKeyStore(async () => (await import('@napi-rs/keyring')).Entry as unknown as EntryCtor);
}
