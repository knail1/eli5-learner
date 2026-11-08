import { SyncStoreStub } from './stub-base';

/**
 * `dropbox` (16 §4.1, documented stub). A Dropbox app folder would carry the same flat layout, with
 * file identity in the name and properties in a sidecar. Not in this version; every call throws
 * `NotAvailableInEdition` (HOOK-SYNC-01).
 */
export class DropboxStoreStub extends SyncStoreStub {
  readonly id = 'dropbox';
}
