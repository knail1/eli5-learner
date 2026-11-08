/** Shared body of the documented store stubs (16 §4.1). No network, no state. */
import { NotAvailableInEdition, edition } from '../../editions';
import type { RemoteChange, RemoteFile, SyncStore } from '../types';

export abstract class SyncStoreStub implements SyncStore {
  readonly stub = true;
  abstract readonly id: string;

  private fail(): Promise<never> {
    return Promise.reject(new NotAvailableInEdition(`sync-store:${this.id}`, 'HOOK-SYNC-01', edition));
  }
  list(): Promise<RemoteFile[]> {
    return this.fail();
  }
  startToken(): Promise<string> {
    return this.fail();
  }
  changes(): Promise<{ changes: RemoteChange[]; nextToken: string }> {
    return this.fail();
  }
  get(): Promise<Uint8Array> {
    return this.fail();
  }
  generateIds(): Promise<string[]> {
    return this.fail();
  }
  create(): Promise<RemoteFile> {
    return this.fail();
  }
  update(): Promise<RemoteFile> {
    return this.fail();
  }
  touch(): Promise<void> {
    return this.fail();
  }
  delete(): Promise<void> {
    return this.fail();
  }
}
