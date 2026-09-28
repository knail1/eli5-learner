/** AuthBroker public stub (03 §12, HOOK-AUTH-01). No authentication of any kind in public. */
import { NotAvailableInEdition } from '../editions';
import { edition as buildEdition, type Edition } from '../editions';
import type { AuthBroker, AuthStatus } from './types';

export type { AuthBroker };

export class PublicAuthBroker implements AuthBroker {
  readonly stub = true;
  private readonly snapshot: AuthStatus;

  constructor(private readonly edition: Edition = buildEdition) {
    this.snapshot = { state: 'unavailable', updatedAt: new Date().toISOString() };
  }

  status(): AuthStatus {
    return { ...this.snapshot };
  }

  signIn(): Promise<AuthStatus> {
    throw new NotAvailableInEdition('auth', 'HOOK-AUTH-01', this.edition);
  }

  signOut(): Promise<AuthStatus> {
    throw new NotAvailableInEdition('auth', 'HOOK-AUTH-01', this.edition);
  }

  /** Never fires in public. */
  onChange(_listener: (s: AuthStatus) => void): () => void {
    return () => {};
  }
}
