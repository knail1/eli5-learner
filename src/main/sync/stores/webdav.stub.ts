import { SyncStoreStub } from './stub-base';

/**
 * `webdav` (16 §4.1, documented stub). A WebDAV collection would carry the same flat layout, with
 * dead properties for identity and ETag-free single-writer rules. Not in this version; every call
 * throws `NotAvailableInEdition` (HOOK-SYNC-01).
 */
export class WebDavStoreStub extends SyncStoreStub {
  readonly id = 'webdav';
}
