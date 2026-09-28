/**
 * Fixture sign-on capability (HOOK-AUTH-01 mechanism only). Holds no credentials: the state machine
 * of 03 §12 with a display name, nothing else.
 */
import type { AuthBroker, AuthState, AuthStatus } from '@eli5/public/sources';

export interface FixtureAuthOptions {
  /** Default 'signed-in' so cell F jobs can use the MCP lane without a sign-in step. */
  initial?: Extract<AuthState, 'signed-in' | 'signed-out'>;
  now?: () => Date;
}

export class FixtureAuthBroker implements AuthBroker {
  /** Number of user-initiated sign-ins; status() must never add to it (13 §10.2). */
  interactions = 0;
  private current: AuthStatus;
  private readonly listeners = new Set<(s: AuthStatus) => void>();
  private readonly now: () => Date;

  constructor(opts: FixtureAuthOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.current = this.make(opts.initial ?? 'signed-in');
  }

  status(): AuthStatus {
    return { ...this.current };
  }

  async signIn(): Promise<AuthStatus> {
    this.interactions++;
    this.set('signing-in');
    return this.set('signed-in');
  }

  async signOut(): Promise<AuthStatus> {
    return this.set('signed-out');
  }

  /** The MCP lane reports an expired session (03 §12 rule 3). */
  expire(): void {
    this.set('expired');
  }

  onChange(listener: (s: AuthStatus) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private make(state: AuthState): AuthStatus {
    const base = { state, updatedAt: this.now().toISOString() };
    return state === 'signed-in' || state === 'expired' ? { ...base, account: 'Fixture User' } : base;
  }

  private set(state: AuthState): AuthStatus {
    this.current = this.make(state);
    for (const l of this.listeners) l(this.status());
    return this.status();
  }
}
